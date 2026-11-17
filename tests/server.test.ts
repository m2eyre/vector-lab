import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { ModelClient } from '../server/ai';
import { publishDaily } from '../server/publish';
import { Level } from '../src/game/level';
import { verifySolution } from '../src/game/verify';
import { generateLevel } from '../src/gen/generator';
import { dailySpec } from '../src/modes/daily';
import { Device } from '../src/physics/types';
import { freshDatabase, testApi } from './helpers/db';

/**
 * Backend integration tests. They run the real API handler against a real PostgreSQL
 * database with the production migration applied. Only two things are stand-ins: Supabase
 * Auth (dev tokens) and the language model (a scripted ModelClient).
 */
const DAY = '2026-11-17';
const clock = { now: new Date(`${DAY}T12:00:00Z`) };
let sql: postgres.Sql;
let api: ReturnType<typeof testApi>;

const fakeModel = (respond: () => unknown): ModelClient => ({ model: 'scripted-test-model', propose: async () => respond() });
const reference = async (date: string): Promise<Device[]> => (await sql`select reference_solution from challenge_metadata where date = ${date}::date`)[0].reference_solution;
const levelOf = async (date: string): Promise<Level> => (await sql`select level from daily_challenges where date = ${date}::date`)[0].level;

/** A second, different working solution: nudge the reference until it still solves. */
function variant(level: Level, base: Device[], salt: number): Device[] {
  for (let k = 1; k < 60; k++) {
    const devices = base.map((d, i) => ({ ...d, strength: Math.min(level.strengthCap, Math.max(40, d.strength + (i === 0 ? k * salt : 0))) }));
    const v = verifySolution(level, devices);
    if (v.ok && JSON.stringify(devices) !== JSON.stringify(base)) return devices;
  }
  throw new Error('no variant found');
}

beforeAll(async () => {
  sql = await freshDatabase();
  api = testApi(sql, { now: () => clock.now });
});
afterAll(async () => { await sql.end(); });

describe('shared daily challenge', () => {
  it('publishes exactly one challenge per date and serves the identical level to everyone', async () => {
    const first = await publishDaily(sql, DAY);
    expect(first.created).toBe(true);
    expect(first.source).toBe('procedural');
    const second = await publishDaily(sql, DAY);
    expect(second.created).toBe(false);
    expect(second.title).toBe(first.title);

    const alice = await api.login('Alice');
    const bob = await api.login('Bob');
    const a = await api.call('GET', '/daily', { token: alice.token });
    const b = await api.call('GET', '/daily', { token: bob.token });
    const guest = await api.call('GET', `/daily?date=${DAY}`);
    expect(a.status).toBe(200);
    expect(a.body.today).toBe(DAY);
    expect(a.body.challenge.level.bodies.length).toBeGreaterThan(0);
    expect(JSON.stringify(b.body.challenge)).toBe(JSON.stringify(a.body.challenge));
    expect(JSON.stringify(guest.body.challenge)).toBe(JSON.stringify(a.body.challenge));
    // "Refresh": asking again later returns the stored challenge, not a regenerated one.
    const again = await api.call('GET', '/daily');
    expect(JSON.stringify(again.body.challenge)).toBe(JSON.stringify(a.body.challenge));
    expect((await sql`select count(*)::int as n from daily_challenges where date = ${DAY}::date`)[0].n).toBe(1);
  });

  it('concurrent publishers still produce a single challenge', async () => {
    const results = await Promise.all([publishDaily(sql, '2026-11-16'), publishDaily(sql, '2026-11-16'), publishDaily(sql, '2026-11-16')]);
    expect(results.filter((r) => r.created).length).toBe(1);
    expect(new Set(results.map((r) => r.title)).size).toBe(1);
  });

  it('generates tomorrow in advance without revealing it early', async () => {
    const res = await api.call('POST', '/cron/publish', { headers: { 'x-cron-secret': 'cron-test' }, body: {} });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: any) => r.date)).toEqual([DAY, '2026-11-18']);
    expect(res.body.results[0].created).toBe(false);
    expect(res.body.results[1].created).toBe(true);
    expect((await api.call('GET', '/daily?date=2026-11-18')).status).toBe(404);
    const before = (await sql`select level from daily_challenges where date = '2026-11-18'`)[0].level;
    clock.now = new Date('2026-11-18T00:00:05Z');
    const next = await api.call('GET', '/daily');
    expect(next.body.challenge.date).toBe('2026-11-18');
    expect(JSON.stringify(next.body.challenge.level)).toBe(JSON.stringify(before));
    clock.now = new Date(`${DAY}T12:00:00Z`);
  });

  it('rejects publish calls without the cron secret', async () => {
    expect((await api.call('POST', '/cron/publish', { body: {} })).status).toBe(403);
    expect((await api.call('POST', '/cron/publish', { headers: { 'x-cron-secret': 'wrong-one' }, body: {} })).status).toBe(403);
  });

  it('publishes on demand when the scheduler never ran, so the day is never empty', async () => {
    clock.now = new Date('2026-11-19T08:00:00Z');
    expect((await sql`select count(*)::int as n from daily_challenges where date = '2026-11-19'`)[0].n).toBe(0);
    const res = await api.call('GET', '/daily');
    expect(res.status).toBe(200);
    expect(res.body.challenge.date).toBe('2026-11-19');
    expect(res.body.challenge.source).toBe('procedural');
    clock.now = new Date(`${DAY}T12:00:00Z`);
  });
});

