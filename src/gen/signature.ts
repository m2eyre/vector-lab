import { DEVICE_TYPES } from '../physics/types';
import { ChallengeSpec, TEMPLATES } from './spec';

/**
 * A structural signature captures what a level *plays like*, not where things are placed.
 * Two levels with the same signature feel the same even if every coordinate differs.
 */
export interface Signature {
  template: string;
  objective: string;
  interaction: string;
  objects: number;
  modifiers: string[];
  tools: string[];
  maxDevices: number;
}

export function signatureOf(spec: ChallengeSpec): Signature {
  const info = TEMPLATES[spec.template];
  return {
    template: spec.template,
    objective: info.objective,
    interaction: info.interaction,
    objects: spec.objectCount,
    modifiers: [...spec.modifiers].sort(),
    tools: DEVICE_TYPES.filter((t) => spec.tools[t] > 0),
    maxDevices: spec.maxDevices,
  };
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const inter = a.filter((x) => b.includes(x)).length;
  return inter / (a.length + b.length - inter);
}

/**
 * Gameplay similarity in [0, 1]. The weights favour what the player actually has to *do*
 * (template, required interaction, available tools) over incidental counts.
 */
export function similarity(a: Signature, b: Signature): number {
  let s = 0;
  if (a.template === b.template) s += 0.34;
  if (a.interaction === b.interaction) s += 0.12;
  if (a.objective === b.objective) s += 0.08;
  s += 0.2 * jaccard(a.tools, b.tools);
  s += 0.18 * jaccard(a.modifiers, b.modifiers);
  if (a.objects === b.objects) s += 0.04;
  if (a.maxDevices === b.maxDevices) s += 0.04;
  return s;
}

export const SIMILARITY_LIMIT = 0.62;
export const HISTORY_LENGTH = 8;

/** Highest similarity against recent history; the most recent entries count in full. */
export function maxSimilarity(sig: Signature, history: Signature[]): number {
  let worst = 0;
  const recent = history.slice(-HISTORY_LENGTH);
  for (let i = 0; i < recent.length; i++) {
    const age = recent.length - 1 - i; // 0 = previous level
    const weight = age < 3 ? 1 : 0.85;
    worst = Math.max(worst, similarity(sig, recent[i]) * weight);
  }
  return worst;
}
