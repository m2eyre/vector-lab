import { describe, expect, it } from 'vitest';
import { deviceForce } from '../src/physics/forces';
import { gateIsOpen, Simulation, triangle } from '../src/physics/simulation';
import { BodyDef, Device, DT, PhysicsScene } from '../src/physics/types';

const body = (o: Partial<BodyDef> = {}): BodyDef => ({ id: 'a', x: 500, y: 320, vx: 0, vy: 0, mass: 1, radius: 13, restitution: 0.6, hue: 0, ...o });
const scene = (o: Partial<PhysicsScene> = {}): PhysicsScene => ({ arena: { w: 1000, h: 640 }, drag: 0, bodies: [body()], walls: [], bumpers: [], hazards: [], zones: [], ...o });
const dev = (o: Partial<Device>): Device => ({ id: 1, type: 'attractor', x: 500, y: 320, strength: 400, range: 200, angle: 0, spin: 1, ...o });
const run = (sim: Simulation, seconds: number) => { for (let i = 0; i < Math.round(seconds / DT); i++) sim.step(); };

describe('integration', () => {
  it('moves a free body at constant velocity (Newton I)', () => {
    const sim = new Simulation(scene({ bodies: [body({ x: 100, vx: 100 })] }), []);
    run(sim, 2);
    expect(sim.bodies[0].x).toBeCloseTo(300, 6);
    expect(sim.bodies[0].vx).toBeCloseTo(100, 9);
  });

  it('applies a = F / m', () => {
    const field = dev({ type: 'field', strength: 300, range: 300 });
    const light = new Simulation(scene({ bodies: [body({ mass: 1 })] }), [field]);
    const heavy = new Simulation(scene({ bodies: [body({ mass: 3 })] }), [field]);
    light.step(); heavy.step();
    expect(light.bodies[0].ax).toBeCloseTo(300, 9);
    expect(heavy.bodies[0].ax).toBeCloseTo(100, 9);
    expect(light.bodies[0].vx).toBeCloseTo(300 * DT, 9);
  });

  it('drag slows a body and never reverses it', () => {
    const sim = new Simulation(scene({ drag: 0.55, bodies: [body({ x: 100, vx: 200 })] }), []);
    run(sim, 3);
    expect(sim.bodies[0].vx).toBeGreaterThan(0);
    expect(sim.bodies[0].vx).toBeLessThan(200 * Math.exp(-0.55 * 3) * 1.02);
  });

  it('is deterministic and reset() restores the initial state', () => {
    const mk = () => new Simulation(
      scene({ drag: 0.3, bodies: [body({ x: 200, y: 200, vx: 120, vy: 60 }), body({ id: 'b', x: 600, y: 400, mass: 2 })], walls: [{ x: 480, y: 100, w: 30, h: 200 }], bumpers: [{ x: 700, y: 200, radius: 24, kick: 200 }] }),
      [dev({ x: 520, y: 380, range: 380 }), dev({ id: 2, type: 'vortex', x: 300, y: 300, range: 250 })],
    );
    const a = mk(); const b = mk();
    run(a, 6); run(b, 6);
    expect(a.bodies.map((x) => [x.x, x.y, x.vx, x.vy])).toEqual(b.bodies.map((x) => [x.x, x.y, x.vx, x.vy]));
    expect(a.energy).toBe(b.energy);
    const snapshot = a.bodies.map((x) => [x.x, x.y]);
    a.reset();
    expect(a.time).toBe(0);
    expect(a.bodies[0].x).toBe(200);
    run(a, 6);
    expect(a.bodies.map((x) => [x.x, x.y])).toEqual(snapshot);
  });

  it('stays numerically stable in a strong frictionless attractor', () => {
    const sim = new Simulation(scene({ bodies: [body({ x: 380, vy: 150 })] }), [dev({ strength: 900, range: 400 })]);
    let maxSpeed = 0;
    for (let i = 0; i < 120 * 60; i++) {
      sim.step();
      const b = sim.bodies[0];
      maxSpeed = Math.max(maxSpeed, Math.hypot(b.vx, b.vy));
      expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
    }
    // A bound orbit must not gain energy over a simulated minute.
    expect(maxSpeed).toBeLessThan(600);
    expect(Math.hypot(sim.bodies[0].x - 500, sim.bodies[0].y - 320)).toBeLessThan(400);
  });
});

