import { DeviceType, PhysicsScene } from '../physics/types';

export const ARENA_W = 1000;
export const ARENA_H = 640;

export type ObjectiveType = 'deliver' | 'collect' | 'sync' | 'survive';

export interface TargetDef {
  id: string;
  x: number;
  y: number;
  radius: number;
  /** If set, only this body may use the target. */
  accepts?: string;
  /** If set, the body must arrive slower than this to be captured (precision landing). */
  maxSpeed?: number;
}

export interface Objective {
  type: ObjectiveType;
  /** Bodies that must complete the objective. Others (e.g. a striker) are helpers. */
  required: string[];
  /** Hard time limit in simulated seconds. */
  timeLimit: number;
  /** sync: all required bodies must be captured within this many seconds of each other. */
  window?: number;
  /** survive: required bodies must stay alive this long. */
  duration?: number;
}

export type ToolCounts = Record<DeviceType, number>;

/** A complete, self-contained, serialisable level. */
export interface Level extends PhysicsScene {
  id: string;
  seed: number;
  title: string;
  template: string;
  /** 1 (gentle) .. 5 (expert). */
  difficulty: number;
  objective: Objective;
  targets: TargetDef[];
  /** How many of each generator the player may place. */
  tools: ToolCounts;
  maxDevices: number;
  /** Upper bound for device strength (the Low Power modifier reduces it). */
  strengthCap: number;
  /** Modifier ids active on this level. */
  modifiers: string[];
  /** Human readable special rules shown in the HUD. */
  rules: string[];
  /** Reference values used to normalise scoring. */
  par: { time: number; energy: number };
  /** True when the built-in solver found a working solution during generation. */
  verified: boolean;
}

export const BODY_COLORS = ['#5ee6ff', '#ffc857', '#c58bff', '#7dffa8'];

export function objectiveText(level: Level): string {
  const o = level.objective;
  const n = o.required.length;
  switch (o.type) {
    case 'deliver':
      if (level.bodies.some((b) => b.inert)) return 'Knock the shielded payload into the target';
      return n === 1 ? 'Guide the object into the target' : `Guide all ${n} objects into their matching targets`;
    case 'collect':
      return `Sweep through all ${level.targets.length} targets with one object`;
    case 'sync':
      return `Land all ${n} objects within ${o.window!.toFixed(1)}s of each other`;
    case 'survive':
      return `Keep the object out of the hazards for ${o.duration!.toFixed(0)}s`;
  }
}
