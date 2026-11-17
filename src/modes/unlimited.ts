import { RuleBasedDesigner } from '../ai/designer';
import { combineSeed } from '../core/rng';
import { generateLevel } from '../gen/generator';
import { HISTORY_LENGTH, signatureOf } from '../gen/signature';
import { ChallengeSpec, ModifierId, TemplateId } from '../gen/spec';
import { Level } from '../game/level';
import { DeviceType } from '../physics/types';
import { ProfileStore, UnlimitedRun } from '../services/storage';
import { newUnlocksAt, unlockedAt } from './progression';

const designer = new RuleBasedDesigner();

/** Difficulty climbs one step every four levels; mechanics pile on separately via unlocks. */
export function difficultyForLevel(n: number): number {
  return Math.max(1, Math.min(5, 1 + Math.floor((n - 1) / 4)));
}

/**
 * How many modifiers a level stacks. Early levels follow the difficulty default; deep runs
 * combine two and then three mechanics so late levels keep getting more intricate even
 * after the difficulty rating tops out.
 */
export function modifierCountForLevel(n: number): number | undefined {
  if (n >= 24) return 3;
  if (n >= 13) return 2;
  return undefined;
}

export function specForLevel(run: UnlimitedRun, n: number): ChallengeSpec {
  const unlocked = unlockedAt(n);
  const pick = <T extends string>(kind: string) => unlocked.filter((u) => u.kind === kind).map((u) => u.id.split(':')[1] as T);
  // A freshly unlocked challenge type is showcased on the level that unlocks it.
  const fresh = newUnlocksAt(n).find((u) => u.kind === 'template');
  const spec = designer.designSync({
    seed: combineSeed(run.seed, `level-${n}`),
    difficulty: difficultyForLevel(n),
    history: run.history,
    allowedTemplates: pick<TemplateId>('template'),
    allowedModifiers: pick<ModifierId>('modifier'),
    allowedTools: pick<DeviceType>('tool'),
    template: fresh ? (fresh.id.split(':')[1] as TemplateId) : undefined,
    modifierCount: modifierCountForLevel(n),
  });
  return spec;
}

export function buildUnlimitedLevel(run: UnlimitedRun): { level: Level; spec: ChallengeSpec } {
  const spec = specForLevel(run, run.level);
  const { level } = generateLevel(spec);
  level.id = `unlimited-${run.seed}-${run.level}`;
  return { level, spec };
}

export function startRun(store: ProfileStore, seed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0): UnlimitedRun {
  const run: UnlimitedRun = { seed, level: 1, score: 0, levelBest: 0, history: [], cleared: 0, stamp: Date.now() };
  store.update((d) => {
    d.unlimited.run = run;
    d.unlimited.runsStarted++;
  });
  return run;
}

/** Record a success on the current level; the best attempt is what gets banked on advance. */
export function recordLevelScore(store: ProfileStore, score: number): void {
  store.update((d) => {
    const run = d.unlimited.run;
    if (run && score > run.levelBest) { run.levelBest = score; run.stamp = Date.now(); }
  });
}

/** Bank the current level and move to the next one. Returns newly unlocked items. */
export function advanceRun(store: ProfileStore, spec: ChallengeSpec): string[] {
  let gained: string[] = [];
  store.update((d) => {
    const run = d.unlimited.run;
    if (!run || run.levelBest <= 0) return;
    run.score += run.levelBest;
    run.levelBest = 0;
    run.history = [...run.history, signatureOf(spec)].slice(-HISTORY_LENGTH);
    d.stats.levelsCleared++;
    d.unlimited.highestLevel = Math.max(d.unlimited.highestLevel, run.level);
    d.unlimited.bestRunScore = Math.max(d.unlimited.bestRunScore, run.score);
    run.level++;
    run.cleared = (run.cleared ?? run.level - 2) + 1;
    run.stamp = Date.now();
    d.unlimited.longestRun = Math.max(d.unlimited.longestRun ?? 0, run.cleared);
    const ids = unlockedAt(Math.max(d.unlimited.highestLevel + 1, run.level)).map((u) => u.id);
    gained = ids.filter((id) => !d.unlocks.includes(id));
    d.unlocks = Array.from(new Set([...d.unlocks, ...ids]));
  });
  return gained;
}
