import { combineSeed } from '../core/rng';
import { Level } from '../game/level';
import { runHeadless } from '../game/runner';
import { Device } from '../physics/types';
import { solveLevel } from './solver';
import { ChallengeSpec } from './spec';
import { buildCandidate } from './templates';
import { validateLevel } from './validate';

export interface GenerationReport {
  level: Level;
  /** Candidate layouts examined before one was accepted. */
  candidates: number;
  rejected: string[];
  /** A working (not optimal) solution found by the solver, if any. */
  solution: Device[] | null;
  relaxedTools: boolean;
  /** Shortest-route length of the accepted layout (0 when nothing validated). */
  pathLength: number;
}

const MAX_CANDIDATES = 7;
/** Bump when generation changes so cached daily levels are rebuilt. */
export const GENERATOR_VERSION = 4;

function setPar(level: Level, pathLength: number): void {
  if (level.objective.type === 'survive') {
    const d = level.objective.duration ?? 10;
    level.par = { time: d, energy: 9000 * d };
    return;
  }
  const routes = Math.max(1, level.objective.type === 'collect' ? 1 : level.objective.required.length);
  const longest = level.objective.type === 'collect' ? pathLength : pathLength / routes;
  level.par = {
    time: Math.round((longest / 230 + 1.2) * 10) / 10,
    energy: Math.round(pathLength * 330),
  };
}

/**
 * Spec -> concrete level. Several candidate layouts are built from sub-seeds; each must pass
 * structural validation, must not be trivially solved by doing nothing, and must be proven
 * solvable by the search solver. The first candidate to pass everything wins.
 */
export function generateLevel(spec: ChallengeSpec, solverBudget = 260): GenerationReport {
  const rejected: string[] = [];
  let fallback: Level | null = null;
  let fallbackPath = 0;
  let current = spec;
  let relaxed = false;

  for (let pass = 0; pass < 2; pass++) {
    for (let c = 0; c < MAX_CANDIDATES; c++) {
      const cseed = combineSeed(spec.seed, `cand-${pass}-${c}`);
      const level = buildCandidate(current, cseed);
      const report = validateLevel(level);
      if (!report.ok) { rejected.push(`#${c}: ${report.errors[0]}`); continue; }
      setPar(level, report.pathLength);
      // Appropriate difficulty: a level that completes itself is not a puzzle.
      if (runHeadless(level, []).state === 'success') { rejected.push(`#${c}: solves itself`); continue; }
      if (!fallback) { fallback = level; fallbackPath = report.pathLength; }
      const budget = level.objective.type === 'sync' ? Math.round(solverBudget * 1.4) : solverBudget;
      const solved = solveLevel(level, report.routes, combineSeed(cseed, 'solve'), budget);
      if (!solved.solved) { rejected.push(`#${c}: solver found no solution`); continue; }
      level.verified = true;
      return { level, candidates: pass * MAX_CANDIDATES + c + 1, rejected, solution: solved.devices, relaxedTools: relaxed, pathLength: report.pathLength };
    }
    // Second pass: keep the challenge structure but hand the player the full toolkit.
    current = { ...spec, tools: { attractor: 2, repulsor: 1, vortex: 1, field: 2 }, maxDevices: 4 };
    relaxed = true;
  }

  // Nothing verified. Prefer an unverified but structurally valid layout over crashing; it is
  // flagged so the UI can say so. As a last resort fall back to a simple direct route.
  if (fallback) return { level: fallback, candidates: MAX_CANDIDATES * 2, rejected, solution: null, relaxedTools: relaxed, pathLength: fallbackPath };
  const safe = generateLevel({ ...spec, template: 'direct', modifiers: [], objectCount: 1, difficulty: 1, tools: { attractor: 2, repulsor: 1, vortex: 1, field: 1 }, maxDevices: 3 }, solverBudget);
  return { ...safe, rejected: [...rejected, 'fell back to direct route'] };
}
