import { describe, expect, it } from 'vitest';
import { GameController } from '../src/game/controller';
import { Level } from '../src/game/level';
import { runHeadless } from '../src/game/runner';
import { computeScore, SCORE_MAX } from '../src/game/scoring';
import { TUTORIAL_LEVEL } from '../src/game/tutorial';
import { Device } from '../src/physics/types';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const pull: Device = { id: 1, type: 'attractor', x: 690, y: 300, strength: 320, range: 400, angle: 0, spin: 1 };

describe('objectives', () => {
  it('tutorial fails with no devices and succeeds with an attractor on the target', () => {
    expect(runHeadless(TUTORIAL_LEVEL, []).state).toBe('failed');
    const r = runHeadless(TUTORIAL_LEVEL, [pull]);
    expect(r.state).toBe('success');
    expect(r.time).toBeGreaterThan(0.5);
    expect(r.energy).toBeGreaterThan(0);
  });

  it('precision targets reject fast arrivals', () => {
    const lvl = clone(TUTORIAL_LEVEL);
    lvl.walls = [];
    lvl.bodies[0] = { ...lvl.bodies[0], x: 300, y: 300, vx: 500 };
    lvl.drag = 0;
    lvl.objective.timeLimit = 1.2;
    lvl.targets[0].maxSpeed = 100;
    expect(runHeadless(lvl, []).state).toBe('failed');
    lvl.targets[0].maxSpeed = 900;
    expect(runHeadless(lvl, []).state).toBe('success');
  });

  it('collect needs every target, sync enforces its window, survive runs the clock', () => {
    const base = clone(TUTORIAL_LEVEL);
    base.walls = []; base.drag = 0;
    const collect: Level = { ...clone(base), objective: { type: 'collect', required: ['a'], timeLimit: 6 },
      bodies: [{ ...base.bodies[0], x: 100, y: 300, vx: 300 }], targets: [{ id: 't0', x: 400, y: 300, radius: 30 }, { id: 't1', x: 700, y: 300, radius: 30 }] };
    expect(runHeadless(collect, []).state).toBe('success');
    collect.targets[1].y = 600;
    expect(runHeadless(collect, []).state).toBe('failed');

    const sync: Level = { ...clone(base), objective: { type: 'sync', required: ['a', 'b'], timeLimit: 8, window: 0.5 },
      bodies: [{ ...base.bodies[0], x: 100, y: 200, vx: 300 }, { ...base.bodies[0], id: 'b', x: 100, y: 440, vx: 300, hue: 1 }],
      targets: [{ id: 't0', x: 500, y: 200, radius: 30, accepts: 'a' }, { id: 't1', x: 560, y: 440, radius: 30, accepts: 'b' }] };
    expect(runHeadless(sync, []).state).toBe('success');
    sync.targets[1].x = 900;
    const late = runHeadless(sync, []);
    expect(late.state).toBe('failed');
    expect(late.failReason).toBe('sync');

    const survive: Level = { ...clone(base), targets: [], objective: { type: 'survive', required: ['a'], timeLimit: 6, duration: 5 } };
    const s = runHeadless(survive, []);
    expect(s.state).toBe('success');
    expect(s.time).toBeCloseTo(5, 1);
    survive.hazards = [{ shape: 'circle', x: 300, y: 380, w: 0, h: 0, r: 30 }];
    expect(runHeadless(survive, []).failReason).toBe('hazard');
  });
});

describe('scoring', () => {
  it('is normalised to 0..100,000 and rewards speed, fewer devices and less energy', () => {
    const lvl = TUTORIAL_LEVEL;
    const base = computeScore(lvl, { time: lvl.par.time, devicesUsed: 1, energy: lvl.par.energy });
    expect(base.total).toBeGreaterThan(40000);
    expect(base.total).toBeLessThanOrEqual(SCORE_MAX);
    expect(computeScore(lvl, { time: 0, devicesUsed: 0, energy: 0 }).total).toBe(SCORE_MAX);
    expect(computeScore(lvl, { time: lvl.par.time / 2, devicesUsed: 1, energy: lvl.par.energy }).total).toBeGreaterThan(base.total);
    expect(computeScore(lvl, { time: lvl.par.time, devicesUsed: 1, energy: lvl.par.energy * 2 }).total).toBeLessThan(base.total);
    const many = { ...lvl, maxDevices: 4 };
    expect(computeScore(many, { time: 3, devicesUsed: 3, energy: 1e5 }).total).toBeLessThan(computeScore(many, { time: 3, devicesUsed: 1, energy: 1e5 }).total);
  });
});

describe('controller', () => {
  const play = (speed: number, frameDt: number) => {
    const c = new GameController(clone(TUTORIAL_LEVEL));
    c.particlesEnabled = false;
    const d = c.place('attractor', 690, 300)!;
    c.update(d.id, { range: 400 });
    c.setSpeed(speed);
    c.start();
    for (let i = 0; i < 100000 && c.phase === 'running'; i++) c.tick(frameDt);
    return c;
  };

  it('gives identical results at any viewing speed or frame rate', () => {
    const a = play(1, 1 / 60);
    const b = play(4, 1 / 144);
    const c = play(0.25, 1 / 30);
    expect(a.phase).toBe('success');
    expect(b.outcome!.metrics).toEqual(a.outcome!.metrics);
    expect(c.outcome!.metrics).toEqual(a.outcome!.metrics);
    expect(b.outcome!.score!.total).toBe(a.outcome!.score!.total);
    // ...and the same as the headless runner used for replays.
    expect(runHeadless(TUTORIAL_LEVEL, a.devices).time).toBe(a.outcome!.metrics.time);
  });

  it('enforces device limits, supports edit/remove and resets cleanly', () => {
    const c = new GameController(clone(TUTORIAL_LEVEL));
    expect(c.canPlace('repulsor')).toBe(false);
    const d = c.place('attractor', 100, 100)!;
    expect(c.place('attractor', 200, 200)).toBeNull();
    c.update(d.id, { strength: 99999, range: 1 });
    expect(c.selected!.strength).toBe(900);
    expect(c.selected!.range).toBe(60);
    c.start(); for (let i = 0; i < 5; i++) c.tick(0.1);
    expect(c.sim.time).toBeGreaterThan(0.4);
    c.pause(); const t = c.sim.time; c.tick(0.5);
    expect(c.sim.time).toBe(t);
    c.reset();
    expect(c.phase).toBe('setup');
    expect(c.sim.time).toBe(0);
    expect(c.sim.bodies[0].x).toBe(TUTORIAL_LEVEL.bodies[0].x);
    expect(c.devices.length).toBe(1);
    c.remove(d.id);
    expect(c.devices.length).toBe(0);
    expect(c.canPlace('attractor')).toBe(true);
  });
});
