import { RNG } from '../core/rng';
import { ARENA_H, ARENA_W, Level, TargetDef } from '../game/level';
import { BodyDef, DEVICE_LIMITS } from '../physics/types';
import { circleRect, clamp, dist, Rect, rectRect } from './geometry';
import { ChallengeSpec, MODIFIER_INFO, ModifierId, TEMPLATES } from './spec';

const W = ARENA_W;
const H = ARENA_H;
const BASE_DRAG = 0.55;

/**
 * Templates describe the *structure* of a challenge. Each one lays out the essential pieces
 * (start, goal, the obstacle that creates the puzzle); modifiers then decorate the result.
 * All coordinates are produced from the seeded RNG and are later mirrored for extra variety.
 */
class Builder {
  level: Level;
  /** Areas decoration must stay out of: starts, targets and key corridors. */
  keepouts: { x: number; y: number; r: number }[] = [];

  constructor(readonly spec: ChallengeSpec, readonly rng: RNG) {
    const info = TEMPLATES[spec.template];
    this.level = {
      id: `lvl-${spec.seed}`, seed: spec.seed, title: spec.title, template: spec.template,
      difficulty: spec.difficulty, arena: { w: W, h: H }, drag: BASE_DRAG,
      bodies: [], walls: [], bumpers: [], hazards: [], zones: [], targets: [],
      objective: { type: info.objective, required: [], timeLimit: 12 },
      tools: { ...spec.tools }, maxDevices: spec.maxDevices, strengthCap: DEVICE_LIMITS.strength.max,
      modifiers: [...spec.modifiers], rules: [], par: { time: 5, energy: 100000 }, verified: false,
    };
  }

  has(m: ModifierId): boolean {
    return this.spec.modifiers.includes(m);
  }

  body(id: string, x: number, y: number, hue: number, extra: Partial<BodyDef> = {}): BodyDef {
    let mass = 1;
    let radius = 13;
    if (this.has('heavy')) { mass = 2.6; radius = 17; }
    if (this.has('light')) { mass = 0.45; radius = 10; }
    const b: BodyDef = { id, x, y, vx: 0, vy: 0, mass, radius, restitution: 0.6, hue, ...extra };
    this.level.bodies.push(b);
    this.keepouts.push({ x, y, r: 70 });
    return b;
  }

  target(id: string, x: number, y: number, radius: number, extra: Partial<TargetDef> = {}): TargetDef {
    const t: TargetDef = { id, x, y, radius, ...extra };
    this.level.targets.push(t);
    this.keepouts.push({ x, y, r: radius + 45 });
    return t;
  }

  wall(x: number, y: number, w: number, h: number): void {
    this.level.walls.push({ x, y, w, h });
  }

  /** True if a circle is clear of everything placed so far. */
  free(x: number, y: number, r: number): boolean {
    if (x < r + 20 || y < r + 20 || x > W - r - 20 || y > H - r - 20) return false;
    const L = this.level;
    if (this.keepouts.some((k) => dist(x, y, k.x, k.y) < r + k.r)) return false;
    if (L.walls.some((w) => circleRect(x, y, r + 34 + (w.motion ? w.motion.amplitude : 0), w))) return false;
    if (L.bumpers.some((b) => dist(x, y, b.x, b.y) < r + b.radius + 60)) return false;
    if (L.hazards.some((h) => (h.shape === 'circle' ? dist(x, y, h.x, h.y) < r + h.r + 62 : circleRect(x, y, r + 62, h)))) return false;
    return true;
  }

  spot(r: number, region: Rect = { x: 200, y: 40, w: 600, h: 560 }, tries = 40): { x: number; y: number } | null {
    for (let i = 0; i < tries; i++) {
      const x = this.rng.range(region.x, region.x + region.w);
      const y = this.rng.range(region.y, region.y + region.h);
      if (this.free(x, y, r)) return { x, y };
    }
    return null;
  }

