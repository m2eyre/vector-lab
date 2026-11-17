/** Plain-data definitions shared by the physics engine, the generator and the renderer. */

export type DeviceType = 'attractor' | 'repulsor' | 'vortex' | 'field';
export const DEVICE_TYPES: DeviceType[] = ['attractor', 'repulsor', 'vortex', 'field'];

/** A player-placed force generator. */
export interface Device {
  id: number;
  type: DeviceType;
  x: number;
  y: number;
  /** Peak force in force units (acceleration = force / mass). */
  strength: number;
  /** Radius of influence; for directional fields the half-length of the field strip. */
  range: number;
  /** Direction in radians (directional field only). */
  angle: number;
  /** Rotation direction (vortex only): 1 = counter-clockwise on screen, -1 = clockwise. */
  spin: 1 | -1;
}

export const DEVICE_LIMITS = {
  strength: { min: 40, max: 900, default: 320 },
  range: { min: 60, max: 400, default: 170 },
  /** Directional field strip half-width as a fraction of its half-length. */
  fieldAspect: 0.4,
};

export interface BodyDef {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  mass: number;
  radius: number;
  restitution: number;
  /** Shielded bodies ignore player devices (used by chain-reaction levels). */
  inert?: boolean;
  /** Index into the palette; also links a body to its assigned target. */
  hue: number;
}

/** Triangle-wave oscillation. Chosen over sine so results are bit-identical across JS engines. */
export interface Oscillation {
  axis: 'x' | 'y';
  amplitude: number;
  period: number;
  phase: number;
}

export interface WallDef {
  x: number;
  y: number;
  w: number;
  h: number;
  motion?: Oscillation;
  /** A gate is a wall that is only solid for part of each cycle. */
  gate?: { period: number; openFraction: number; phase: number };
}

export interface BumperDef {
  x: number;
  y: number;
  radius: number;
  /** Extra speed added along the contact normal on each hit. */
  kick: number;
}

export interface HazardDef {
  shape: 'rect' | 'circle';
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  motion?: Oscillation;
}

export interface ZoneDef {
  kind: 'gel' | 'ice' | 'wind';
  x: number;
  y: number;
  w: number;
  h: number;
  /** Linear drag coefficient inside the zone (gel / ice). */
  drag?: number;
  /** Constant force applied inside the zone (wind). */
  fx?: number;
  fy?: number;
}

/** Everything the physics engine needs to know about a level. */
export interface PhysicsScene {
  arena: { w: number; h: number };
  /** Global linear drag coefficient (1/s). */
  drag: number;
  bodies: BodyDef[];
  walls: WallDef[];
  bumpers: BumperDef[];
  hazards: HazardDef[];
  zones: ZoneDef[];
}

export interface SimEvent {
  type: 'wall' | 'bumper' | 'body' | 'hazard';
  x: number;
  y: number;
  intensity: number;
}

/** Fixed physics timestep (seconds). All gameplay results are produced at this rate. */
export const DT = 1 / 120;
export const MAX_SPEED = 1200;
