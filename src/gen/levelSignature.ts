import { Level } from '../game/level';
import { Device } from '../physics/types';
import { Signature, signatureOf, similarity } from './signature';
import { ChallengeSpec } from './spec';

/**
 * Level-level similarity. The spec signature (signature.ts) says what a challenge asks for;
 * this adds what the *generated arena* actually looks and plays like: obstacle counts, a
 * coarse occupancy map, where objects start and finish, how winding the route is and which
 * generators the reference solution needed. Everything here is deterministic arithmetic on
 * level data. No model output is involved in deciding whether two levels are too alike.
 */
export const GRID_W = 10;
export const GRID_H = 6;

export interface LevelSignature extends Signature {
  difficulty: number;
  counts: Record<string, number>;
  /** GRID_W x GRID_H occupancy: 1 where a wall, bumper or hazard covers the cell centre area. */
  grid: number[];
  /** Normalised [x, y] of each object start and each target. */
  starts: [number, number][];
  targets: [number, number][];
  /** Shortest route length divided by straight-line distance (1 = straight shot). */
  tortuosity: number;
  /** Generator types used by the solver's reference solution. */
  solution: string[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function levelSignatureOf(spec: ChallengeSpec, level: Level, pathLength: number, solution: Device[] | null): LevelSignature {
  const W = level.arena.w;
  const H = level.arena.h;
  const grid = new Array<number>(GRID_W * GRID_H).fill(0);
  const mark = (x0: number, y0: number, x1: number, y1: number) => {
    const i0 = Math.max(0, Math.floor((x0 / W) * GRID_W));
    const i1 = Math.min(GRID_W - 1, Math.floor((x1 / W) * GRID_W));
    const j0 = Math.max(0, Math.floor((y0 / H) * GRID_H));
    const j1 = Math.min(GRID_H - 1, Math.floor((y1 / H) * GRID_H));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) grid[j * GRID_W + i] = 1;
  };
  for (const w of level.walls) mark(w.x, w.y, w.x + w.w, w.y + w.h);
  for (const b of level.bumpers) mark(b.x - b.radius, b.y - b.radius, b.x + b.radius, b.y + b.radius);
  for (const h of level.hazards) {
    if (h.shape === 'circle') mark(h.x - h.r, h.y - h.r, h.x + h.r, h.y + h.r);
    else mark(h.x, h.y, h.x + h.w, h.y + h.h);
  }
  const required = level.bodies.filter((b) => level.objective.required.includes(b.id));
  let straight = 0;
  for (const b of required) {
    const t = level.targets.find((x) => x.accepts === b.id) ?? level.targets[0];
    if (t) straight += Math.hypot(t.x - b.x, t.y - b.y);
  }
  return {
    ...signatureOf(spec),
    difficulty: spec.difficulty,
    counts: {
      walls: level.walls.filter((w) => !w.gate && !w.motion).length,
      movingWalls: level.walls.filter((w) => w.motion).length,
      gates: level.walls.filter((w) => w.gate).length,
      bumpers: level.bumpers.length,
      hazards: level.hazards.filter((h) => !h.motion).length,
      movingHazards: level.hazards.filter((h) => h.motion).length,
      gel: level.zones.filter((z) => z.kind === 'gel').length,
      ice: level.zones.filter((z) => z.kind === 'ice').length,
      wind: level.zones.filter((z) => z.kind === 'wind').length,
      targets: level.targets.length,
      bodies: level.bodies.length,
    },
    grid,
    starts: level.bodies.map((b) => [r2(b.x / W), r2(b.y / H)]),
    targets: level.targets.map((t) => [r2(t.x / W), r2(t.y / H)]),
    tortuosity: r2(straight > 1 ? Math.max(1, pathLength / straight) : 1),
    solution: Array.from(new Set((solution ?? []).map((d) => d.type))).sort(),
  };
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const inter = a.filter((x) => b.includes(x)).length;
  return inter / (a.length + b.length - inter);
}

type Pt = [number, number];
function flipPts(p: Pt[], fx: boolean, fy: boolean): Pt[] {
  return p.map(([x, y]) => [fx ? 1 - x : x, fy ? 1 - y : y]);
}
function flipGrid(g: number[], fx: boolean, fy: boolean): number[] {
  const out = new Array<number>(g.length);
  for (let j = 0; j < GRID_H; j++) for (let i = 0; i < GRID_W; i++) {
    out[j * GRID_W + i] = g[(fy ? GRID_H - 1 - j : j) * GRID_W + (fx ? GRID_W - 1 - i : i)];
  }
  return out;
}
function gridIoU(a: number[], b: number[]): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) inter++; if (a[i] || b[i]) union++; }
  return union === 0 ? 1 : inter / union;
}
/** 1 when every point in a has a counterpart at the same place in b, falling to 0 at half an arena apart. */
function pointsAlike(a: Pt[], b: Pt[]): number {
  if (!a.length || !b.length) return a.length === b.length ? 1 : 0;
  const one = (p: Pt[], q: Pt[]) => p.reduce((s, [x, y]) => s + Math.min(...q.map(([u, v]) => Math.hypot(x - u, y - v))), 0) / p.length;
  return 1 - Math.min(1, ((one(a, b) + one(b, a)) / 2) / 0.5);
}

/** Spatial likeness in [0, 1], taking the best match over mirrored variants of the arena. */
export function layoutSimilarity(a: LevelSignature, b: LevelSignature): number {
  let best = 0;
  for (const fx of [false, true]) for (const fy of [false, true]) {
    const s = 0.5 * gridIoU(a.grid, flipGrid(b.grid, fx, fy))
      + 0.25 * pointsAlike(a.starts, flipPts(b.starts, fx, fy))
      + 0.25 * pointsAlike(a.targets, flipPts(b.targets, fx, fy));
    if (s > best) best = s;
  }
  return best;
}

function countsSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  let s = 0;
  for (const k of keys) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    s += x === y ? 1 : 1 - Math.abs(x - y) / Math.max(x, y, 1);
  }
  return keys.length ? s / keys.length : 1;
}

export interface SimilarityBreakdown { total: number; design: number; layout: number; counts: number; difficulty: number; route: number; solution: number }

export function levelSimilarityBreakdown(a: LevelSignature, b: LevelSignature): SimilarityBreakdown {
  const design = similarity(a, b);
  const layout = layoutSimilarity(a, b);
  const counts = countsSimilarity(a.counts, b.counts);
  const difficulty = 1 - Math.abs(a.difficulty - b.difficulty) / 4;
  const route = 1 - Math.min(1, Math.abs(a.tortuosity - b.tortuosity));
  const solution = jaccard(a.solution, b.solution);
  const total = 0.44 * design + 0.26 * layout + 0.12 * counts + 0.06 * difficulty + 0.04 * route + 0.08 * solution;
  return { total, design, layout, counts, difficulty, route, solution };
}

export function levelSimilarity(a: LevelSignature, b: LevelSignature): number {
  return levelSimilarityBreakdown(a, b).total;
}

/** Candidates scoring at or above this against any recent published level are rejected. */
export const LEVEL_SIMILARITY_LIMIT = 0.76;
/** How many recently published levels a candidate is compared against. */
export const LEVEL_HISTORY = 14;

export function mostSimilar(sig: LevelSignature, history: { key: string; signature: LevelSignature }[]): { score: number; key: string | null } {
  let score = 0;
  let key: string | null = null;
  for (const h of history.slice(-LEVEL_HISTORY)) {
    const s = levelSimilarity(sig, h.signature);
    if (s > score) { score = s; key = h.key; }
  }
  return { score, key };
}