  rectFree(q: Rect): boolean {
    return (
      !this.keepouts.some((k) => circleRect(k.x, k.y, k.r, q)) &&
      !this.level.walls.some((w) => rectRect(w, q, 50)) &&
      q.x > 30 && q.y >= 0 && q.x + q.w < W - 30 && q.y + q.h <= H
    );
  }
}

type TemplateFn = (b: Builder) => void;

const TEMPLATE_FNS: Record<string, TemplateFn> = {
  /** A block or two sits on the straight line, so the path has to bend. */
  direct(b) {
    const { rng } = b;
    const s = { x: rng.range(90, 170), y: rng.range(120, 520) };
    const t = { x: rng.range(830, 910), y: rng.range(120, 520) };
    b.body('a', s.x, s.y, 0);
    b.target('t0', t.x, t.y, 32);
    const blocks = 1 + (b.spec.difficulty >= 3 ? 1 : 0) + (b.spec.difficulty >= 5 ? 1 : 0);
    for (let i = 0; i < blocks; i++) {
      for (let tries = 0; tries < 12; tries++) {
        const f = blocks === 1 ? rng.range(0.4, 0.6) : 0.28 + (0.44 * i) / (blocks - 1) + rng.range(-0.05, 0.05);
        const cx = s.x + (t.x - s.x) * f;
        const cy = s.y + (t.y - s.y) * f + rng.range(-50, 50);
        const tall = rng.chance(0.7);
        const w = tall ? rng.range(28, 44) : rng.range(120, 190);
        const h = tall ? rng.range(170, 280) : rng.range(28, 44);
        const q = { x: cx - w / 2, y: clamp(cy - h / 2, 20, H - h - 20), w, h };
        if (b.rectFree(q)) { b.wall(q.x, q.y, q.w, q.h); break; }
      }
    }
  },

  /** A full-height wall with a single gap; a second staggered wall at higher difficulty. */
  narrow(b) {
    const { rng } = b;
    const d = b.spec.difficulty;
    const body = b.body('a', rng.range(90, 160), 0, 0);
    const gap = body.radius * 2 * (3.6 - 0.3 * d);
    const two = d >= 3;
    const x1 = two ? rng.range(330, 400) : rng.range(430, 560);
    const g1 = rng.range(90, H - 90 - gap);
    const th = 26;
    b.wall(x1, 0, th, g1);
    b.wall(x1, g1 + gap, th, H - g1 - gap);
    b.keepouts.push({ x: x1 + th / 2, y: g1 + gap / 2, r: gap / 2 + 50 });
    // Start on the far side of the gap vertically so a straight shot never works.
    body.y = g1 + gap / 2 < H / 2 ? rng.range(H * 0.62, H - 80) : rng.range(80, H * 0.38);
    b.keepouts[0].y = body.y;
    let lastGap = g1 + gap / 2;
    if (two) {
      const x2 = x1 + rng.range(230, 290);
      const g2 = lastGap < H / 2 ? rng.range(H * 0.55, H - 90 - gap) : rng.range(90, H * 0.45 - gap);
      b.wall(x2, 0, th, g2);
      b.wall(x2, g2 + gap, th, H - g2 - gap);
      b.keepouts.push({ x: x2 + th / 2, y: g2 + gap / 2, r: gap / 2 + 50 });
      lastGap = g2 + gap / 2;
    }
    const ty = lastGap < H / 2 ? rng.range(H * 0.55, H - 90) : rng.range(90, H * 0.45);
    b.target('t0', rng.range(820, 900), ty, 32);
  },

  /** One object must sweep several targets arranged around the arena. */
  collect(b) {
    const { rng } = b;
    const n = clamp(2 + (b.spec.difficulty >= 2 ? 1 : 0) + (b.spec.difficulty >= 4 ? 1 : 0), 2, 4);
    b.body('a', rng.range(90, 150), rng.range(240, 400), 0);
    const cx = rng.range(540, 600);
    const cy = H / 2 + rng.range(-20, 20);
    const a0 = rng.range(0, Math.PI * 2);
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2 + rng.range(-0.25, 0.25);
      b.target(`t${i}`, clamp(cx + Math.cos(a) * rng.range(220, 290), 70, W - 70), clamp(cy + Math.sin(a) * rng.range(170, 215), 70, H - 70), 30);
    }
    // A central pillar stops one lazy attractor in the middle from doing everything.
    const pw = rng.range(50, 90);
    b.wall(cx - pw / 2, cy - pw / 2, pw, pw);
  },

  /** A small target that only accepts slow arrivals, with hazards waiting behind it. */
  precision(b) {
    const { rng } = b;
    const d = b.spec.difficulty;
    const s = { x: rng.range(90, 170), y: rng.range(120, 520) };
    const t = { x: rng.range(700, 800), y: rng.range(170, 470) };
    const body = b.body('a', s.x, s.y, 0);
    const maxSpeed = 150 - 12 * d;
    b.target('t0', t.x, t.y, body.radius + 15, { maxSpeed });
    b.level.objective.timeLimit = 16;
    b.level.rules.push(`Land slower than ${maxSpeed} u/s`);
    if (d >= 2) {
      const len = dist(s.x, s.y, t.x, t.y);
      const ux = (t.x - s.x) / len;
      const uy = (t.y - s.y) / len;
      const n = d >= 4 ? 3 : 2;
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 78;
        const hx = t.x + ux * 105 - uy * off;
        const hy = t.y + uy * 105 + ux * off;
        if (hx > 40 && hx < W - 40 && hy > 40 && hy < H - 40) b.level.hazards.push({ shape: 'circle', x: hx, y: hy, w: 0, h: 0, r: 24 });
      }
    }
    if (d >= 3) {
      const q = { x: (s.x + t.x) / 2 - 18, y: clamp((s.y + t.y) / 2 - 90, 20, H - 200), w: 36, h: 180 };
      if (b.rectFree(q)) b.wall(q.x, q.y, q.w, q.h);
    }
  },

  /** A dividing wall whose only gap is guarded by a cycling gate or a sliding block. */
  gate(b) {
    const { rng } = b;
    const d = b.spec.difficulty;
    const body = b.body('a', rng.range(90, 170), rng.range(140, 500), 0);
    const count = d >= 4 ? 2 : 1;
    const th = 26;
    const gap = 120;
    let x = count === 2 ? rng.range(320, 380) : rng.range(440, 540);
    for (let i = 0; i < count; i++) {
      const gy = rng.range(100, H - 100 - gap);
      b.wall(x, 0, th, gy);
      b.wall(x, gy + gap, th, H - gy - gap);
      b.keepouts.push({ x: x + th / 2, y: gy + gap / 2, r: gap / 2 + 60 });
      if (rng.chance(0.5)) {
        b.level.walls.push({
          x: x + 3, y: gy, w: th - 6, h: gap,
          gate: { period: rng.range(3, 4.2) - 0.2 * d, openFraction: 0.5 - 0.03 * d, phase: rng.range(0.5, 0.95) },
        });
      } else {
        // A block patrolling across the gap.
        b.level.walls.push({
          x: x - 12, y: gy + gap / 2 - 45, w: th + 24, h: 90,
          motion: { axis: 'y', amplitude: 95, period: rng.range(3.4, 4.6) - 0.2 * d, phase: rng.next() },
        });
      }
      x += rng.range(250, 300);
    }
    b.target('t0', rng.range(840, 910), rng.range(140, 500), 32);
    b.level.rules.push('Gates and patrols run on a fixed cycle');
    void body;
  },

  /** A scatter of hazards between start and goal with safe corridors between them. */
  avoid(b) {
    const { rng } = b;
    const d = b.spec.difficulty;
    b.body('a', rng.range(80, 140), rng.range(140, 500), 0);
    b.target('t0', rng.range(860, 920), rng.range(140, 500), 32);
    const s = b.level.bodies[0];
    const t = b.level.targets[0];
    const n = 3 + d;
    for (let i = 0; i < n; i++) {
      const r = rng.range(26, 44);
      let p: { x: number; y: number } | null = null;
      if (i < 2) {
        // The first hazards sit on the straight line, so there is never a free direct shot.
        const f = i === 0 ? rng.range(0.3, 0.42) : rng.range(0.58, 0.7);
        const c = { x: s.x + (t.x - s.x) * f, y: s.y + (t.y - s.y) * f + rng.range(-18, 18) };
        if (b.free(c.x, c.y, r)) p = c;
      }
      if (!p) p = b.spot(r, { x: 250, y: 50, w: 500, h: 540 });
      if (p) b.level.hazards.push({ shape: 'circle', x: p.x, y: p.y, w: 0, h: 0, r });
    }
  },

  /** Two or three objects with unequal journeys that must land together. */
  sync(b) {
    const { rng } = b;
    const d = b.spec.difficulty;
    const n = b.spec.objectCount;
    const lanes = n === 2 ? [0.27, 0.73] : [0.2, 0.5, 0.8];
    const order = rng.shuffle(lanes);
    for (let i = 0; i < n; i++) {
      const y = lanes[i] * H + rng.range(-25, 25);
      const extra = d >= 3 && i === 1 ? { mass: 2.2, radius: 16 } : {};
      b.body(`b${i}`, rng.range(90, 150), y, i, extra);
      // Deliberately different distances so equal treatment never syncs them.
      const tx = i % 2 === 0 ? rng.range(560, 680) : rng.range(820, 900);
      b.target(`t${i}`, tx, order[i] * H + rng.range(-25, 25), 30, { accepts: `b${i}` });
    }
    if (d >= 2 && n === 2) {
      const q = { x: rng.range(280, 360), y: H / 2 - 12, w: rng.range(200, 320), h: 24 };
      if (b.rectFree(q)) b.wall(q.x, q.y, q.w, q.h);
    }
    const window = Math.max(1, 2.4 - 0.28 * d);
    b.level.objective.window = Math.round(window * 10) / 10;
    b.level.objective.timeLimit = 14;
  },

  /** A striker must hit a device-immune payload into the target. */
  chain(b) {
    const { rng } = b;
    const d = b.spec.difficulty;
    const p = { x: rng.range(430, 540), y: rng.range(230, 410) };
    const theta = rng.range(-0.55, 0.55);
    const reach = rng.range(250, 320);
    const t = { x: p.x + Math.cos(theta) * reach, y: clamp(p.y + Math.sin(theta) * reach, 80, H - 80) };
    // The striker starts roughly behind the payload; the misalignment grows with difficulty.
    const back = theta + Math.PI + rng.sign() * rng.range(0.08, 0.14) * d;
    const sd = rng.range(240, 320);
    const s = { x: clamp(p.x + Math.cos(back) * sd, 70, W - 70), y: clamp(p.y + Math.sin(back) * sd, 70, H - 70) };
    b.body('striker', s.x, s.y, 0, { restitution: 0.6 });
    b.body('payload', p.x, p.y, 1, { inert: true, mass: 1, radius: 15 });
    b.target('t0', t.x, t.y, 40, { accepts: 'payload' });
    b.level.objective.required = ['payload'];
    b.level.drag = 0.42;
    b.level.rules.push('The amber payload is shielded from devices');
  },

  /** A tight cluster must be pulled apart into colour-matched targets. */
  split(b) {
    const { rng } = b;
    const n = b.spec.objectCount;
    const cx = rng.range(180, 260);
    const cy = H / 2 + rng.range(-40, 40);
    const spots = n === 2 ? [[0.2, 0.2], [0.2, 0.8]] : [[0.25, 0.16], [0.25, 0.84], [0.5, 0.5]];
    for (let i = 0; i < n; i++) {
      b.body(`b${i}`, cx + (i === 2 ? 46 : 0), cy + (i === 0 ? -34 : i === 1 ? 34 : 0), i);
      b.target(`t${i}`, W - spots[i][0] * W * rng.range(0.6, 1.1), spots[i][1] * H + rng.range(-20, 20), 32, { accepts: `b${i}` });
    }
    if (b.spec.difficulty >= 3) {
      const q = { x: rng.range(500, 580), y: H / 2 - 70, w: 30, h: 140 };
      if (b.rectFree(q)) b.wall(q.x, q.y, q.w, q.h);
    }
    b.level.objective.timeLimit = 14;
  },

  /** A runaway object on a frictionless floor must be kept away from plasma. */
  survive(b) {
    const { rng } = b;
    const d = b.spec.difficulty;
    const a = rng.range(0, Math.PI * 2);
    const speed = rng.range(230, 290);
    b.body('a', W / 2 + rng.range(-60, 60), H / 2 + rng.range(-40, 40), 0, { vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, restitution: 0.95 });
    b.keepouts[0].r = 130;
    const corners = [[0, 0], [W, 0], [0, H], [W, H]];
    for (const [x, y] of corners) b.level.hazards.push({ shape: 'circle', x: x === 0 ? 30 : W - 30, y: y === 0 ? 30 : H - 30, w: 0, h: 0, r: rng.range(62, 84) });
    const extra = 1 + Math.ceil(d / 2);
    for (let i = 0; i < extra; i++) {
      const r = rng.range(26, 38);
      const p = b.spot(r, { x: 120, y: 60, w: 760, h: 520 });
      if (p) b.level.hazards.push({ shape: 'circle', x: p.x, y: p.y, w: 0, h: 0, r });
    }
    b.level.drag = 0.02;
    const duration = 8 + d;
    b.level.objective.duration = duration;
    b.level.objective.timeLimit = duration + 1;
    b.level.rules.push('Frictionless floor: the object never slows down');
  },
};

