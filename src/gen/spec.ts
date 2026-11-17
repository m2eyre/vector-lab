import { ToolCounts } from '../game/level';
import { DEVICE_TYPES } from '../physics/types';

/**
 * A ChallengeSpec is the *only* thing a challenge designer (rule-based today, an AI model
 * later) hands to the level generator. It is pure data: no coordinates and no code.
 * The generator turns it into a concrete arena and the physics engine validates it.
 */
export type TemplateId =
  | 'direct' | 'narrow' | 'collect' | 'precision' | 'gate'
  | 'avoid' | 'sync' | 'chain' | 'split' | 'survive';

export type ModifierId =
  | 'bumpers' | 'hazards' | 'movers' | 'gel' | 'ice' | 'crosswind'
  | 'frictionless' | 'heavy' | 'light' | 'launched' | 'tightClock' | 'lowPower';

export interface ChallengeSpec {
  version: 1;
  seed: number;
  title: string;
  /** One-sentence design intent. Shown to the player as flavour text. */
  concept: string;
  template: TemplateId;
  /** 1..5 */
  difficulty: number;
  objectCount: number;
  modifiers: ModifierId[];
  tools: ToolCounts;
  maxDevices: number;
}

export interface TemplateInfo {
  id: TemplateId;
  name: string;
  objective: 'deliver' | 'collect' | 'sync' | 'survive';
  /** The physical skill the template asks for; used to judge gameplay similarity. */
  interaction: 'steer' | 'thread' | 'sweep' | 'brake' | 'timing' | 'collide' | 'divide' | 'contain';
  objects: [number, number];
  blurb: string;
  /** Modifiers that make sense on this template. */
  modifiers: ModifierId[];
}

const ALL_MODS: ModifierId[] = [
  'bumpers', 'hazards', 'movers', 'gel', 'ice', 'crosswind', 'frictionless', 'heavy', 'light', 'launched', 'tightClock', 'lowPower',
];

export const TEMPLATES: Record<TemplateId, TemplateInfo> = {
  direct: { id: 'direct', name: 'Direct Route', objective: 'deliver', interaction: 'steer', objects: [1, 1], blurb: 'Bend a path around simple cover.', modifiers: ALL_MODS },
  narrow: { id: 'narrow', name: 'Narrow Passage', objective: 'deliver', interaction: 'thread', objects: [1, 1], blurb: 'Thread the object through a tight gap.', modifiers: ['bumpers', 'gel', 'ice', 'crosswind', 'frictionless', 'heavy', 'light', 'launched', 'tightClock', 'lowPower'] },
  collect: { id: 'collect', name: 'Multiple Targets', objective: 'collect', interaction: 'sweep', objects: [1, 1], blurb: 'One object, several targets, any order.', modifiers: ['bumpers', 'hazards', 'ice', 'frictionless', 'heavy', 'light', 'launched', 'lowPower', 'crosswind'] },
  precision: { id: 'precision', name: 'Precision Landing', objective: 'deliver', interaction: 'brake', objects: [1, 1], blurb: 'Arrive slowly or overshoot.', modifiers: ['gel', 'ice', 'crosswind', 'heavy', 'light', 'launched', 'hazards', 'lowPower', 'bumpers'] },
  gate: { id: 'gate', name: 'Moving Gate', objective: 'deliver', interaction: 'timing', objects: [1, 1], blurb: 'Time the run through a cycling gate.', modifiers: ['bumpers', 'gel', 'ice', 'heavy', 'light', 'lowPower', 'hazards', 'frictionless'] },
  avoid: { id: 'avoid', name: 'Hazard Field', objective: 'deliver', interaction: 'steer', objects: [1, 1], blurb: 'Find a safe corridor between hazards.', modifiers: ['movers', 'ice', 'crosswind', 'frictionless', 'heavy', 'light', 'launched', 'tightClock', 'lowPower', 'gel'] },
  sync: { id: 'sync', name: 'Synchronised Arrival', objective: 'sync', interaction: 'timing', objects: [2, 2], blurb: 'Different journeys, simultaneous landings.', modifiers: ['bumpers', 'gel', 'ice', 'crosswind', 'frictionless', 'lowPower', 'hazards'] },
  chain: { id: 'chain', name: 'Chain Reaction', objective: 'deliver', interaction: 'collide', objects: [2, 2], blurb: 'Strike a shielded payload into the target.', modifiers: ['bumpers', 'hazards', 'ice', 'lowPower', 'tightClock', 'heavy'] },
  split: { id: 'split', name: 'Divergence', objective: 'deliver', interaction: 'divide', objects: [2, 3], blurb: 'Separate a cluster into matching targets.', modifiers: ['bumpers', 'gel', 'ice', 'frictionless', 'lowPower', 'hazards', 'crosswind'] },
  survive: { id: 'survive', name: 'Containment', objective: 'survive', interaction: 'contain', objects: [1, 1], blurb: 'Keep a runaway object alive.', modifiers: ['bumpers', 'movers', 'heavy', 'light', 'lowPower', 'crosswind'] },
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];