describe('AI challenge designer pipeline', () => {
  const good = { title: 'Glass Keyhole', concept: 'Thread a narrow gap on a zero-drag floor.', template: 'narrow', difficulty: 3, objectCount: 1, modifiers: ['ice'], tools: { attractor: 1, repulsor: 0, vortex: 0, field: 1 }, maxDevices: 2 };

  it('publishes a valid AI spec only after generation and solver verification', async () => {
    const r = await publishDaily(sql, '2026-11-20', { model: fakeModel(() => ({ candidates: [good] })) });
    expect(r.created).toBe(true);
    expect(r.source).toBe('ai');
    expect(r.title).toBe('Glass Keyhole');
    const [row] = await sql`select c.level, c.spec, m.model, m.reference_solution from daily_challenges c join challenge_metadata m on m.date = c.date where c.date = '2026-11-20'`;
    expect(row.model).toBe('scripted-test-model');
    expect(row.level.verified).toBe(true);
    expect(row.level.template).toBe('narrow');
    // The stored reference solution really solves the stored level.
    expect(verifySolution(row.level, row.reference_solution).ok).toBe(true);
  });

  it('rejects malformed, out-of-vocabulary and code-bearing output, then falls back', async () => {
    const bad = [
      { ...good, title: 'Injected', template: 'teleport' },
      { ...good, title: 'Has Code', script: 'fetch("https://example.com")' },
      { ...good, title: '<img src=x onerror=alert(1)>' },
      { ...good, title: 'Bad Combo', modifiers: ['gel', 'ice'] },
      { ...good, title: 'Wrong Mod', template: 'chain', objectCount: 2, modifiers: ['crosswind'] },
      'not an object',
    ];
    const r = await publishDaily(sql, '2026-11-21', { model: fakeModel(() => ({ candidates: bad })) });
    expect(r.created).toBe(true);
    expect(r.source).toBe('procedural');
    const rejected = r.log.filter((e) => e.stage === 'ai' && e.outcome === 'rejected');
    expect(rejected.length).toBe(6);
    expect(rejected[0].reason).toMatch(/unknown template/);
    expect(rejected[1].reason).toMatch(/unknown field: script/);
    expect(rejected[2].reason).toMatch(/unsupported characters/);
    expect(rejected[3].reason).toMatch(/conflicts/);
    expect(rejected[4].reason).toMatch(/not supported on template/);
    const [row] = await sql`select level from daily_challenges where date = '2026-11-21'`;
    expect(JSON.stringify(row.level)).not.toMatch(/Injected|onerror|example\.com/);
  });

  it('survives garbage responses and an unreachable model', async () => {
    const garbage = await publishDaily(sql, '2026-11-22', { model: fakeModel(() => 'I cannot help with that') });
    expect(garbage.source).toBe('procedural');
    expect(garbage.log.some((e) => /no candidates/.test(e.reason ?? ''))).toBe(true);
    const down = await publishDaily(sql, '2026-11-23', { model: { model: 'down', propose: async () => { throw new Error('connect ETIMEDOUT'); } } });
    expect(down.created).toBe(true);
    expect(down.source).toBe('procedural');
    expect(down.log.some((e) => /AI unavailable/.test(e.reason ?? ''))).toBe(true);
    const [row] = await sql`select level from daily_challenges where date = '2026-11-23'`;
    expect(row.level.bodies.length).toBeGreaterThan(0);
  });

  it('filters candidates that repeat a recently published challenge', async () => {
    // Same design as 2026-11-20 ("Glass Keyhole"), then a different, fresh one.
    const fresh = { title: 'Quiet Carom', concept: 'Strike the shielded payload cleanly with a single push.', template: 'chain', difficulty: 2, objectCount: 2, modifiers: [], tools: { attractor: 0, repulsor: 2, vortex: 0, field: 0 }, maxDevices: 2 };
    const r = await publishDaily(sql, '2026-11-24', { model: fakeModel(() => ({ candidates: [{ ...good, title: 'Glass Again', difficulty: 2 }, fresh] })) });
    const first = r.log.find((e) => e.title === 'Glass Again')!;
    expect(first.outcome).toBe('rejected');
    expect(first.reason).toMatch(/too similar/);
    // The second candidate is judged on its own merits; either way a challenge is published.
    expect(r.created).toBe(true);
    expect((await sql`select count(*)::int as n from daily_challenges where date = '2026-11-24'`)[0].n).toBe(1);
  });

  it('rejects candidates whose difficulty ignores the target', async () => {
    const r = await publishDaily(sql, '2026-11-25', { model: fakeModel(() => ({ candidates: [{ ...good, title: 'Too Easy', template: 'gate', modifiers: [], difficulty: 5 }] })) });
    // 2026-11-25 is a Wednesday (target 3): difficulty 5 is two steps away.
    expect(r.log[0].reason).toMatch(/too far from target/);
    expect(r.source).toBe('procedural');
  });
});