/** Environmental modifiers layered on top of a template. */
function applyModifiers(b: Builder): void {
  const { rng, level } = b;
  const body = level.bodies[0];
  const goal = level.targets[0] ?? { x: W / 2, y: H / 2 };

  if (b.has('bumpers')) {
    const n = rng.int(2, 3);
    for (let i = 0; i < n; i++) {
      const r = rng.range(20, 28);
      const p = b.spot(r);
      if (p) level.bumpers.push({ x: p.x, y: p.y, radius: r, kick: 220 });
    }
  }
  if (b.has('hazards')) {
    const n = rng.int(2, 3);
    for (let i = 0; i < n; i++) {
      const r = rng.range(22, 34);
      const p = b.spot(r);
      if (p) level.hazards.push({ shape: 'circle', x: p.x, y: p.y, w: 0, h: 0, r });
    }
  }
  if (b.has('movers')) {
    if (level.template === 'avoid' || level.template === 'survive') {
      const p = b.spot(30, { x: 300, y: 200, w: 400, h: 240 });
      if (p) level.hazards.push({ shape: 'circle', x: p.x, y: p.y, w: 0, h: 0, r: 26, motion: { axis: rng.chance(0.5) ? 'x' : 'y', amplitude: 90, period: rng.range(3.5, 5), phase: rng.next() } });
    } else {
      for (let tries = 0; tries < 20; tries++) {
        const x = rng.range(300, 700);
        const y = rng.range(190, H - 190 - 120);
        const q = { x, y: y - 140, w: 24, h: 120 + 280 };
        if (b.rectFree(q)) {
          level.walls.push({ x, y, w: 24, h: 120, motion: { axis: 'y', amplitude: 130, period: rng.range(3.2, 4.8), phase: rng.next() } });
          break;
        }
      }
    }
  }
  if (b.has('gel')) {
    const w = rng.range(170, 240);
    const around = level.template === 'precision' || rng.chance(0.4);
    const x = around ? clamp(goal.x - w / 2, 20, W - w - 20) : rng.range(300, 620);
    level.zones.push({ kind: 'gel', x, y: 0, w, h: H, drag: 3.2 });
  }
  if (b.has('ice')) {
    const w = rng.range(260, 380);
    level.zones.push({ kind: 'ice', x: rng.range(240, W - w - 160), y: 0, w, h: H, drag: 0 });
  }
  if (b.has('crosswind')) {
    const w = rng.range(170, 250);
    level.zones.push({ kind: 'wind', x: rng.range(330, 650 - w / 2), y: 0, w, h: H, fx: 0, fy: rng.sign() * rng.range(150, 230) });
  }
  if (b.has('frictionless')) level.drag = 0.03;
  if (b.has('launched') && body && !(body.vx || body.vy)) {
    const len = dist(body.x, body.y, goal.x, goal.y) || 1;
    const sgn = rng.sign();
    const sp = rng.range(170, 240);
    body.vx = (-(goal.y - body.y) / len) * sp * sgn;
    body.vy = ((goal.x - body.x) / len) * sp * sgn;
  }
  if (b.has('tightClock')) level.objective.timeLimit = Math.round(level.objective.timeLimit * 0.6);
  if (b.has('lowPower')) level.strengthCap = 450;

  for (const m of b.spec.modifiers) {
    let rule = MODIFIER_INFO[m].rule;
    if (m === 'lowPower') rule = `Device strength capped at ${level.strengthCap}`;
    if (m === 'tightClock') rule = `Tight clock: ${level.objective.timeLimit}s limit`;
    if (!level.rules.includes(rule)) level.rules.push(rule);
  }
}