/** Modifier groups where at most one member may be active. */
export const EXCLUSIVE_GROUPS: ModifierId[][] = [
  ['heavy', 'light'],
  ['gel', 'ice', 'frictionless'],
];

export const MODIFIER_INFO: Record<ModifierId, { name: string; rule: string }> = {
  bumpers: { name: 'Bumpers', rule: 'Active bumpers kick objects away' },
  hazards: { name: 'Hazards', rule: 'Plasma hazards destroy objects' },
  movers: { name: 'Moving Parts', rule: 'Obstacles move on a fixed cycle' },
  gel: { name: 'Gel Zone', rule: 'Gel zones slow objects sharply' },
  ice: { name: 'Superfluid', rule: 'Superfluid zones have zero drag' },
  crosswind: { name: 'Crosswind', rule: 'A wind band pushes everything sideways' },
  frictionless: { name: 'Frictionless', rule: 'Almost no drag anywhere' },
  heavy: { name: 'Heavy Cargo', rule: 'Heavy object: forces accelerate it less' },
  light: { name: 'Featherweight', rule: 'Light object: small forces go a long way' },
  launched: { name: 'Hot Start', rule: 'The object starts already moving' },
  tightClock: { name: 'Tight Clock', rule: 'Shortened time limit' },
  lowPower: { name: 'Low Power', rule: 'Device strength is capped' },
};

/**
 * Validates and sanitises untrusted spec JSON (e.g. model output). Returns a clean spec or a
 * list of problems. Unknown fields are dropped and nothing in the input is ever executed.
 */
export function validateSpec(input: unknown): { ok: true; spec: ChallengeSpec } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const template = o.template as TemplateId;
  if (!TEMPLATES[template]) errors.push(`unknown template: ${String(o.template)}`);
  const difficulty = Math.round(Number(o.difficulty));
  if (!(difficulty >= 1 && difficulty <= 5)) errors.push('difficulty must be 1..5');
  const seed = Number(o.seed);
  if (!Number.isFinite(seed)) errors.push('seed must be a number');
  const info = TEMPLATES[template];
  let objectCount = Math.round(Number(o.objectCount ?? (info ? info.objects[0] : 1)));
  if (info) objectCount = Math.max(info.objects[0], Math.min(info.objects[1], objectCount));
  const rawMods = Array.isArray(o.modifiers) ? o.modifiers : [];
  const modifiers: ModifierId[] = [];
  for (const m of rawMods) {
    if (typeof m !== 'string' || !MODIFIER_INFO[m as ModifierId]) { errors.push(`unknown modifier: ${String(m)}`); continue; }
    const id = m as ModifierId;
    if (info && !info.modifiers.includes(id)) continue; // silently drop incompatible modifiers
    if (modifiers.includes(id)) continue;
    if (EXCLUSIVE_GROUPS.some((g) => g.includes(id) && g.some((x) => modifiers.includes(x)))) continue;
    modifiers.push(id);
  }
  const t = (o.tools && typeof o.tools === 'object' ? o.tools : {}) as Record<string, unknown>;
  const tools = { attractor: 0, repulsor: 0, vortex: 0, field: 0 } as ToolCounts;
  let total = 0;
  for (const k of DEVICE_TYPES) {
    tools[k] = Math.max(0, Math.min(4, Math.round(Number(t[k]) || 0)));
    total += tools[k];
  }
  if (total < 1) errors.push('at least one tool is required');
  const maxDevices = Math.max(1, Math.min(total, Math.round(Number(o.maxDevices) || total)));
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    spec: {
      version: 1, seed: seed >>> 0,
      title: String(o.title ?? info.name).slice(0, 40),
      concept: String(o.concept ?? info.blurb).slice(0, 160),
      template, difficulty, objectCount, modifiers, tools, maxDevices,
    },
  };
}

