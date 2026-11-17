import type { Sql } from 'postgres';
import { checkLevelShape } from '../src/game/levelSchema';
import { Level } from '../src/game/level';
import { SIM_CONFIG, solutionKey, verifySolution } from '../src/game/verify';
import { GENERATOR_VERSION } from '../src/gen/generator';
import { isDateKey, shiftDate, utcDateKey } from '../src/modes/daily';
import { ModelClient } from './ai';
import { Authenticator, AuthUser, DevAuthenticator, sha256Hex } from './auth';
import { publishDaily } from './publish';

/**
 * The whole backend as one function from Request to Response. It has no dependency on a
 * particular runtime: the Supabase Edge Function and the local Node dev server both call it.
 */
export interface ApiContext {
  sql: Sql;
  auth: Authenticator;
  /** AI designer client; null when no API key is configured. */
  model: ModelClient | null;
  /** Shared secret for the publish endpoint. Publishing is disabled when null. */
  cronSecret: string | null;
  /** Present only on the local dev server. */
  devAuth?: DevAuthenticator;
  allowedOrigin?: string;
  now?: () => Date;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) { super(message); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[\p{L}\p{N} _.\-]{2,20}$/u;
const LIMITS = { score: { max: 20, windowSec: 60 }, replay: { max: 10, windowSec: 60 }, profile: { max: 20, windowSec: 60 }, friend: { max: 20, windowSec: 60 } };

export function createApi(ctx: ApiContext): (req: Request) => Promise<Response> {
  const { sql } = ctx;
  const now = () => (ctx.now ? ctx.now() : new Date());
  const today = () => utcDateKey(now());
  const cors: Record<string, string> = {
    'access-control-allow-origin': ctx.allowedOrigin ?? '*',
    'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info, x-cron-secret',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-max-age': '86400',
  };
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors, ...extra } });

  async function userOf(req: Request): Promise<AuthUser | null> {
    const h = req.headers.get('authorization') ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!token || token.length > 4096) return null;
    try { return await ctx.auth.verify(token); } catch { return null; }
  }
  async function requireUser(req: Request): Promise<AuthUser> {
    const u = await userOf(req);
    if (!u) throw new HttpError(401, 'Sign in to do this.');
    return u;
  }
  async function readJson(req: Request, maxBytes: number): Promise<Record<string, any>> {
    const text = await req.text();
    if (text.length > maxBytes) throw new HttpError(413, 'Request body too large.');
    try {
      const v = JSON.parse(text || '{}');
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      return v;
    } catch { throw new HttpError(400, 'Body must be a JSON object.'); }
  }
  async function rateLimit(userId: string, kind: keyof typeof LIMITS): Promise<void> {
    const { max, windowSec } = LIMITS[kind];
    const [{ n }] = await sql`select count(*)::int as n from rate_events where user_id = ${userId} and kind = ${kind} and at > now() - make_interval(secs => ${windowSec})`;
    if (n >= max) throw new HttpError(429, 'Too many requests. Wait a moment and try again.');
    await sql`insert into rate_events (user_id, kind) values (${userId}, ${kind})`;
    if (Math.random() < 0.02) await sql`delete from rate_events where at < now() - interval '1 day'`;
  }

  /** Make sure the per-user rows exist, and return the profile. */
  async function ensureProfile(u: AuthUser) {
    const found = await sql`select id, display_name, friend_code, skin, created_at from profiles where id = ${u.id}`;
    if (found.length) return found[0];
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('');
      const name = `Pilot-${code.slice(0, 4)}`;
      const made = await sql`
        insert into profiles (id, display_name, friend_code) values (${u.id}, ${name}, ${code})
        on conflict do nothing returning id, display_name, friend_code, skin, created_at`;
      if (made.length) {
        await sql`insert into unlimited_records (user_id) values (${u.id}) on conflict do nothing`;
        await sql`insert into player_stats (user_id) values (${u.id}) on conflict do nothing`;
        await sql`insert into progression (user_id) values (${u.id}) on conflict do nothing`;
        return made[0];
      }
      const again = await sql`select id, display_name, friend_code, skin, created_at from profiles where id = ${u.id}`;
      if (again.length) return again[0];
    }
    throw new HttpError(500, 'Could not create a profile.');
  }

  async function progressOf(userId: string) {
    const [u] = await sql`select highest_level, best_run_score::float8 as best_run_score, longest_run, runs_started, current_run from unlimited_records where user_id = ${userId}`;
    const [s] = await sql`select simulations, successes, failures, devices_placed, sim_seconds, best_score, levels_cleared, by_template, dailies_completed, daily_streak, best_streak, last_completed::text as last_completed from player_stats where user_id = ${userId}`;
    const [p] = await sql`select unlocks, cosmetics, tutorial_done from progression where user_id = ${userId}`;
    const results = await sql`
      select e.date::text as date, c.number, c.title, c.difficulty, e.best_score, e.best_time, e.best_energy, e.first_score, e.attempts, r.devices_used, e.score_at
      from leaderboard_entries e join daily_challenges c on c.date = e.date left join replays r on r.id = e.score_replay
      where e.user_id = ${userId} order by e.date desc limit 120`;
    return {
      unlimited: { highestLevel: u.highest_level, bestRunScore: u.best_run_score, longestRun: u.longest_run, runsStarted: u.runs_started, run: u.current_run },
      stats: {
        simulations: s.simulations, successes: s.successes, failures: s.failures, devicesPlaced: s.devices_placed, simSeconds: s.sim_seconds,
        bestScore: s.best_score, levelsCleared: s.levels_cleared, byTemplate: s.by_template,
      },
      daily: { completed: s.dailies_completed, streak: s.daily_streak, bestStreak: s.best_streak, lastCompleted: s.last_completed,
        results: results.map((r) => ({ date: r.date, number: r.number, title: r.title, difficulty: r.difficulty, bestScore: r.best_score, bestTime: r.best_time,
          bestEnergy: r.best_energy, bestDevices: r.devices_used ?? 0, firstScore: r.first_score, completions: r.attempts, completedAt: new Date(r.score_at).toISOString() })) },
      unlocks: p.unlocks as string[], cosmetics: p.cosmetics as string[], tutorialDone: p.tutorial_done,
    };
  }
  const publicProfile = (p: any) => ({ id: p.id, name: p.display_name, skin: p.skin, joined: new Date(p.created_at).toISOString() });

  async function getChallenge(date: string) {
    const rows = await sql`select date::text as date, number, title, difficulty, seed::float8 as seed, spec, level, source, generator_version from daily_challenges where date = ${date}::date`;
    return rows.length ? rows[0] : null;
  }

  // ---- routes ---------------------------------------------------------------------------
  async function route(req: Request, path: string, q: URLSearchParams): Promise<Response> {
    const m = req.method;

    if (m === 'GET' && path === '/health') {
      await sql`select 1`;
      return json({ ok: true, today: today(), ai: !!ctx.model, generator: GENERATOR_VERSION, dev: !!ctx.devAuth });
    }

    if (m === 'GET' && path === '/daily') {
      const date = q.get('date') ?? today();
      if (!isDateKey(date)) throw new HttpError(400, 'Invalid date.');
      if (date > today()) throw new HttpError(404, 'That challenge is not published yet.');
      let ch = await getChallenge(date);
      if (!ch && date === today()) {
        // Nobody published today (cron not set up, or it failed). Publish the procedural
        // challenge now rather than making players wait on a model call.
        await publishDaily(sql, date, { model: null });
        ch = await getChallenge(date);
      }
      if (!ch) throw new HttpError(404, 'No challenge was published for that date.');
      return json({ today: today(), challenge: { date: ch.date, number: ch.number, title: ch.title, difficulty: ch.difficulty, seed: ch.seed, spec: ch.spec, level: ch.level, source: ch.source } });
    }

    if (m === 'POST' && path === '/cron/publish') {
      const given = req.headers.get('x-cron-secret') ?? '';
      if (!ctx.cronSecret || given.length !== ctx.cronSecret.length || (await sha256Hex(given)) !== (await sha256Hex(ctx.cronSecret))) throw new HttpError(403, 'Forbidden.');
      const body = await readJson(req, 2000);
      const start = body.date ?? today();
      if (!isDateKey(start)) throw new HttpError(400, 'Invalid date.');
      if (start < shiftDate(today(), -1) || start > shiftDate(today(), 14)) throw new HttpError(400, 'Date out of range.');
      const days = Math.max(1, Math.min(7, Number.isInteger(body.days) ? body.days : 2));
      const results = [];
      // Sequential: each day must see the previous one in its similarity history.
      for (let i = 0; i < days; i++) {
        const r = await publishDaily(sql, shiftDate(start, i), { model: body.useAI === false ? null : ctx.model });
        results.push({ date: r.date, created: r.created, source: r.source, title: r.title, log: r.log });
      }
      return json({ results });
    }

    if (m === 'POST' && path === '/dev/login') {
      if (!ctx.devAuth) throw new HttpError(404, 'Not found.');
      const body = await readJson(req, 500);
      const name = typeof body.name === 'string' && NAME.test(body.name.trim()) ? body.name.trim() : null;
      const email = `${(name ?? 'dev').toLowerCase().replace(/[^a-z0-9]/g, '')}-${Math.random().toString(36).slice(2, 8)}@dev.local`;
      const [u] = body.userId && UUID.test(body.userId)
        ? await sql`select id from auth.users where id = ${body.userId}`
        : await sql`insert into auth.users (email) values (${email}) returning id`;
      if (!u) throw new HttpError(404, 'Unknown dev user.');
      await ensureProfile({ id: u.id });
      if (name) await sql`update profiles set display_name = ${name} where id = ${u.id}`;
      return json({ token: await ctx.devAuth.issue(u.id), userId: u.id });
    }

    if (path === '/me') {
      const u = await requireUser(req);
      const p = await ensureProfile(u);
      if (m === 'GET') return json({ profile: { ...publicProfile(p), friendCode: p.friend_code }, progress: await progressOf(u.id) });
      if (m === 'POST') {
        await rateLimit(u.id, 'profile');
        const body = await readJson(req, 2000);
        if (body.displayName !== undefined) {
          const name = typeof body.displayName === 'string' ? body.displayName.trim().replace(/\s+/g, ' ') : '';
          if (!NAME.test(name)) throw new HttpError(400, 'Names are 2 to 20 letters, digits, spaces, dots, dashes or underscores.');
          await sql`update profiles set display_name = ${name} where id = ${u.id}`;
        }
        if (body.skin !== undefined) {
          if (typeof body.skin !== 'string' || !/^[a-z]{2,20}$/.test(body.skin)) throw new HttpError(400, 'Invalid skin.');
          await sql`update profiles set skin = ${body.skin} where id = ${u.id}`;
        }
        const [fresh] = await sql`select id, display_name, friend_code, skin, created_at from profiles where id = ${u.id}`;
        return json({ profile: { ...publicProfile(fresh), friendCode: fresh.friend_code } });
      }
    }

    if (m === 'POST' && path === '/sync') {
      const u = await requireUser(req);
      await ensureProfile(u);
      await rateLimit(u.id, 'profile');
      const body = await readJson(req, 24_000);
      const int = (v: unknown, cap: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(cap, Math.floor(v))) : 0);
      const un = body.unlimited ?? {};
      const st = body.stats ?? {};
      // Personal progress merges by "furthest wins" so two devices never erase each other.
      const run = sanitizeRun(un.run);
      const [cur] = await sql`select current_run from unlimited_records where user_id = ${u.id}`;
      const serverRun = cur?.current_run as { stamp?: number } | null;
      const keepRun = un.run === null && body.runCleared === true ? null : run && (!serverRun || (run.stamp ?? 0) >= (serverRun.stamp ?? 0)) ? run : serverRun;
      await sql`
        update unlimited_records set
          highest_level = greatest(highest_level, ${int(un.highestLevel, 100000)}),
          best_run_score = greatest(best_run_score, ${int(un.bestRunScore, 1e12)}),
          longest_run = greatest(longest_run, ${int(un.longestRun, 100000)}),
          runs_started = greatest(runs_started, ${int(un.runsStarted, 1e7)}),
          current_run = ${keepRun ? sql.json(keepRun as any) : null},
          updated_at = now()
        where user_id = ${u.id}`;
      const byTemplate: Record<string, number> = {};
      if (st.byTemplate && typeof st.byTemplate === 'object') {
        for (const [k, v] of Object.entries(st.byTemplate).slice(0, 40)) if (/^[a-z]{2,20}$/.test(k)) byTemplate[k] = int(v, 1e7);
      }
      const [curStats] = await sql`select by_template from player_stats where user_id = ${u.id}`;
      const merged: Record<string, number> = { ...(curStats?.by_template as Record<string, number> ?? {}) };
      for (const [k, v] of Object.entries(byTemplate)) merged[k] = Math.max(merged[k] ?? 0, v);
      await sql`
        update player_stats set
          simulations = greatest(simulations, ${int(st.simulations, 1e8)}),
          successes = greatest(successes, ${int(st.successes, 1e8)}),
          failures = greatest(failures, ${int(st.failures, 1e8)}),
          devices_placed = greatest(devices_placed, ${int(st.devicesPlaced, 1e8)}),
          sim_seconds = greatest(sim_seconds, ${int(st.simSeconds, 1e9)}),
          best_score = greatest(best_score, ${int(st.bestScore, 100000)}),
          levels_cleared = greatest(levels_cleared, ${int(st.levelsCleared, 1e7)}),
          by_template = ${sql.json(merged)},
          updated_at = now()
        where user_id = ${u.id}`;
      const ids = (v: unknown) => (Array.isArray(v) ? Array.from(new Set(v.filter((x) => typeof x === 'string' && /^[a-z]+:[A-Za-z]+$/.test(x)))).slice(0, 200) : []);
      await sql`
        update progression set
          unlocks = (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from jsonb_array_elements(unlocks || ${sql.json(ids(body.unlocks))}::jsonb) x),
          cosmetics = (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from jsonb_array_elements(cosmetics || ${sql.json(ids(body.cosmetics))}::jsonb) x),
          tutorial_done = tutorial_done or ${body.tutorialDone === true},
          updated_at = now()
        where user_id = ${u.id}`;
      return json({ progress: await progressOf(u.id) });
    }

    if (m === 'POST' && path === '/scores') {
      const u = await requireUser(req);
      await ensureProfile(u);
      await rateLimit(u.id, 'score');
      const body = await readJson(req, 8000);
      const date = body.date;
      if (!isDateKey(date)) throw new HttpError(400, 'Invalid date.');
      if (date > today()) throw new HttpError(400, 'That challenge is not published yet.');
      const ch = await getChallenge(date);
      if (!ch) throw new HttpError(404, 'No published challenge for that date.');
      // The client's own score, time and energy are ignored. Only the devices are read, and
      // the published level is re-simulated here at the fixed timestep.
      const verified = verifySolution(ch.level as Level, body.devices);
      if (!verified.ok) throw new HttpError(422, 'Solution rejected.', verified.errors);
      const run = verified.run;
      const hash = await sha256Hex(solutionKey(run.devices));
      const score = run.score.total;

      const result = await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`vl-score-${date}-${u.id}`}))`;
        const dup = await tx`select replay_id from daily_scores where date = ${date}::date and user_id = ${u.id} and solution_hash = ${hash}`;
        const [prev] = await tx`select best_score, best_time, best_energy from leaderboard_entries where date = ${date}::date and user_id = ${u.id}`;
        if (dup.length) return { duplicate: true, replayId: dup[0].replay_id as string | null, improved: false, first: false, previousBest: prev?.best_score ?? 0 };
        const [rep] = await tx`
          insert into replays (user_id, kind, date, devices, sim, score, time, energy, devices_used, steps)
          values (${u.id}, 'daily', ${date}::date, ${tx.json(run.devices as any)}, ${tx.json({ ...SIM_CONFIG, generator: ch.generator_version } as any)}, ${score}, ${run.time}, ${run.energy}, ${run.devicesUsed}, ${run.steps})
          returning id`;
        await tx`insert into daily_scores (date, user_id, solution_hash, score, time, energy, devices_used, replay_id) values (${date}::date, ${u.id}, ${hash}, ${score}, ${run.time}, ${run.energy}, ${run.devicesUsed}, ${rep.id})`;
        if (!prev) {
          await tx`
            insert into leaderboard_entries (date, user_id, best_score, score_replay, best_time, time_replay, best_energy, energy_replay, first_score)
            values (${date}::date, ${u.id}, ${score}, ${rep.id}, ${run.time}, ${rep.id}, ${run.energy}, ${rep.id}, ${score})`;
          // Streaks only move on the live day, and are computed here, not sent by the client.
          if (date === today()) {
            await tx`
              update player_stats set
                dailies_completed = dailies_completed + 1,
                daily_streak = case when last_completed = ${shiftDate(date, -1)}::date then daily_streak + 1 else 1 end,
                best_streak = greatest(best_streak, case when last_completed = ${shiftDate(date, -1)}::date then daily_streak + 1 else 1 end),
                last_completed = ${date}::date, updated_at = now()
              where user_id = ${u.id} and (last_completed is null or last_completed < ${date}::date)`;
          } else {
            await tx`update player_stats set dailies_completed = dailies_completed + 1, updated_at = now() where user_id = ${u.id}`;
          }
        } else {
          await tx`
            update leaderboard_entries set
              attempts = attempts + 1,
              score_replay = case when ${score} > best_score then ${rep.id}::uuid else score_replay end,
              score_at = case when ${score} > best_score then now() else score_at end,
              best_score = greatest(best_score, ${score}),
              time_replay = case when ${run.time} < best_time then ${rep.id}::uuid else time_replay end,
              time_at = case when ${run.time} < best_time then now() else time_at end,
              best_time = least(best_time, ${run.time}),
              energy_replay = case when ${run.energy} < best_energy then ${rep.id}::uuid else energy_replay end,
              energy_at = case when ${run.energy} < best_energy then now() else energy_at end,
              best_energy = least(best_energy, ${run.energy})
            where date = ${date}::date and user_id = ${u.id}`;
        }
        await tx`update player_stats set best_score = greatest(best_score, ${score}) where user_id = ${u.id}`;
        return { duplicate: false, replayId: rep.id as string, improved: !prev || score > prev.best_score, first: !prev, previousBest: prev?.best_score ?? 0 };
      });

      const [mine] = await sql`select best_score, best_time, best_energy, score_at from leaderboard_entries where date = ${date}::date and user_id = ${u.id}`;
      const [{ rank }] = await sql`
        select count(*)::int + 1 as rank from leaderboard_entries
        where date = ${date}::date and (best_score > ${mine.best_score} or (best_score = ${mine.best_score} and score_at < ${mine.score_at}))`;
      const [{ total }] = await sql`select count(*)::int as total from leaderboard_entries where date = ${date}::date`;
      return json({
        verified: true, date, score: run.score, time: run.time, energy: run.energy, devices: run.devicesUsed, ...result,
        best: { score: mine.best_score, time: mine.best_time, energy: mine.best_energy }, rank, players: total,
      });
    }

    if (m === 'GET' && path === '/leaderboard') {
      const scope = q.get('scope') ?? 'daily';
      const metric = q.get('metric') ?? 'score';
      const date = q.get('date') ?? today();
      if (!['daily', 'friends', 'weekly', 'alltime'].includes(scope) || !['score', 'time', 'energy'].includes(metric)) throw new HttpError(400, 'Invalid board.');
      if (!isDateKey(date) || date > today()) throw new HttpError(400, 'Invalid date.');
      const u = await userOf(req);
      const me = u?.id ?? null;
      if (scope === 'friends' && !me) throw new HttpError(401, 'Sign in to see friends rankings.');
      let rows;
      if (scope === 'daily' || scope === 'friends') {
        const friendsOnly = scope === 'friends';
        const col = metric === 'time' ? sql`e.time_replay` : metric === 'energy' ? sql`e.energy_replay` : sql`e.score_replay`;
        const order = metric === 'time' ? sql`e.best_time asc, e.time_at asc` : metric === 'energy' ? sql`e.best_energy asc, e.energy_at asc` : sql`e.best_score desc, e.score_at asc`;
        rows = await sql`
          with ranked as (
            select e.user_id, p.display_name, p.skin, r.id as replay_id, r.score, r.time, r.energy, r.devices_used,
                   row_number() over (order by ${order}) as rank, count(*) over () as total
            from leaderboard_entries e join profiles p on p.id = e.user_id join replays r on r.id = ${col}
            where e.date = ${date}::date
              and (${!friendsOnly} or e.user_id = ${me} or e.user_id in (select friend_id from friends where user_id = ${me})))
          select * from ranked where rank <= 100 or user_id = ${me} order by rank`;
      } else {
        const from = scope === 'weekly' ? shiftDate(date, -6) : '2000-01-01';
        rows = await sql`
          with totals as (
            select e.user_id, sum(e.best_score)::int as score, count(*)::int as days, max(e.score_at) as last_at
            from leaderboard_entries e where e.date between ${from}::date and ${date}::date group by e.user_id),
          ranked as (
            select t.*, p.display_name, p.skin, row_number() over (order by t.score desc, t.last_at asc) as rank, count(*) over () as total
            from totals t join profiles p on p.id = t.user_id)
          select * from ranked where rank <= 100 or user_id = ${me} order by rank`;
      }
      return json({
        scope, metric, date, live: true, players: rows.length ? Number(rows[0].total) : 0,
        entries: rows.map((r) => ({
          rank: Number(r.rank), userId: r.user_id, player: r.display_name, skin: r.skin, score: r.score,
          time: r.time ?? null, energy: r.energy ?? null, devices: r.devices_used ?? null, days: r.days ?? null,
          replayId: r.replay_id ?? null, isPlayer: r.user_id === me,
        })),
      });
    }

    if (m === 'GET' && path === '/replay') {
      const id = q.get('id') ?? '';
      if (!UUID.test(id)) throw new HttpError(400, 'Invalid replay id.');
      const [r] = await sql`
        select r.id, r.user_id, r.kind, r.date::text as date, r.level, r.label, r.devices, r.sim, r.score, r.time, r.energy, r.devices_used, r.created_at, p.display_name
        from replays r join profiles p on p.id = r.user_id where r.id = ${id}`;
      if (!r) throw new HttpError(404, 'Replay not found.');
      let level = r.level as Level | null;
      let number: number | null = null;
      let title = r.label as string | null;
      if (r.kind === 'daily') {
        if (r.date > today()) throw new HttpError(404, 'Replay not found.');
        if (r.date === today()) {
          // No spoilers: today's solutions are only shown to players who already solved today.
          const u = await userOf(req);
          const cleared = u ? await sql`select 1 from leaderboard_entries where date = ${r.date}::date and user_id = ${u.id}` : [];
          if (!cleared.length) return json({ error: "Solve today's challenge first, then you can watch other players' solutions.", locked: true, date: r.date }, 403);
        }
        const ch = await getChallenge(r.date);
        if (!ch) throw new HttpError(404, 'Replay not found.');
        level = ch.level as Level;
        number = ch.number;
        title = ch.title;
      }
      return json({ replay: { id: r.id, kind: r.kind, date: r.date, number, title, player: r.display_name, userId: r.user_id, level, devices: r.devices, sim: r.sim,
        score: r.score, time: r.time, energy: r.energy, devicesUsed: r.devices_used, createdAt: new Date(r.created_at).toISOString() } });
    }

    if (path === '/replays') {
      const u = await requireUser(req);
      await ensureProfile(u);
      if (m === 'GET') {
        const rows = await sql`
          select r.id, r.kind, r.date::text as date, coalesce(c.title, r.label) as title, c.number, r.score, r.time, r.energy, r.devices_used, r.created_at
          from replays r left join daily_challenges c on c.date = r.date where r.user_id = ${u.id} order by r.created_at desc limit 40`;
        return json({ replays: rows.map((r) => ({ id: r.id, kind: r.kind, date: r.date, title: r.title, number: r.number, score: r.score, time: r.time, energy: r.energy, devicesUsed: r.devices_used, createdAt: new Date(r.created_at).toISOString() })) });
      }
      if (m === 'POST') {
        // Share an unlimited-mode solution. The level comes from the client, so this replay
        // is for watching only and never feeds a leaderboard.
        await rateLimit(u.id, 'replay');
        const body = await readJson(req, 80_000);
        const shape = checkLevelShape(body.level);
        if (!shape.ok) throw new HttpError(422, 'Level rejected.', shape.errors);
        const verified = verifySolution(shape.level, body.devices);
        if (!verified.ok) throw new HttpError(422, 'Solution rejected.', verified.errors);
        const label = typeof body.label === 'string' ? body.label.replace(/[^\p{L}\p{N} .,'#\-]/gu, '').slice(0, 60) : shape.level.title;
        const run = verified.run;
        const [rep] = await sql`
          insert into replays (user_id, kind, level, label, devices, sim, score, time, energy, devices_used, steps)
          values (${u.id}, 'unlimited', ${sql.json(shape.level as any)}, ${label}, ${sql.json(run.devices as any)}, ${sql.json({ ...SIM_CONFIG, generator: GENERATOR_VERSION } as any)}, ${run.score.total}, ${run.time}, ${run.energy}, ${run.devicesUsed}, ${run.steps})
          returning id`;
        await sql`delete from replays where user_id = ${u.id} and kind = 'unlimited' and id not in (select id from replays where user_id = ${u.id} and kind = 'unlimited' order by created_at desc limit 50)`;
        return json({ replayId: rep.id, score: run.score.total, time: run.time, energy: run.energy });
      }
    }

    if (path === '/friends') {
      const u = await requireUser(req);
      await ensureProfile(u);
      if (m === 'POST') {
        await rateLimit(u.id, 'friend');
        const body = await readJson(req, 500);
        const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
        if (!/^[A-Z0-9]{8}$/.test(code)) throw new HttpError(400, 'Friend codes are 8 letters and digits.');
        const [f] = await sql`select id from profiles where friend_code = ${code}`;
        if (!f) throw new HttpError(404, 'No player has that friend code.');
        if (f.id === u.id) throw new HttpError(400, 'That is your own code.');
        const [{ n }] = await sql`select count(*)::int as n from friends where user_id = ${u.id}`;
        if (n >= 200) throw new HttpError(400, 'Friend list is full.');
        await sql`insert into friends (user_id, friend_id) values (${u.id}, ${f.id}) on conflict do nothing`;
      } else if (m === 'DELETE') {
        const id = q.get('id') ?? '';
        if (!UUID.test(id)) throw new HttpError(400, 'Invalid id.');
        await sql`delete from friends where user_id = ${u.id} and friend_id = ${id}`;
      } else if (m !== 'GET') throw new HttpError(405, 'Method not allowed.');
      const rows = await sql`select p.id, p.display_name, p.skin, p.created_at from friends f join profiles p on p.id = f.friend_id where f.user_id = ${u.id} order by p.display_name`;
      return json({ friends: rows.map(publicProfile) });
    }

    if (m === 'GET' && path === '/profile') {
      const id = q.get('id') ?? '';
      if (!UUID.test(id)) throw new HttpError(400, 'Invalid id.');
      const [p] = await sql`select id, display_name, friend_code, skin, created_at from profiles where id = ${id}`;
      if (!p) throw new HttpError(404, 'Player not found.');
      const [s] = await sql`select best_score, dailies_completed, daily_streak, best_streak, last_completed::text as last_completed from player_stats where user_id = ${id}`;
      const [un] = await sql`select highest_level, best_run_score::float8 as best_run_score, longest_run from unlimited_records where user_id = ${id}`;
      const recent = await sql`
        select e.date::text as date, c.number, c.title, e.best_score, e.best_time,
               (select count(*)::int + 1 from leaderboard_entries o where o.date = e.date and (o.best_score > e.best_score or (o.best_score = e.best_score and o.score_at < e.score_at))) as rank
        from leaderboard_entries e join daily_challenges c on c.date = e.date where e.user_id = ${id} and e.date < ${today()}::date
        order by e.date desc limit 10`;
      const live = s?.last_completed && s.last_completed >= shiftDate(today(), -1);
      return json({
        profile: publicProfile(p),
        stats: { bestScore: s?.best_score ?? 0, dailiesCompleted: s?.dailies_completed ?? 0, streak: live ? s.daily_streak : 0, bestStreak: s?.best_streak ?? 0,
          highestLevel: un?.highest_level ?? 0, bestRunScore: un?.best_run_score ?? 0, longestRun: un?.longest_run ?? 0 },
        recent: recent.map((r) => ({ date: r.date, number: r.number, title: r.title, score: r.best_score, time: r.best_time, rank: r.rank })),
      });
    }

    throw new HttpError(404, 'Not found.');
  }

  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(req.url);
      // Supabase serves the function at /functions/v1/api/...; locally it is at /...
      const i = url.pathname.indexOf('/api/');
      let path = i >= 0 ? url.pathname.slice(i + 4) : url.pathname.endsWith('/api') ? '/' : url.pathname;
      if (path.length > 1) path = path.replace(/\/$/, '');
      return await route(req, path, url.searchParams);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, details: err.details }, err.status);
      console.error('[api] unexpected error', err);
      return json({ error: 'Server error.' }, 500);
    }
  };
}

/** Accept only a well-formed unlimited run; anything else is dropped. */
function sanitizeRun(raw: unknown): { seed: number; level: number; score: number; levelBest: number; cleared: number; history: unknown[]; stamp: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (!n(r.seed, 0, 0xffffffff) || !n(r.level, 1, 100000) || !n(r.score, 0, 1e12) || !n(r.levelBest, 0, 100000)) return null;
  const history = Array.isArray(r.history) ? r.history.slice(-8) : [];
  if (JSON.stringify(history).length > 4000) return null;
  return { seed: r.seed as number, level: Math.floor(r.level as number), score: Math.floor(r.score as number), levelBest: Math.floor(r.levelBest as number),
    cleared: n(r.cleared, 0, 100000) ? Math.floor(r.cleared as number) : 0, history, stamp: n(r.stamp, 0, 1e14) ? (r.stamp as number) : 0 };
}
