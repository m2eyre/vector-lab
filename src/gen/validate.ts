import { Level } from '../game/level';
import { circleRect, dist } from './geometry';

const CELL = 20;

export interface Nav {
  cols: number;
  rows: number;
  blocked: Uint8Array;
}

export interface Route {
  bodyId: string;
  points: { x: number; y: number }[];
  length: number;
}

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  routes: Route[];
  /** Sum of route lengths: the travel the objective needs at minimum. */
  pathLength: number;
}

/**
 * Coarse navigation grid for a body of the given radius. Permanent walls, bumpers and static
 * hazards block cells; gates and moving parts are treated as passable because they open.
 */
export function buildNav(level: Level, radius: number): Nav {
  const cols = Math.ceil(level.arena.w / CELL);
  const rows = Math.ceil(level.arena.h / CELL);
  const blocked = new Uint8Array(cols * rows);
  const r = radius + 3;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cx = (i + 0.5) * CELL;
      const cy = (j + 0.5) * CELL;
      let b = cx < r || cy < r || cx > level.arena.w - r || cy > level.arena.h - r;
      for (let k = 0; !b && k < level.walls.length; k++) {
        const w = level.walls[k];
        if (!w.gate && !w.motion && circleRect(cx, cy, r, w)) b = true;
      }
      for (let k = 0; !b && k < level.bumpers.length; k++) {
        const bp = level.bumpers[k];
        if (dist(cx, cy, bp.x, bp.y) < r + bp.radius) b = true;
      }
      for (let k = 0; !b && k < level.hazards.length; k++) {
        const h = level.hazards[k];
        if (h.motion) continue;
        const pad = radius * 0.7 + 10;
        if (h.shape === 'circle' ? dist(cx, cy, h.x, h.y) < pad + h.r : circleRect(cx, cy, pad, h)) b = true;
      }
      blocked[j * cols + i] = b ? 1 : 0;
    }
  }
  return { cols, rows, blocked };
}

function cellOf(nav: Nav, x: number, y: number): number {
  const i = Math.max(0, Math.min(nav.cols - 1, Math.floor(x / CELL)));
  const j = Math.max(0, Math.min(nav.rows - 1, Math.floor(y / CELL)));
  return j * nav.cols + i;
}

function lineClear(nav: Nav, ax: number, ay: number, bx: number, by: number): boolean {
  const n = Math.ceil(dist(ax, ay, bx, by) / (CELL * 0.4));
  for (let s = 0; s <= n; s++) {
    const t = n === 0 ? 0 : s / n;
    if (nav.blocked[cellOf(nav, ax + (bx - ax) * t, ay + (by - ay) * t)]) return false;
  }
  return true;
}

/** Breadth-first search from start to anywhere within `goalRadius` of the goal. */
export function findPath(
  nav: Nav, sx: number, sy: number, gx: number, gy: number, goalRadius: number,
): { points: { x: number; y: number }[]; length: number } | null {
  const start = cellOf(nav, sx, sy);
  if (nav.blocked[start]) return null;
  const prev = new Int32Array(nav.cols * nav.rows).fill(-2);
  const queue = new Int32Array(nav.cols * nav.rows);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  prev[start] = -1;
  let found = -1;
  while (head < tail) {
    const c = queue[head++];
    const ci = c % nav.cols;
    const cj = (c - ci) / nav.cols;
    if (dist((ci + 0.5) * CELL, (cj + 0.5) * CELL, gx, gy) <= Math.max(goalRadius, CELL * 0.75)) { found = c; break; }
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= nav.cols || nj >= nav.rows) continue;
        const n = nj * nav.cols + ni;
        if (prev[n] !== -2 || nav.blocked[n]) continue;
        // No squeezing diagonally between two blocked cells.
        if (di && dj && (nav.blocked[cj * nav.cols + ni] || nav.blocked[nj * nav.cols + ci])) continue;
        prev[n] = c;
        queue[tail++] = n;
      }
    }
  }
  if (found < 0) return null;
  const cells: { x: number; y: number }[] = [];
  for (let c = found; c !== -1; c = prev[c]) {
    const ci = c % nav.cols;
    cells.push({ x: (ci + 0.5) * CELL, y: ((c - ci) / nav.cols + 0.5) * CELL });
  }
  cells.reverse();
  cells[0] = { x: sx, y: sy };
  if (lineClear(nav, cells[cells.length - 1].x, cells[cells.length - 1].y, gx, gy)) cells.push({ x: gx, y: gy });
  // String-pulling: keep only the corners that line-of-sight cannot skip.
  const points = [cells[0]];
  let anchor = 0;
  while (anchor < cells.length - 1) {
    let next = cells.length - 1;
    while (next > anchor + 1 && !lineClear(nav, cells[anchor].x, cells[anchor].y, cells[next].x, cells[next].y)) next--;
    points.push(cells[next]);
    anchor = next;
  }
  let length = 0;
  for (let i = 1; i < points.length; i++) length += dist(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y);
  return { points, length };
}