describe('force generators', () => {
  const f = { x: 0, y: 0 };
  it('attractor pulls in, repulsor pushes out, both vanish outside their range', () => {
    deviceForce(dev({}), 600, 320, f);
    expect(f.x).toBeLessThan(0); expect(f.y).toBeCloseTo(0);
    deviceForce(dev({ type: 'repulsor' }), 600, 320, f);
    expect(f.x).toBeGreaterThan(0);
    deviceForce(dev({}), 701, 320, f);
    expect(f.x).toBe(0);
    deviceForce(dev({ type: 'repulsor' }), 500, 320, f);
    expect(Number.isFinite(f.x)).toBe(true);
  });
  it('force grows with strength and is stronger near the centre', () => {
    deviceForce(dev({ strength: 200 }), 600, 320, f); const weak = Math.abs(f.x);
    deviceForce(dev({ strength: 800 }), 600, 320, f); const strong = Math.abs(f.x);
    expect(strong).toBeCloseTo(weak * 4, 6);
    deviceForce(dev({}), 540, 320, f); const near = Math.abs(f.x);
    deviceForce(dev({}), 690, 320, f); const far = Math.abs(f.x);
    expect(near).toBeGreaterThan(far);
  });
  it('vortex is mostly tangential and flips with spin', () => {
    deviceForce(dev({ type: 'vortex', spin: 1 }), 600, 320, f);
    expect(f.y).toBeLessThan(0); // counter-clockwise on screen: up when to the right
    expect(Math.abs(f.y)).toBeGreaterThan(Math.abs(f.x));
    deviceForce(dev({ type: 'vortex', spin: -1 }), 600, 320, f);
    expect(f.y).toBeGreaterThan(0);
  });
  it('directional field is uniform inside its strip and follows its angle', () => {
    const d = dev({ type: 'field', angle: Math.PI / 2, strength: 250, range: 150 });
    deviceForce(d, 500, 400, f);
    expect(f.x).toBeCloseTo(0, 6); expect(f.y).toBeCloseTo(250, 6);
    deviceForce(d, 520, 250, f);
    expect(f.y).toBeCloseTo(250, 6);
    deviceForce(d, 700, 320, f);
    expect(f.x).toBe(0); expect(f.y).toBe(0);
  });
  it('shielded bodies ignore devices', () => {
    const sim = new Simulation(scene({ bodies: [body({ x: 600, inert: true })] }), [dev({})]);
    run(sim, 1);
    expect(sim.bodies[0].x).toBe(600);
  });
});