describe('score validation and leaderboards', () => {
  let alice: { token: string; userId: string };
  let bob: { token: string; userId: string };
  let cara: { token: string; userId: string };
  let level: Level;
  let ref: Device[];

  beforeAll(async () => {
    alice = await api.login('Alice2');
    bob = await api.login('Bob2');
    cara = await api.login('Cara');
    level = await levelOf(DAY);
    ref = await reference(DAY);
  });

  it('requires an account to submit, but not to play', async () => {
    expect((await api.call('GET', '/daily')).status).toBe(200);
    expect((await api.call('POST', '/scores', { body: { date: DAY, devices: ref } })).status).toBe(401);
  });

  it('re-simulates the solution and ignores any score the client claims', async () => {
    const res = await api.call('POST', '/scores', { token: alice.token, body: { date: DAY, devices: ref, score: 100000, time: 0.01, energy: 0 } });
    expect(res.status).toBe(200);
    const local = verifySolution(level, ref);
    if (!local.ok) throw new Error('reference must solve');
    expect(res.body.score.total).toBe(local.run.score.total);
    expect(res.body.score.total).toBeLessThan(100000);
    expect(res.body.time).toBeCloseTo(local.run.time, 6);
    expect(res.body.rank).toBe(1);
    expect(res.body.first).toBe(true);
    const [row] = await sql`select best_score, attempts from leaderboard_entries where date = ${DAY}::date and user_id = ${alice.userId}`;
    expect(row.best_score).toBe(local.run.score.total);
  });

  it('rejects tampered or rule-breaking solutions', async () => {
    const tooStrong = ref.map((d) => ({ ...d, strength: 5000 }));
    const outside = ref.map((d) => ({ ...d, x: -50 }));
    const tooMany = Array.from({ length: level.maxDevices + 1 }, () => ref[0]);
    const banned = (['attractor', 'repulsor', 'vortex', 'field'] as const).find((t) => level.tools[t] === 0);
    const nan = ref.map((d) => ({ ...d, range: 'NaN' }));
    const useless = [{ ...ref[0], x: 5, y: 5, strength: 40, range: 60 }];
    for (const devices of [tooStrong, outside, tooMany, nan, useless, [], 'junk', banned ? [{ ...ref[0], type: banned }] : 'junk']) {
      const res = await api.call('POST', '/scores', { token: bob.token, body: { date: DAY, devices } });
      expect(res.status).toBe(422);
    }
    expect((await sql`select count(*)::int as n from leaderboard_entries where user_id = ${bob.userId}`)[0].n).toBe(0);
    expect((await api.call('POST', '/scores', { token: bob.token, body: { date: '2026-11-18', devices: ref } })).status).toBe(400);
    expect((await api.call('POST', '/scores', { token: bob.token, body: { date: '2031-01-01', devices: ref } })).status).toBe(400);
  });

  it('does not count duplicate submissions twice', async () => {
    const res = await api.call('POST', '/scores', { token: alice.token, body: { date: DAY, devices: ref } });
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect((await sql`select attempts from leaderboard_entries where date = ${DAY}::date and user_id = ${alice.userId}`)[0].attempts).toBe(1);
    expect((await sql`select count(*)::int as n from daily_scores where user_id = ${alice.userId}`)[0].n).toBe(1);
  });

  it('ranks players on score, time and energy and keeps each player once', async () => {
    const bobDevices = variant(level, ref, 7);
    const caraDevices = variant(level, ref, -5);
    const b = await api.call('POST', '/scores', { token: bob.token, body: { date: DAY, devices: bobDevices } });
    const c = await api.call('POST', '/scores', { token: cara.token, body: { date: DAY, devices: caraDevices } });
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);
    // Bob improves on a second attempt or not; either way he stays one row.
    await api.call('POST', '/scores', { token: bob.token, body: { date: DAY, devices: variant(level, bobDevices, 3) } });

    const board = await api.call('GET', `/leaderboard?scope=daily&metric=score&date=${DAY}`, { token: bob.token });
    expect(board.body.live).toBe(true);
    expect(board.body.entries.length).toBe(3);
    const scores = board.body.entries.map((e: any) => e.score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    expect(board.body.entries.map((e: any) => e.rank)).toEqual([1, 2, 3]);
    expect(board.body.entries.filter((e: any) => e.isPlayer).map((e: any) => e.player)).toEqual(['Bob2']);
    expect(board.body.entries.every((e: any) => typeof e.replayId === 'string')).toBe(true);

    const fastest = await api.call('GET', `/leaderboard?scope=daily&metric=time&date=${DAY}`);
    const times = fastest.body.entries.map((e: any) => e.time);
    expect(times).toEqual([...times].sort((x, y) => x - y));
    const frugal = await api.call('GET', `/leaderboard?scope=daily&metric=energy&date=${DAY}`);
    const energies = frugal.body.entries.map((e: any) => e.energy);
    expect(energies).toEqual([...energies].sort((x, y) => x - y));
  });

  it('aggregates weekly and all-time boards across days', async () => {
    // Alice also clears the day before.
    const prev = '2026-11-16';
    const res = await api.call('POST', '/scores', { token: alice.token, body: { date: prev, devices: await reference(prev) } });
    expect(res.status).toBe(200);
    const weekly = await api.call('GET', `/leaderboard?scope=weekly&date=${DAY}`);
    const top = weekly.body.entries[0];
    expect(top.player).toBe('Alice2');
    expect(top.days).toBe(2);
    const [sum] = await sql`select sum(best_score)::int as s from leaderboard_entries where user_id = ${alice.userId}`;
    expect(top.score).toBe(sum.s);
    const all = await api.call('GET', `/leaderboard?scope=alltime&date=${DAY}`);
    expect(all.body.entries.length).toBe(3);
    expect(all.body.entries[0].score).toBeGreaterThanOrEqual(all.body.entries[1].score);
  });

  it('builds a friends board from friend codes', async () => {
    expect((await api.call('GET', `/leaderboard?scope=friends&date=${DAY}`)).status).toBe(401);
    const me = await api.call('GET', '/me', { token: cara.token });
    const code = me.body.profile.friendCode;
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    expect((await api.call('POST', '/friends', { token: alice.token, body: { code: 'ZZZZZZZZ' } })).status).toBe(404);
    const added = await api.call('POST', '/friends', { token: alice.token, body: { code } });
    expect(added.body.friends.map((f: any) => f.name)).toEqual(['Cara']);
    const board = await api.call('GET', `/leaderboard?scope=friends&date=${DAY}`, { token: alice.token });
    expect(board.body.entries.map((e: any) => e.player).sort()).toEqual(['Alice2', 'Cara']);
    const removed = await api.call('DELETE', `/friends?id=${cara.userId}`, { token: alice.token });
    expect(removed.body.friends).toEqual([]);
  });

  it('tracks the daily streak on the server', async () => {
    const me = await api.call('GET', '/me', { token: alice.token });
    expect(me.body.progress.daily.streak).toBe(1);
    expect(me.body.progress.daily.completed).toBe(2);
    expect(me.body.progress.daily.results.length).toBe(2);
    // Next day: clearing it extends the streak.
    clock.now = new Date('2026-11-18T09:00:00Z');
    const res = await api.call('POST', '/scores', { token: alice.token, body: { date: '2026-11-18', devices: await reference('2026-11-18') } });
    expect(res.status).toBe(200);
    expect((await api.call('GET', '/me', { token: alice.token })).body.progress.daily.streak).toBe(2);
    clock.now = new Date(`${DAY}T12:00:00Z`);
  });

  it('rate limits score submissions', async () => {
    const spammer = await api.login('Spammer');
    let limited = 0;
    for (let i = 0; i < 24; i++) {
      const res = await api.call('POST', '/scores', { token: spammer.token, body: { date: DAY, devices: [] } });
      if (res.status === 429) limited++;
    }
    expect(limited).toBe(4);
  });
});