function reachableFraction(nav: Nav, sx: number, sy: number): number {
  const start = cellOf(nav, sx, sy);
  if (nav.blocked[start]) return 0;
  const seen = new Uint8Array(nav.blocked.length);
  const stack = [start];
  seen[start] = 1;
  let count = 0;
  let free = 0;
  for (let i = 0; i < nav.blocked.length; i++) if (!nav.blocked[i]) free++;
  while (stack.length) {
    const c = stack.pop()!;
    count++;
    const ci = c % nav.cols;
    const cj = (c - ci) / nav.cols;
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [di, dj] of nb) {
      const ni = ci + di;
      const nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= nav.cols || nj >= nav.rows) continue;
      const n = nj * nav.cols + ni;
      if (!seen[n] && !nav.blocked[n]) { seen[n] = 1; stack.push(n); }
    }
  }
  return count / Math.max(1, free);
}

/**
 * Structural validation of a generated level: bounds, overlaps, objective logic and
 * geometric reachability. Dynamic solvability is checked separately by the solver.
 */
export function validateLevel(level: Level): ValidationReport {
  const errors: string[] = [];
  const { w: W, h: H } = level.arena;
  const o = level.objective;

  // --- Arena bounds -------------------------------------------------------------------
  for (const b of level.bodies) {
    if (b.x < b.radius || b.y < b.radius || b.x > W - b.radius || b.y > H - b.radius) errors.push(`body ${b.id} outside arena`);
  }
  for (const t of level.targets) {
    if (t.x < t.radius || t.y < t.radius || t.x > W - t.radius || t.y > H - t.radius) errors.push(`target ${t.id} outside arena`);
  }
  for (const wl of level.walls) {
    const ax = wl.motion?.axis === 'x' ? wl.motion.amplitude : 0;
    const ay = wl.motion?.axis === 'y' ? wl.motion.amplitude : 0;
    if (wl.x - ax < -1 || wl.y - ay < -1 || wl.x + wl.w + ax > W + 1 || wl.y + wl.h + ay > H + 1) errors.push('wall outside arena');
    if (wl.w < 16 || wl.h < 16) errors.push('wall too thin for stable collisions');
  }
  for (const bp of level.bumpers) {
    if (bp.x < bp.radius || bp.y < bp.radius || bp.x > W - bp.radius || bp.y > H - bp.radius) errors.push('bumper outside arena');
  }

  // --- Overlaps -----------------------------------------------------------------------
  for (const b of level.bodies) {
    const clear = b.radius + 8;
    if (level.walls.some((wl) => !wl.gate && circleRect(b.x, b.y, clear + (wl.motion ? wl.motion.amplitude : 0), wl))) errors.push(`body ${b.id} starts inside a wall`);
    if (level.bumpers.some((bp) => dist(b.x, b.y, bp.x, bp.y) < clear + bp.radius)) errors.push(`body ${b.id} starts on a bumper`);
    for (const h of level.hazards) {
      const reach = (h.motion ? h.motion.amplitude : 0) + 40 + b.radius;
      const hit = h.shape === 'circle' ? dist(b.x, b.y, h.x, h.y) < h.r + reach : circleRect(b.x, b.y, reach, h);
      if (hit) errors.push(`body ${b.id} starts too close to a hazard`);
    }
    for (const other of level.bodies) {
      if (other !== b && dist(b.x, b.y, other.x, other.y) < b.radius + other.radius + 4) errors.push('bodies overlap');
    }
  }
  for (const t of level.targets) {
    if (level.walls.some((wl) => circleRect(t.x, t.y, t.radius * 0.8, wl))) errors.push(`target ${t.id} overlaps a wall`);
    if (level.bumpers.some((bp) => dist(t.x, t.y, bp.x, bp.y) < t.radius + bp.radius + 6)) errors.push(`target ${t.id} overlaps a bumper`);
    for (const h of level.hazards) {
      const reach = (h.motion ? h.motion.amplitude : 0) + t.radius + 14;
      const hit = h.shape === 'circle' ? dist(t.x, t.y, h.x, h.y) < h.r + reach : circleRect(t.x, t.y, reach, h);
      if (hit) errors.push(`target ${t.id} overlaps a hazard`);
    }
    for (const other of level.targets) {
      if (other !== t && dist(t.x, t.y, other.x, other.y) < t.radius + other.radius + 30) errors.push('targets overlap');
    }
  }
  for (const bp of level.bumpers) {
    if (level.walls.some((wl) => circleRect(bp.x, bp.y, bp.radius + 30, wl))) errors.push('bumper pinches a wall');
  }

  // --- Objective logic ----------------------------------------------------------------
  const ids = new Set(level.bodies.map((b) => b.id));
  if (o.required.length === 0) errors.push('objective has no required bodies');
  for (const id of o.required) if (!ids.has(id)) errors.push(`required body ${id} missing`);
  for (const t of level.targets) if (t.accepts && !ids.has(t.accepts)) errors.push(`target ${t.id} accepts unknown body`);
  if ((o.type === 'deliver' || o.type === 'sync') && level.targets.length < o.required.length) errors.push('fewer targets than required bodies');
  if (o.type === 'sync' && (o.required.length < 2 || !(o.window! > 0))) errors.push('sync needs two bodies and a window');
  if (o.type === 'collect' && level.targets.length < 2) errors.push('collect needs several targets');
  if (o.type === 'survive' && !(o.duration! > 0 && o.duration! <= o.timeLimit)) errors.push('survive duration invalid');
  const toolTotal = Object.values(level.tools).reduce((a, b) => a + b, 0);
  if (toolTotal < 1 || level.maxDevices < 1) errors.push('no usable devices');
  if (!(o.timeLimit > 1)) errors.push('time limit too short');

  // --- Reachability -------------------------------------------------------------------
  const routes: Route[] = [];
  let pathLength = 0;
  const addRoute = (bodyId: string, r: number, sx: number, sy: number, gx: number, gy: number, gr: number): boolean => {
    const nav = buildNav(level, r);
    const p = findPath(nav, sx, sy, gx, gy, gr);
    if (!p) { errors.push(`no route for ${bodyId}`); return false; }
    routes.push({ bodyId, points: p.points, length: p.length });
    pathLength += p.length;
    return true;
  };
  for (const b of level.bodies) {
    const nav = buildNav(level, b.radius);
    if (reachableFraction(nav, b.x, b.y) < 0.12) errors.push(`body ${b.id} is trapped`);
  }
  if (o.type === 'collect') {
    const b = level.bodies.find((x) => x.id === o.required[0]);
    if (b) {
      let cx = b.x;
      let cy = b.y;
      const left = [...level.targets];
      while (left.length) {
        left.sort((p, q) => dist(cx, cy, p.x, p.y) - dist(cx, cy, q.x, q.y));
        const t = left.shift()!;
        if (!addRoute(b.id, b.radius, cx, cy, t.x, t.y, t.radius * 0.6)) break;
        cx = t.x;
        cy = t.y;
      }
    }
  } else if (o.type !== 'survive') {
    const taken = new Set<string>();
    for (const id of o.required) {
      const b = level.bodies.find((x) => x.id === id);
      if (!b) continue;
      const options = level.targets.filter((t) => !taken.has(t.id) && (!t.accepts || t.accepts === id));
      options.sort((p, q) => dist(b.x, b.y, p.x, p.y) - dist(b.x, b.y, q.x, q.y));
      const t = options[0];
      if (!t) { errors.push(`no target for ${id}`); continue; }
      taken.add(t.id);
      if (b.inert) {
        // Chain reaction: a helper must be able to reach the payload first.
        const striker = level.bodies.find((x) => !x.inert);
        if (!striker) errors.push('shielded payload has no striker');
        else addRoute(striker.id, striker.radius, striker.x, striker.y, b.x, b.y, b.radius + striker.radius + 24);
      }
      addRoute(b.id, b.radius, b.x, b.y, t.x, t.y, t.radius * 0.6);
    }
  }

  return { ok: errors.length === 0, errors, routes, pathLength };
}
