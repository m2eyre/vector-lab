import type { Sql } from 'postgres';
import { RuleBasedDesigner } from '../src/ai/designer';
import { combineSeed } from '../src/core/rng';
import { generateLevel, GENERATOR_VERSION } from '../src/gen/generator';
import { LEVEL_HISTORY, LEVEL_SIMILARITY_LIMIT, LevelSignature, levelSignatureOf, mostSimilar } from '../src/gen/levelSignature';
import { maxSimilarity, signatureOf, SIMILARITY_LIMIT } from '../src/gen/signature';
import { ChallengeSpec, validateSpecStrict } from '../src/gen/spec';
import { Level } from '../src/game/level';
import { challengeNumber, dailyDifficulty, dailySeed, dailySpec } from '../src/modes/daily';
import { Device } from '../src/physics/types';
import { DesignBrief, extractCandidates, ModelClient } from './ai';

export interface PipelineEntry {
  stage: 'ai' | 'procedural';
  candidate?: number;
  title?: string;
  template?: string;
  outcome: 'accepted' | 'rejected' | 'error' | 'info';
  reason?: string;
  similarity?: number;
}

export interface PublishResult {
  date: string;
  created: boolean;
  source: 'ai' | 'procedural';
  title: string;
  log: PipelineEntry[];
}

interface Evaluated {
  spec: ChallengeSpec;
  level: Level;
  signature: LevelSignature;
  solution: Device[] | null;
  similarity: number;
  mostSimilarTo: string | null;
}

type History = { key: string; signature: LevelSignature }[];

/**
 * Turn one spec into a publishable level, or say why not. This is the gate nothing gets
 * around: the generator must produce a structurally valid arena that the solver proved
 * solvable with exactly the tools the spec promised, and the result must not be too close
 * to a recently published level.
 */
export function evaluateSpec(spec: ChallengeSpec, history: History, date: string): { ok: true; value: Evaluated } | { ok: false; reason: string; value?: Evaluated } {
  const specSim = maxSimilarity(signatureOf(spec), history.map((h) => h.signature));
  if (specSim >= SIMILARITY_LIMIT) return { ok: false, reason: `design too similar to a recent challenge (${specSim.toFixed(2)} >= ${SIMILARITY_LIMIT})` };
  const report = generateLevel(spec);
  const level = report.level;
  level.id = `daily-${date}`;
  const signature = levelSignatureOf(spec, level, report.pathLength, report.solution);
  const near = mostSimilar(signature, history);
  const value: Evaluated = { spec, level, signature, solution: report.solution, similarity: near.score, mostSimilarTo: near.key };
  if (!level.verified || !report.solution) return { ok: false, reason: 'no layout passed physics validation and solver verification', value };
  if (report.relaxedTools || level.template !== spec.template) return { ok: false, reason: 'not solvable with the specified toolkit', value };
  if (near.score >= LEVEL_SIMILARITY_LIMIT) return { ok: false, reason: `level too similar to ${near.key} (${near.score.toFixed(2)} >= ${LEVEL_SIMILARITY_LIMIT})`, value };
  return { ok: true, value };
}

export async function loadHistory(sql: Sql, before: string): Promise<{ history: History; recent: DesignBrief['recent'] }> {
  const rows = await sql`
    select c.date::text as date, c.title, c.spec, m.signature
    from daily_challenges c join challenge_metadata m on m.date = c.date
    where c.date < ${before}::date order by c.date desc limit ${LEVEL_HISTORY}`;
  rows.reverse();
  return {
    history: rows.map((r) => ({ key: r.date as string, signature: r.signature as LevelSignature })),
    recent: rows.map((r) => {
      const s = r.spec as ChallengeSpec;
      return { date: r.date, title: r.title, template: s.template, difficulty: s.difficulty, objectCount: s.objectCount, modifiers: s.modifiers, tools: s.tools, maxDevices: s.maxDevices };
    }),
  };
}

/** Run the AI stage. Never throws: any failure is logged and the caller falls back. */
export async function designWithAI(model: ModelClient, brief: DesignBrief, history: History, log: PipelineEntry[]): Promise<Evaluated | null> {
  let raw: unknown;
  try {
    raw = await model.propose(brief);
  } catch (err) {
    log.push({ stage: 'ai', outcome: 'error', reason: `AI unavailable: ${String((err as Error)?.message ?? err).slice(0, 200)}` });
    return null;
  }
  const candidates = extractCandidates(raw);
  if (!candidates.length) {
    log.push({ stage: 'ai', outcome: 'error', reason: 'AI response contained no candidates' });
    return null;
  }
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    // The seed is assigned by the server; the model has no say over geometry.
    const withSeed = c && typeof c === 'object' && !Array.isArray(c) ? { ...(c as object), version: 1, seed: combineSeed(dailySeed(brief.date), `ai-${i}`) } : c;
    const checked = validateSpecStrict(withSeed);
    if (!checked.ok) {
      log.push({ stage: 'ai', candidate: i, outcome: 'rejected', reason: `invalid spec: ${checked.errors.slice(0, 4).join('; ')}`.slice(0, 300) });
      continue;
    }
    const spec = checked.spec;
    const base = { stage: 'ai' as const, candidate: i, title: spec.title, template: spec.template };
    if (Math.abs(spec.difficulty - brief.targetDifficulty) > 1) {
      log.push({ ...base, outcome: 'rejected', reason: `difficulty ${spec.difficulty} too far from target ${brief.targetDifficulty}` });
      continue;
    }
    const result = evaluateSpec(spec, history, brief.date);
    if (!result.ok) {
      log.push({ ...base, outcome: 'rejected', reason: result.reason, similarity: result.value?.similarity });
      continue;
    }
    log.push({ ...base, outcome: 'accepted', similarity: result.value.similarity });
    return result.value;
  }
  return null;
}