describe('collisions', () => {
  it('keeps bodies inside the arena', () => {
    const sim = new Simulation(scene({ bodies: [body({ vx: 1100, vy: 900 })] }), []);
    for (let i = 0; i < 1200; i++) {
      sim.step();
      const b = sim.bodies[0];
      expect(b.x).toBeGreaterThanOrEqual(b.radius - 1e-6); expect(b.x).toBeLessThanOrEqual(1000 - b.radius + 1e-6);
      expect(b.y).toBeGreaterThanOrEqual(b.radius - 1e-6); expect(b.y).toBeLessThanOrEqual(640 - b.radius + 1e-6);
    }
  });
  it('does not tunnel through a thin wall at maximum speed', () => {
    const sim = new Simulation(scene({ bodies: [body({ x: 100, radius: 10, vx: 1200 })], walls: [{ x: 500, y: 0, w: 16, h: 640 }] }), []);
    for (let i = 0; i < 600; i++) { sim.step(); expect(sim.bodies[0].x).toBeLessThan(500); }
    expect(sim.bodies[0].vx !== 1200).toBe(true);
  });
  it('conserves momentum in body-body collisions', () => {
    const sim = new Simulation(scene({ bodies: [body({ x: 300, vx: 200, mass: 1 }), body({ id: 'b', x: 500, mass: 3, radius: 18 })] }), []);
    run(sim, 1.5);
    const [a, b] = sim.bodies;
    expect(a.vx * a.mass + b.vx * b.mass).toBeCloseTo(200, 6);
    expect(b.vx).toBeGreaterThan(0);
    expect(a.vx).toBeLessThan(0); // the light body rebounds off the heavy one
  });
  it('bumpers add speed', () => {
    const sim = new Simulation(scene({ bodies: [body({ x: 300, vx: 100 })], bumpers: [{ x: 500, y: 320, radius: 25, kick: 220 }] }), []);
    run(sim, 2.2);
    expect(sim.bodies[0].vx).toBeLessThan(-250);
  });
  it('hazards destroy bodies', () => {
    const sim = new Simulation(scene({ bodies: [body({ x: 300, vx: 200 })], hazards: [{ shape: 'circle', x: 500, y: 320, w: 0, h: 0, r: 30 }] }), []);
    run(sim, 2);
    expect(sim.bodies[0].destroyed).toBe(true);
    expect(sim.bodies[0].active).toBe(false);
  });
  it('gates block when closed and pass when open', () => {
    const gate = { period: 4, openFraction: 0.5, phase: 0 };
    expect(gateIsOpen(gate, 1)).toBe(true);
    expect(gateIsOpen(gate, 3)).toBe(false);
    const mk = (phase: number) => new Simulation(scene({ bodies: [body({ x: 300, vx: 300 })], walls: [{ x: 500, y: 0, w: 26, h: 640, gate: { ...gate, phase } }] }), []);
    const open = mk(0); run(open, 1.5);
    expect(open.bodies[0].x).toBeGreaterThan(526);
    const closed = mk(0.5); run(closed, 1.5);
    expect(closed.bodies[0].x).toBeLessThan(500);
  });
  it('moving walls follow a triangle wave', () => {
    expect(triangle(0)).toBe(1); expect(triangle(0.5)).toBe(-1); expect(triangle(0.25)).toBe(0);
    const sim = new Simulation(scene({ bodies: [body({ x: 100, y: 100 })], walls: [{ x: 500, y: 300, w: 24, h: 100, motion: { axis: 'y', amplitude: 100, period: 4, phase: 0.25 } }] }), []);
    expect(sim.walls[0].y).toBeCloseTo(300);
    run(sim, 1);
    expect(sim.walls[0].y).toBeCloseTo(200, 3);
  });
  it('gel zones brake and wind zones push', () => {
    const gel = new Simulation(scene({ drag: 0.1, bodies: [body({ x: 100, vx: 300 })], zones: [{ kind: 'gel', x: 200, y: 0, w: 300, h: 640, drag: 3.2 }] }), []);
    run(gel, 3);
    expect(gel.bodies[0].x).toBeLessThan(500);
    const wind = new Simulation(scene({ zones: [{ kind: 'wind', x: 400, y: 0, w: 200, h: 640, fx: 0, fy: 200 }] }), []);
    run(wind, 0.5);
    expect(wind.bodies[0].y).toBeGreaterThan(330);
  });
});

import { dcos, dsin } from '../src/core/dmath';
describe('deterministic trig', () => {
  it('matches Math.sin/cos to 1e-13 over a wide range', () => {
    for (let a = -40; a <= 40; a += 0.0137) {
      expect(Math.abs(dsin(a) - Math.sin(a))).toBeLessThan(1e-13);
      expect(Math.abs(dcos(a) - Math.cos(a))).toBeLessThan(1e-13);
    }
  });
});