describe('replays', () => {
  it('stores solutions that reproduce the recorded result exactly', async () => {
    const dana = await api.login('Dana');
    const ref = await reference(DAY);
    const sub = await api.call('POST', '/scores', { token: dana.token, body: { date: DAY, devices: ref } });
    const got = await api.call('GET', `/replay?id=${sub.body.replayId}`, { token: dana.token });
    expect(got.status).toBe(200);
    const r = got.body.replay;
    expect(r.player).toBe('Dana');
    expect(r.sim.dt).toBeCloseTo(1 / 120, 12);
    const again = verifySolution(r.level, r.devices);
    if (!again.ok) throw new Error('replay must reproduce');
    expect(again.run.score.total).toBe(r.score);
    expect(again.run.time).toBeCloseTo(r.time, 5);
    expect(again.run.energy).toBeCloseTo(r.energy, 3);
    const mine = await api.call('GET', '/replays', { token: dana.token });
    expect(mine.body.replays[0].id).toBe(sub.body.replayId);
  });

  it("hides today's solutions from players who have not solved today, and opens them afterwards", async () => {
    const eve = await api.login('Eve');
    const [top] = (await api.call('GET', `/leaderboard?scope=daily&date=${DAY}`)).body.entries;
    const guest = await api.call('GET', `/replay?id=${top.replayId}`);
    expect(guest.status).toBe(403);
    expect(guest.body.locked).toBe(true);
    expect((await api.call('GET', `/replay?id=${top.replayId}`, { token: eve.token })).status).toBe(403);
    await api.call('POST', '/scores', { token: eve.token, body: { date: DAY, devices: await reference(DAY) } });
    expect((await api.call('GET', `/replay?id=${top.replayId}`, { token: eve.token })).status).toBe(200);
    // Once the day is over the replay is public, including for shared links.
    clock.now = new Date('2026-11-18T03:00:00Z');
    expect((await api.call('GET', `/replay?id=${top.replayId}`)).status).toBe(200);
    clock.now = new Date(`${DAY}T12:00:00Z`);
  });

  it('shares unlimited-mode solutions after verifying them against the supplied level', async () => {
    const finn = await api.login('Finn');
    const report = generateLevel(dailySpec('2026-12-01'));
    const ok = await api.call('POST', '/replays', { token: finn.token, body: { level: report.level, devices: report.solution, label: 'Unlimited L7' } });
    expect(ok.status).toBe(200);
    const got = await api.call('GET', `/replay?id=${ok.body.replayId}`);
    expect(got.body.replay.kind).toBe('unlimited');
    expect(got.body.replay.level.title).toBe(report.level.title);
    const bad = await api.call('POST', '/replays', { token: finn.token, body: { level: { ...report.level, bodies: 'x' }, devices: report.solution } });
    expect(bad.status).toBe(422);
    const hostile = await api.call('POST', '/replays', { token: finn.token, body: { level: { ...report.level, objective: { ...report.level.objective, timeLimit: 1e9 } }, devices: report.solution } });
    expect(hostile.status).toBe(422);
  });
});

