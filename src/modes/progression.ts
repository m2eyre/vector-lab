import { ModifierId, TemplateId, TEMPLATES, MODIFIER_INFO } from '../gen/spec';
import { DeviceType } from '../physics/types';

export interface Unlock {
  id: string;
  level: number;
  kind: 'tool' | 'template' | 'modifier' | 'cosmetic';
  name: string;
  detail: string;
}

export interface Skin {
  id: string;
  name: string;
  /** Colours for object 1..4. Object 1 is the one the player sees most. */
  colors: string[];
  unlockLevel: number;
}

export const SKINS: Skin[] = [
  { id: 'ion', name: 'Ion Blue', colors: ['#5ee6ff', '#ffc857', '#c58bff', '#7dffa8'], unlockLevel: 0 },
  { id: 'ember', name: 'Ember', colors: ['#ff8a5c', '#ffe27a', '#c58bff', '#7dffa8'], unlockLevel: 4 },
  { id: 'aurora', name: 'Aurora', colors: ['#7dffa8', '#5ee6ff', '#ff9bd6', '#ffe27a'], unlockLevel: 8 },
  { id: 'ultraviolet', name: 'Ultraviolet', colors: ['#c58bff', '#5ee6ff', '#ffc857', '#ff8a5c'], unlockLevel: 12 },
  { id: 'whitedwarf', name: 'White Dwarf', colors: ['#f4f8ff', '#ffc857', '#5ee6ff', '#ff9bd6'], unlockLevel: 16 },
  { id: 'supernova', name: 'Supernova', colors: ['#ff5c8a', '#ffe27a', '#5ee6ff', '#c58bff'], unlockLevel: 20 },
];

const TOOL_NAMES: Record<DeviceType, string> = { attractor: 'Attractor', repulsor: 'Repulsor', vortex: 'Vortex', field: 'Directional Field' };

const tool = (level: number, id: DeviceType): Unlock => ({ id: `tool:${id}`, level, kind: 'tool', name: TOOL_NAMES[id], detail: 'Force generator' });
const tpl = (level: number, id: TemplateId): Unlock => ({ id: `template:${id}`, level, kind: 'template', name: TEMPLATES[id].name, detail: TEMPLATES[id].blurb });
const mod = (level: number, id: ModifierId): Unlock => ({ id: `modifier:${id}`, level, kind: 'modifier', name: MODIFIER_INFO[id].name, detail: MODIFIER_INFO[id].rule });

/** The Unlimited Mode progression track. A mechanic can appear from its unlock level onward. */
export const UNLOCKS: Unlock[] = [
  tool(1, 'attractor'), tpl(1, 'direct'),
  tool(2, 'repulsor'), tpl(2, 'narrow'),
  tool(3, 'field'), mod(3, 'bumpers'),
  tpl(4, 'collect'),
  tool(5, 'vortex'), tpl(5, 'precision'), mod(5, 'gel'),
  tpl(6, 'avoid'), mod(6, 'hazards'),
  mod(7, 'heavy'), mod(7, 'light'),
  tpl(8, 'gate'), mod(8, 'movers'),
  mod(9, 'ice'), mod(9, 'crosswind'),
  tpl(10, 'sync'),
  mod(11, 'launched'), mod(11, 'frictionless'),
  tpl(12, 'chain'),
  tpl(13, 'split'),
  mod(14, 'tightClock'), mod(14, 'lowPower'),
  tpl(15, 'survive'),
  ...SKINS.filter((s) => s.unlockLevel > 0).map((s): Unlock => ({ id: `cosmetic:${s.id}`, level: s.unlockLevel, kind: 'cosmetic', name: `${s.name} skin`, detail: 'Object and trail colours' })),
].sort((a, b) => a.level - b.level);

export function unlockedAt(level: number): Unlock[] {
  return UNLOCKS.filter((u) => u.level <= level);
}

export function newUnlocksAt(level: number): Unlock[] {
  return UNLOCKS.filter((u) => u.level === level);
}

export function nextUnlock(level: number): Unlock | null {
  return UNLOCKS.find((u) => u.level > level) ?? null;
}

export function getSkin(id: string): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}

export function skinUnlocked(skin: Skin, highestLevel: number): boolean {
  return highestLevel >= skin.unlockLevel;
}