/** Mirror the finished layout so the same structure does not always read left-to-right. */
function mirror(level: Level, flipX: boolean, flipY: boolean): void {
  const fx = (x: number, w = 0) => (flipX ? W - x - w : x);
  const fy = (y: number, h = 0) => (flipY ? H - y - h : y);
  for (const b of level.bodies) { b.x = fx(b.x); b.y = fy(b.y); if (flipX) b.vx = -b.vx; if (flipY) b.vy = -b.vy; }
  for (const t of level.targets) { t.x = fx(t.x); t.y = fy(t.y); }
  for (const w of level.walls) { w.x = fx(w.x, w.w); w.y = fy(w.y, w.h); }
  for (const p of level.bumpers) { p.x = fx(p.x); p.y = fy(p.y); }
  for (const h of level.hazards) { h.x = fx(h.x, h.shape === 'rect' ? h.w : 0); h.y = fy(h.y, h.shape === 'rect' ? h.h : 0); }
  for (const z of level.zones) {
    z.x = fx(z.x, z.w); z.y = fy(z.y, z.h);
    if (flipX && z.fx) z.fx = -z.fx;
    if (flipY && z.fy) z.fy = -z.fy;
  }
}

/** Build one candidate layout for a spec. Deterministic for a given (spec, candidate seed). */
export function buildCandidate(spec: ChallengeSpec, candidateSeed: number): Level {
  const rng = new RNG(candidateSeed);
  const b = new Builder(spec, rng);
  TEMPLATE_FNS[spec.template](b);
  if (b.level.objective.required.length === 0) b.level.objective.required = b.level.bodies.map((x) => x.id);
  applyModifiers(b);
  mirror(b.level, rng.chance(0.5), rng.chance(0.5));
  // Round coordinates so serialised levels are compact and stable.
  const r1 = (v: number) => Math.round(v * 10) / 10;
  for (const x of b.level.bodies) { x.x = r1(x.x); x.y = r1(x.y); x.vx = r1(x.vx); x.vy = r1(x.vy); }
  for (const x of b.level.targets) { x.x = r1(x.x); x.y = r1(x.y); }
  for (const x of b.level.walls) { x.x = r1(x.x); x.y = r1(x.y); x.w = r1(x.w); x.h = r1(x.h); }
  for (const x of b.level.bumpers) { x.x = r1(x.x); x.y = r1(x.y); x.radius = r1(x.radius); }
  for (const x of b.level.hazards) { x.x = r1(x.x); x.y = r1(x.y); x.r = r1(x.r); }
  for (const x of b.level.zones) { x.x = r1(x.x); x.y = r1(x.y); x.w = r1(x.w); x.h = r1(x.h); }
  return b.level;
}
