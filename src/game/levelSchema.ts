import { Level } from './level';

/**
 * Structural check for a level that arrives as untrusted JSON (shared unlimited replays).
 * It guarantees the simulation can run on it safely and in bounded time. It does not claim
 * the level came from the generator.
 */
export function checkLevelShape(raw: unknown): { ok: true; level: Level } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const fail = (m: string) => { errors.push(m); };
  const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const arr = (v: unknown, max: number): v is any[] => Array.isArray(v) && v.length <= max && v.every((x) => x && typeof x === 'object');
  const osc = (m: unknown) => m === undefined || (typeof m === 'object' && m !== null
    && ((m as any).axis === 'x' || (m as any).axis === 'y') && num((m as any).amplitude, 0, 1000) && num((m as any).period, 0.2, 120) && num((m as any).phase, -1000, 1000));
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['level must be an object'] };
  const l = raw as Record<string, any>;
  if (!l.arena || l.arena.w !== 1000 || l.arena.h !== 640) fail('arena must be 1000 x 640');
  if (!num(l.drag, 0, 20)) fail('invalid drag');
  if (!arr(l.bodies, 6) || l.bodies.length < 1) fail('invalid bodies');
  else for (const b of l.bodies) {
    if (typeof b.id !== 'string' || !num(b.x, 0, 1000) || !num(b.y, 0, 640) || !num(b.vx, -1200, 1200) || !num(b.vy, -1200, 1200)
      || !num(b.mass, 0.1, 50) || !num(b.radius, 4, 60) || !num(b.restitution, 0, 1)) fail('invalid body');
  }
  if (!arr(l.walls, 80)) fail('invalid walls');
  else for (const w of l.walls) {
    if (!num(w.x, -200, 1200) || !num(w.y, -200, 840) || !num(w.w, 1, 1400) || !num(w.h, 1, 1000) || !osc(w.motion)) fail('invalid wall');
    if (w.gate !== undefined && !(w.gate && num(w.gate.period, 0.2, 120) && num(w.gate.openFraction, 0, 1) && num(w.gate.phase, -1000, 1000))) fail('invalid gate');
  }
  if (!arr(l.bumpers, 40)) fail('invalid bumpers');
  else for (const b of l.bumpers) if (!num(b.x, 0, 1000) || !num(b.y, 0, 640) || !num(b.radius, 4, 120) || !num(b.kick, 0, 2000)) fail('invalid bumper');
  if (!arr(l.hazards, 60)) fail('invalid hazards');
  else for (const h of l.hazards) {
    if ((h.shape !== 'rect' && h.shape !== 'circle') || !num(h.x, -200, 1200) || !num(h.y, -200, 840) || !num(h.w, 0, 1400) || !num(h.h, 0, 1000) || !num(h.r, 0, 400) || !osc(h.motion)) fail('invalid hazard');
  }
  if (!arr(l.zones, 20)) fail('invalid zones');
  else for (const z of l.zones) {
    if (!['gel', 'ice', 'wind'].includes(z.kind as string) || !num(z.x, -200, 1200) || !num(z.y, -200, 840) || !num(z.w, 1, 1400) || !num(z.h, 1, 1000)) fail('invalid zone');
    for (const k of ['drag', 'fx', 'fy']) if (z[k] !== undefined && !num(z[k], -5000, 5000)) fail('invalid zone value');
  }
  if (!arr(l.targets, 12) || l.targets.length < 1) fail('invalid targets');
  else for (const t of l.targets) {
    if (typeof t.id !== 'string' || !num(t.x, 0, 1000) || !num(t.y, 0, 640) || !num(t.radius, 4, 200)) fail('invalid target');
    if (t.accepts !== undefined && typeof t.accepts !== 'string') fail('invalid target');
    if (t.maxSpeed !== undefined && !num(t.maxSpeed, 1, 5000)) fail('invalid target');
  }
  const o = l.objective;
  if (!o || !['deliver', 'collect', 'sync', 'survive'].includes(o.type) || !Array.isArray(o.required) || o.required.length < 1 || o.required.length > 6
    || !o.required.every((r: unknown) => typeof r === 'string') || !num(o.timeLimit, 1, 90)) fail('invalid objective');
  else {
    if (o.window !== undefined && !num(o.window, 0.05, 60)) fail('invalid sync window');
    if (o.duration !== undefined && !num(o.duration, 1, 90)) fail('invalid duration');
    if (o.type === 'sync' && o.window === undefined) fail('sync needs a window');
    if (o.type === 'survive' && o.duration === undefined) fail('survive needs a duration');
  }
  const t = l.tools;
  if (!t || !['attractor', 'repulsor', 'vortex', 'field'].every((k) => Number.isInteger(t[k]) && t[k] >= 0 && t[k] <= 4)) fail('invalid tools');
  if (!Number.isInteger(l.maxDevices) || l.maxDevices < 1 || l.maxDevices > 8) fail('invalid maxDevices');
  if (!num(l.strengthCap, 40, 900)) fail('invalid strengthCap');
  if (!l.par || !num(l.par.time, 0.1, 1000) || !num(l.par.energy, 1, 1e9)) fail('invalid par');
  for (const k of ['id', 'title', 'template']) if (typeof l[k] !== 'string' || l[k].length > 80) fail(`invalid ${k}`);
  if (!num(l.seed, 0, 0xffffffff) || !num(l.difficulty, 0, 5)) fail('invalid seed or difficulty');
  for (const k of ['modifiers', 'rules']) if (!Array.isArray(l[k]) || l[k].length > 12 || !l[k].every((x: unknown) => typeof x === 'string' && x.length <= 120)) fail(`invalid ${k}`);
  if (errors.length) return { ok: false, errors: Array.from(new Set(errors)) };
  return { ok: true, level: raw as Level };
}