const SPEC_KEYS = ['version', 'seed', 'title', 'concept', 'template', 'difficulty', 'objectCount', 'modifiers', 'tools', 'maxDevices'];
const SAFE_TEXT = /^[\p{L}\p{N} .,'!?:;&()\-]+$/u;

/**
 * Strict validation for specs coming from an AI model. Unlike validateSpec(), nothing is
 * repaired or silently dropped: any unknown field, out-of-range number, incompatible or
 * mutually exclusive modifier, or unsafe text rejects the whole spec. The result is plain
 * data built field by field, so nothing from the input object can ride along.
 */
export function validateSpecStrict(input: unknown): { ok: true; spec: ChallengeSpec } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['spec must be an object'] };
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!SPEC_KEYS.includes(k)) errors.push(`unknown field: ${k}`);

  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
  const text = (v: unknown, name: string, min: number, max: number): string => {
    if (typeof v !== 'string') { errors.push(`${name} must be a string`); return ''; }
    const s = v.trim();
    if (s.length < min || s.length > max) errors.push(`${name} must be ${min}..${max} characters`);
    else if (!SAFE_TEXT.test(s)) errors.push(`${name} contains unsupported characters`);
    return s;
  };

  if (o.version !== undefined && o.version !== 1) errors.push('version must be 1');
  if (!isInt(o.seed) || o.seed < 0 || o.seed > 0xffffffff) errors.push('seed must be an unsigned 32-bit integer');
  const title = text(o.title, 'title', 3, 40);
  const concept = text(o.concept, 'concept', 8, 160);
  const info = typeof o.template === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATES, o.template) ? TEMPLATES[o.template as TemplateId] : null;
  if (!info) errors.push(`unknown template: ${String(o.template)}`);
  if (!isInt(o.difficulty) || o.difficulty < 1 || o.difficulty > 5) errors.push('difficulty must be an integer 1..5');
  if (!isInt(o.objectCount)) errors.push('objectCount must be an integer');
  else if (info && (o.objectCount < info.objects[0] || o.objectCount > info.objects[1])) errors.push(`objectCount for ${info.id} must be ${info.objects[0]}..${info.objects[1]}`);

  const modifiers: ModifierId[] = [];
  if (!Array.isArray(o.modifiers)) errors.push('modifiers must be an array');
  else if (o.modifiers.length > 3) errors.push('at most 3 modifiers');
  else for (const m of o.modifiers) {
    if (typeof m !== 'string' || !Object.prototype.hasOwnProperty.call(MODIFIER_INFO, m)) { errors.push(`unknown modifier: ${String(m)}`); continue; }
    const id = m as ModifierId;
    if (modifiers.includes(id)) { errors.push(`duplicate modifier: ${id}`); continue; }
    if (info && !info.modifiers.includes(id)) errors.push(`modifier ${id} is not supported on template ${info.id}`);
    if (EXCLUSIVE_GROUPS.some((g) => g.includes(id) && g.some((x) => modifiers.includes(x)))) errors.push(`modifier ${id} conflicts with another modifier`);
    modifiers.push(id);
  }

  const tools = { attractor: 0, repulsor: 0, vortex: 0, field: 0 } as ToolCounts;
  let total = 0;
  if (!o.tools || typeof o.tools !== 'object' || Array.isArray(o.tools)) errors.push('tools must be an object');
  else {
    const t = o.tools as Record<string, unknown>;
    for (const k of Object.keys(t)) if (!(DEVICE_TYPES as string[]).includes(k)) errors.push(`unknown tool: ${k}`);
    for (const k of DEVICE_TYPES) {
      const v = t[k] ?? 0;
      if (!isInt(v) || v < 0 || v > 3) { errors.push(`tools.${k} must be an integer 0..3`); continue; }
      tools[k] = v;
      total += v;
    }
    if (total < 1) errors.push('at least one tool is required');
    if (total > 6) errors.push('at most 6 tools in total');
  }
  if (!isInt(o.maxDevices) || o.maxDevices < 1 || o.maxDevices > 4 || o.maxDevices > Math.max(1, total)) errors.push('maxDevices must be an integer between 1 and min(4, total tools)');

  if (errors.length || !info) return { ok: false, errors };
  return {
    ok: true,
    spec: {
      version: 1, seed: o.seed as number, title, concept, template: info.id,
      difficulty: o.difficulty as number, objectCount: o.objectCount as number,
      modifiers, tools, maxDevices: o.maxDevices as number,
    },
  };
}