/** Deterministic fallback. Always returns a playable level, even if every variety check fails. */
export function designProcedurally(date: string, history: History, log: PipelineEntry[]): Evaluated {
  const designer = new RuleBasedDesigner();
  const sigs = history.map((h) => h.signature);
  let best: Evaluated | null = null;
  let last: Evaluated | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    // Attempt 0 is the same schedule the offline game uses; later attempts ask the
    // rule-based designer for alternatives that differ from the published history.
    const spec = attempt === 0
      ? dailySpec(date)
      : designer.designSync({ seed: combineSeed(dailySeed(date), `alt-${attempt}`), difficulty: dailyDifficulty(date), history: sigs, allowedTools: ['attractor', 'repulsor', 'vortex', 'field'] });
    const base = { stage: 'procedural' as const, candidate: attempt, title: spec.title, template: spec.template };
    const result = evaluateSpec(spec, history, date);
    if (result.ok) {
      log.push({ ...base, outcome: 'accepted', similarity: result.value.similarity });
      return result.value;
    }
    log.push({ ...base, outcome: 'rejected', reason: result.reason, similarity: result.value?.similarity });
    if (result.value) {
      last = result.value;
      if (result.value.level.verified && (!best || result.value.similarity < best.similarity)) best = result.value;
    }
  }
  const chosen = best ?? last;
  if (chosen) {
    log.push({ stage: 'procedural', outcome: 'info', title: chosen.spec.title, reason: 'no alternative passed every check; published the least similar verified level so the day is never empty' });
    return chosen;
  }
  // Every attempt was rejected on design similarity alone. Build the scheduled spec anyway.
  const spec = dailySpec(date);
  const report = generateLevel(spec);
  report.level.id = `daily-${date}`;
  const signature = levelSignatureOf(spec, report.level, report.pathLength, report.solution);
  const near = mostSimilar(signature, history);
  log.push({ stage: 'procedural', outcome: 'info', title: spec.title, reason: 'published the scheduled challenge despite similarity so the day is never empty' });
  return { spec, level: report.level, signature, solution: report.solution, similarity: near.score, mostSimilarTo: near.key };
}

export interface PublishOptions {
  model?: ModelClient | null;
  candidates?: number;
}

/**
 * Publish the challenge for one date, exactly once. Safe to call repeatedly and from several
 * workers: an advisory lock serialises publishers and the primary key makes the insert
 * idempotent. Works for today, for future dates (advance generation) and to backfill.
 */
export async function publishDaily(sql: Sql, date: string, opts: PublishOptions = {}): Promise<PublishResult> {
  const existing = await sql`select title, source from daily_challenges where date = ${date}::date`;
  if (existing.length) return { date, created: false, source: existing[0].source, title: existing[0].title, log: [] };

  return await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${'vl-publish-' + date}))`;
    const again = await tx`select title, source from daily_challenges where date = ${date}::date`;
    if (again.length) return { date, created: false, source: again[0].source, title: again[0].title, log: [] };

    const log: PipelineEntry[] = [];
    const { history, recent } = await loadHistory(tx as unknown as Sql, date);
    let chosen: Evaluated | null = null;
    let source: 'ai' | 'procedural' = 'procedural';
    if (opts.model) {
      const brief: DesignBrief = { date, number: challengeNumber(date), targetDifficulty: dailyDifficulty(date), candidates: opts.candidates ?? 4, recent };
      chosen = await designWithAI(opts.model, brief, history, log);
      if (chosen) source = 'ai';
      else log.push({ stage: 'ai', outcome: 'info', reason: 'no AI candidate was publishable; using the procedural designer' });
    } else {
      log.push({ stage: 'ai', outcome: 'info', reason: 'AI designer not configured; using the procedural designer' });
    }
    if (!chosen) chosen = designProcedurally(date, history, log);

    const { spec, level } = chosen;
    await tx`
      insert into daily_challenges (date, number, title, difficulty, seed, spec, level, source, generator_version)
      values (${date}::date, ${challengeNumber(date)}, ${spec.title}, ${spec.difficulty}, ${spec.seed}, ${tx.json(spec as any)}, ${tx.json(level as any)}, ${source}, ${GENERATOR_VERSION})`;
    await tx`
      insert into challenge_metadata (date, signature, model, similarity, most_similar_to, pipeline, reference_solution)
      values (${date}::date, ${tx.json(chosen.signature as any)}, ${source === 'ai' ? opts.model!.model : null}, ${chosen.similarity},
              ${chosen.mostSimilarTo}, ${tx.json(log as any)}, ${chosen.solution ? tx.json(chosen.solution as any) : null})`;
    return { date, created: true, source, title: spec.title, log };
  }) as PublishResult;
}