describe('accounts and progress sync', () => {
  it('persists unlimited progress and statistics across devices', async () => {
    const gil = await api.login('Gil');
    const run = { seed: 1234, level: 9, score: 512000, levelBest: 0, cleared: 8, history: [], stamp: 1000 };
    const first = await api.call('POST', '/sync', { token: gil.token, body: {
      unlimited: { highestLevel: 8, bestRunScore: 512000, longestRun: 8, runsStarted: 2, run },
      stats: { simulations: 40, successes: 12, failures: 28, devicesPlaced: 90, simSeconds: 300, bestScore: 88000, levelsCleared: 8, byTemplate: { direct: 3, gate: 2 } },
      unlocks: ['template:gate', 'skin:ember', 'bad id!'], tutorialDone: true,
    } });
    expect(first.status).toBe(200);
    // "Second device": a new login session for the same account sees everything.
    const second = (await api.call('POST', '/dev/login', { body: { userId: gil.userId } })).body;
    const me = await api.call('GET', '/me', { token: second.token });
    const p = me.body.progress;
    expect(p.unlimited).toMatchObject({ highestLevel: 8, bestRunScore: 512000, longestRun: 8, runsStarted: 2 });
    expect(p.unlimited.run.level).toBe(9);
    expect(p.stats.byTemplate).toEqual({ direct: 3, gate: 2 });
    expect(p.unlocks.sort()).toEqual(['skin:ember', 'template:gate']);
    expect(p.tutorialDone).toBe(true);
    // An older device syncing stale numbers cannot roll progress back.
    const stale = await api.call('POST', '/sync', { token: second.token, body: { unlimited: { highestLevel: 2, bestRunScore: 10, longestRun: 1, runsStarted: 1, run: { ...run, level: 3, stamp: 500 } }, stats: { simulations: 5, byTemplate: { direct: 1, sync: 4 } }, unlocks: ['tool:vortex'] } });
    expect(stale.body.progress.unlimited.highestLevel).toBe(8);
    expect(stale.body.progress.unlimited.run.level).toBe(9);
    expect(stale.body.progress.stats.simulations).toBe(40);
    expect(stale.body.progress.stats.byTemplate).toEqual({ direct: 3, gate: 2, sync: 4 });
    expect(stale.body.progress.unlocks.length).toBe(3);
  });

  it('validates profile changes and exposes public profiles', async () => {
    const hana = await api.login('Hana');
    expect((await api.call('POST', '/me', { token: hana.token, body: { displayName: '<script>' } })).status).toBe(400);
    const ok = await api.call('POST', '/me', { token: hana.token, body: { displayName: 'Hana V', skin: 'ember' } });
    expect(ok.body.profile.name).toBe('Hana V');
    const pub = await api.call('GET', `/profile?id=${hana.userId}`);
    expect(pub.body.profile).toMatchObject({ name: 'Hana V', skin: 'ember' });
    expect(pub.body.profile.friendCode).toBeUndefined();
    expect(pub.body.stats.dailiesCompleted).toBe(0);
    expect((await api.call('GET', '/me')).status).toBe(401);
    expect((await api.call('GET', '/me', { token: 'dev.00000000-0000-0000-0000-000000000000.' + 'a'.repeat(64) })).status).toBe(401);
  });
});
