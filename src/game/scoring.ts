import { Level } from './level';

export interface RunMetrics {
  /** Simulated seconds from start to completion. View speed never affects this. */
  time: number;
  devicesUsed: number;
  energy: number;
}

export interface ScoreBreakdown {
  total: number;
  completion: number;
  speed: number;
  efficiency: number;
  energy: number;
  /** 0..1 quality of each component, for the breakdown bars. */
  ratios: { speed: number; efficiency: number; energy: number };
  max: { completion: number; speed: number; efficiency: number; energy: number };
}

export const SCORE_MAX = 100000;
const W = { completion: 40000, speed: 25000, efficiency: 15000, energy: 20000 };

/**
 * Normalised 0..100,000 score.
 *
 *   completion  40,000 flat for finishing.
 *   speed       25,000 * 1 / (1 + (t / parTime)^2)          -> 50% at par, approaching 100% when fast.
 *   efficiency  15,000 * (1 - (devices - 1) / maxDevices)   -> one device (or none) scores full marks.
 *   energy      20,000 * 1 / (1 + E / parEnergy)            -> 50% at par.
 *
 * Every input is measured in simulated time/energy, so fast-forwarding gains nothing.
 * Survival levels have a fixed duration, so their speed share is folded into energy.
 */
export function computeScore(level: Level, m: RunMetrics): ScoreBreakdown {
  const survive = level.objective.type === 'survive';
  const max = survive
    ? { completion: W.completion, speed: 0, efficiency: W.efficiency, energy: W.energy + W.speed }
    : { ...W };
  const x = m.time / Math.max(0.5, level.par.time);
  const speedRatio = survive ? 0 : 1 / (1 + x * x);
  const effRatio = Math.max(0, 1 - Math.max(0, m.devicesUsed - 1) / Math.max(1, level.maxDevices));
  const energyRatio = 1 / (1 + m.energy / Math.max(1, level.par.energy));
  const speed = Math.round(max.speed * speedRatio);
  const efficiency = Math.round(max.efficiency * effRatio);
  const energy = Math.round(max.energy * energyRatio);
  return {
    total: max.completion + speed + efficiency + energy,
    completion: max.completion, speed, efficiency, energy,
    ratios: { speed: speedRatio, efficiency: effRatio, energy: energyRatio },
    max,
  };
}

/** Display helper: internal energy units are large, so show them as kilojoule-like units. */
export function formatEnergy(e: number): string {
  return (e / 1000).toFixed(1);
}
