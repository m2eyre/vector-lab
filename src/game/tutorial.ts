import { ARENA_H, ARENA_W, Level } from './level';

/** Hand-built first level: one object, one target, one attractor. */
export const TUTORIAL_LEVEL: Level = {
  id: 'tutorial', seed: 1, title: 'First Contact', template: 'tutorial', difficulty: 1,
  arena: { w: ARENA_W, h: ARENA_H }, drag: 0.55,
  bodies: [{ id: 'a', x: 300, y: 380, vx: 0, vy: 0, mass: 1, radius: 13, restitution: 0.6, hue: 0 }],
  walls: [{ x: 470, y: 60, w: 30, h: 170 }, { x: 470, y: 470, w: 30, h: 110 }],
  bumpers: [], hazards: [], zones: [],
  targets: [{ id: 't0', x: 690, y: 300, radius: 34 }],
  objective: { type: 'deliver', required: ['a'], timeLimit: 12 },
  tools: { attractor: 1, repulsor: 0, vortex: 0, field: 0 }, maxDevices: 1, strengthCap: 900,
  modifiers: [], rules: [], par: { time: 3.2, energy: 130000 }, verified: true,
};

export interface CoachStep {
  title: string;
  text: string;
  /** Which part of the UI to highlight. */
  focus: 'toolbar' | 'arena' | 'inspector' | 'run' | null;
}

export const COACH: Record<string, CoachStep> = {
  pick: { title: '1 · Pick a generator', text: 'You never touch the object itself. Select the Attractor in the toolbar.', focus: 'toolbar' },
  place: { title: '2 · Place it', text: 'Click on or near the glowing target to drop the attractor there.', focus: 'arena' },
  reach: { title: '3 · Extend its reach', text: 'The object is outside the ring, so it feels nothing. Drag the white handle (or the Range slider) until the ring covers the object. The dotted line forecasts its path.', focus: 'inspector' },
  run: { title: '4 · Run the experiment', text: 'Press Run (or Space) and watch the physics play out.', focus: 'run' },
  watch: { title: 'Simulating…', text: 'Forces add up, mass resists, drag slows things down.', focus: null },
  retry: { title: 'Not quite', text: 'Nothing is lost. Drag the attractor, change Strength or Range, then Run again.', focus: 'inspector' },
};
