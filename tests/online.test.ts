import { describe, expect, it } from 'vitest';
import { buildDesignPrompt, CANDIDATES_SCHEMA, extractCandidates } from '../server/ai';
import { checkLevelShape } from '../src/game/levelSchema';
import { sanitizeDevices, solutionKey, verifySolution } from '../src/game/verify';
import { generateLevel } from '../src/gen/generator';
import { LEVEL_SIMILARITY_LIMIT, levelSignatureOf, levelSimilarity, layoutSimilarity } from '../src/gen/levelSignature';
import { TEMPLATE_IDS, validateSpecStrict } from '../src/gen/spec';
import { dailySpec, isDateKey, utcDateKey } from '../src/modes/daily';
import { advanceRun, modifierCountForLevel, recordLevelScore, specForLevel, startRun } from '../src/modes/unlimited';
import { AdProvider, ads, registerAdProvider } from '../src/services/ads';
import { applyProgress } from '../src/services/online';
import { MemoryStore, ProfileStore } from '../src/services/storage';

const base = { version: 1, seed: 42, title: 'Glass Keyhole', concept: 'Thread a narrow gap on a zero-drag floor.', template: 'narrow', difficulty: 3, objectCount: 1, modifiers: ['ice'], tools: { attractor: 1, repulsor: 0, vortex: 0, field: 1 }, maxDevices: 2 };

describe('strict spec validation (AI output gate)', () => {
  it('accepts a well-formed spec and returns only known fields', () => {
    const r = validateSpecStrict(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.spec).sort()).toEqual(['concept', 'difficulty', 'maxDevices', 'modifiers', 'objectCount', 'seed', 'template', 'title', 'tools', 'version']);
  });
  it.each([
    ['unknown template', { ...base, template: 'portal' }],
    ['prototype key as template', { ...base, template: 'constructor' }],
    ['extra field', { ...base, code: 'alert(1)' }],
    ['fractional difficulty', { ...base, difficulty: 2.5 }],
    ['string number', { ...base, difficulty: '3' }],
    ['object count out of range', { ...base, objectCount: 4 }],
    ['incompatible modifier', { ...base, modifiers: ['hazards'] }],
    ['exclusive modifiers', { ...base, modifiers: ['gel', 'ice'] }],
    ['duplicate modifier', { ...base, modifiers: ['ice', 'ice'] }],
    ['too many tools', { ...base, tools: { attractor: 4, repulsor: 0, vortex: 0, field: 0 } }],
    ['unknown tool', { ...base, tools: { attractor: 1, laser: 1 } }],
    ['no tools', { ...base, tools: { attractor: 0, repulsor: 0, vortex: 0, field: 0 } }],
    ['maxDevices above tools', { ...base, maxDevices: 4 }],
    ['markup in title', { ...base, title: '<b>Hi</b>' }],
    ['array', [base]],
    ['null', null],
  ])('rejects %s', (_name, input) => {
    expect(validateSpecStrict(input).ok).toBe(false);
  });
});

describe('AI prompt and schema', () => {
  it('gives the model the full vocabulary, difficulty scale, history and rules', () => {
    const { system, user } = buildDesignPrompt({ date: '2026-11-17', number: 321, targetDifficulty: 3, candidates: 4, recent: [{ date: '2026-11-16', title: 'X', template: 'gate', difficulty: 2, objectCount: 1, modifiers: ['gel'], tools: { attractor: 1 }, maxDevices: 1 }] });
    for (const t of TEMPLATE_IDS) expect(system).toContain(`- ${t}:`);
    for (const m of ['bumpers', 'lowPower', 'frictionless']) expect(system).toContain(`- ${m}:`);
    expect(system).toMatch(/DIFFICULTY/);
    expect(system).toMatch(/VARIETY RULES/);
    expect(user).toContain('2026-11-16: gate');
    expect(user).toContain('Target difficulty: 3');
    expect(CANDIDATES_SCHEMA.properties.candidates.items.properties.template.enum).toEqual(TEMPLATE_IDS);
  });
  it('extracts candidates defensively', () => {
    expect(extractCandidates(null)).toEqual([]);
    expect(extractCandidates({ candidates: 'x' })).toEqual([]);
    expect(extractCandidates({ candidates: [1, 2, 3, 4, 5, 6, 7, 8] }).length).toBe(6);
  });
});

describe('level similarity', () => {
  const spec = dailySpec('2026-11-20');
  const a = generateLevel(spec);
  const sigA = levelSignatureOf(spec, a.level, a.pathLength, a.solution);
  it('flags the same design on a different seed as too similar', () => {
    const b = generateLevel({ ...spec, seed: spec.seed + 1 });
    const sigB = levelSignatureOf(spec, b.level, b.pathLength, b.solution);
    expect(levelSimilarity(sigA, sigB)).toBeGreaterThanOrEqual(LEVEL_SIMILARITY_LIMIT);
  });
  it('treats a mirrored arena as the same layout', () => {
    const mirrored = { ...sigA, grid: sigA.grid.map((_, i) => sigA.grid[Math.floor(i / 10) * 10 + (9 - (i % 10))]), starts: sigA.starts.map(([x, y]) => [1 - x, y] as [number, number]), targets: sigA.targets.map(([x, y]) => [1 - x, y] as [number, number]) };
    expect(layoutSimilarity(sigA, mirrored)).toBeCloseTo(1, 6);
    expect(levelSimilarity(sigA, sigA)).toBeCloseTo(1, 6);
  });
  it('scores a different kind of challenge well below the limit', () => {
    const other = dailySpec('2026-11-23');
    expect(other.template).not.toBe(spec.template);
    const b = generateLevel(other);
    expect(levelSimilarity(sigA, levelSignatureOf(other, b.level, b.pathLength, b.solution))).toBeLessThan(LEVEL_SIMILARITY_LIMIT);
  });
});

describe('solution verification', () => {
  const report = generateLevel(dailySpec('2026-11-21'));
  it('reproduces the same result every time', () => {
    const one = verifySolution(report.level, report.solution);
    const two = verifySolution(JSON.parse(JSON.stringify(report.level)), JSON.parse(JSON.stringify(report.solution)));
    expect(one.ok && two.ok).toBe(true);
    if (one.ok && two.ok) {
      expect(two.run.score.total).toBe(one.run.score.total);
      expect(two.run.time).toBe(one.run.time);
      expect(two.run.energy).toBe(one.run.energy);
      expect(solutionKey(two.run.devices)).toBe(solutionKey(one.run.devices));
    }
  });
  it('rejects devices that break the level rules', () => {
    const d = report.solution![0];
    expect(sanitizeDevices(report.level, [{ ...d, strength: report.level.strengthCap + 1 }]).ok).toBe(false);
    expect(sanitizeDevices(report.level, [{ ...d, range: 10 }]).ok).toBe(false);
    expect(sanitizeDevices(report.level, [{ ...d, x: Infinity }]).ok).toBe(false);
    expect(sanitizeDevices(report.level, [{ ...d, spin: 2 }]).ok).toBe(false);
    expect(sanitizeDevices(report.level, Array(report.level.maxDevices + 1).fill(d)).ok).toBe(false);
    expect(sanitizeDevices(report.level, {}).ok).toBe(false);
  });
  it('accepts generated levels and rejects malformed ones as untrusted input', () => {
    expect(checkLevelShape(JSON.parse(JSON.stringify(report.level))).ok).toBe(true);
    expect(checkLevelShape({ ...report.level, walls: Array(500).fill(report.level.walls[0] ?? { x: 0, y: 0, w: 1, h: 1 }) }).ok).toBe(false);
    expect(checkLevelShape({ ...report.level, drag: NaN }).ok).toBe(false);
    expect(checkLevelShape('level').ok).toBe(false);
  });
});

describe('dates', () => {
  it('validates date keys and formats UTC days', () => {
    expect(isDateKey('2026-11-17')).toBe(true);
    expect(isDateKey('2026-02-30')).toBe(false);
    expect(isDateKey('17/11/2026')).toBe(false);
    expect(utcDateKey(new Date('2026-11-17T23:59:59Z'))).toBe('2026-11-17');
    expect(utcDateKey(new Date('2026-11-18T00:00:00Z'))).toBe('2026-11-18');
  });
});

describe('unlimited progression', () => {
  it('stacks more modifiers on deep levels and still builds playable arenas', () => {
    expect(modifierCountForLevel(5)).toBeUndefined();
    expect(modifierCountForLevel(13)).toBe(2);
    expect(modifierCountForLevel(30)).toBe(3);
    const run = { seed: 777, level: 30, score: 0, levelBest: 0, history: [] };
    let three = 0;
    for (let n = 26; n <= 31; n++) {
      const spec = specForLevel(run, n);
      if (spec.modifiers.length === 3) three++;
      const { level } = generateLevel(spec);
      expect(level.bodies.length).toBeGreaterThan(0);
      expect(level.targets.length + (level.objective.type === 'survive' ? 1 : 0)).toBeGreaterThan(0);
    }
    expect(three).toBeGreaterThan(0);
  });
  it('tracks the longest run', () => {
    const store = new ProfileStore(new MemoryStore());
    const run = startRun(store, 99);
    for (let i = 0; i < 3; i++) {
      recordLevelScore(store, 50000);
      advanceRun(store, specForLevel(store.get().unlimited.run!, store.get().unlimited.run!.level));
    }
    expect(run.level).toBe(1);
    expect(store.get().unlimited.run!.level).toBe(4);
    expect(store.get().unlimited.longestRun).toBe(3);
    startRun(store, 100);
    recordLevelScore(store, 50000);
    advanceRun(store, specForLevel(store.get().unlimited.run!, 1));
    expect(store.get().unlimited.longestRun).toBe(3);
    expect(store.get().unlimited.highestLevel).toBe(3);
  });
  it('merges cloud progress forward only', () => {
    const store = new ProfileStore(new MemoryStore());
    store.update((d) => { d.unlimited.highestLevel = 5; d.unlimited.run = { seed: 1, level: 6, score: 10, levelBest: 0, history: [], stamp: 100 }; d.stats.simulations = 50; d.unlocks = ['tool:vortex']; });
    applyProgress(store, {
      unlimited: { highestLevel: 3, bestRunScore: 900, longestRun: 7, runsStarted: 2, run: { seed: 2, level: 9, score: 500, levelBest: 0, history: [], stamp: 200 } },
      stats: { simulations: 20, successes: 9, failures: 1, devicesPlaced: 3, simSeconds: 4, bestScore: 88000, levelsCleared: 8, byTemplate: { gate: 2 } },
      daily: { completed: 1, streak: 4, bestStreak: 6, lastCompleted: '2026-11-16', results: [{ date: '2026-11-16', number: 320, title: 'T', difficulty: 2, bestScore: 70000, bestTime: 3, bestEnergy: 5, bestDevices: 1, firstScore: 70000, completions: 1, completedAt: 'x' }] },
      unlocks: ['template:gate'], cosmetics: ['cosmetic:ember'], tutorialDone: true,
    });
    const d = store.get();
    expect(d.unlimited.highestLevel).toBe(5);
    expect(d.unlimited.longestRun).toBe(7);
    expect(d.unlimited.run!.seed).toBe(2);
    expect(d.stats.simulations).toBe(50);
    expect(d.stats.bestScore).toBe(88000);
    expect(d.unlocks.sort()).toEqual(['cosmetic:ember', 'template:gate', 'tool:vortex']);
    expect(d.daily.results['2026-11-16'].bestScore).toBe(70000);
    expect(d.daily.streak).toBe(4);
    expect(d.daily.bestStreak).toBe(6);
    expect(d.tutorialDone).toBe(true);
  });
});

describe('ad hooks', () => {
  it('does nothing at all when no provider is configured', async () => {
    registerAdProvider(null);
    expect(ads.configured).toBe(false);
    expect(await ads.showInterstitial('between-runs')).toBe(false);
    expect(await ads.showRewarded('rewarded-cosmetic')).toBe(false);
    expect(ads.rewardedAvailable).toBe(false);
  });
  it('never shows an ad during a simulation and spaces interstitials out', async () => {
    const shown: string[] = [];
    const provider: AdProvider = {
      name: 'test', rewardedAvailable: true,
      mountBanner: () => () => {},
      showInterstitial: async (p) => { shown.push(p); },
      showRewarded: async (p) => { shown.push(p); return true; },
    };
    registerAdProvider(provider);
    ads.setSimulationActive(true);
    expect(await ads.showInterstitial('between-runs', 1_000_000)).toBe(false);
    expect(await ads.showRewarded('rewarded-cosmetic')).toBe(false);
    expect(shown).toEqual([]);
    ads.setSimulationActive(false);
    expect(await ads.showInterstitial('between-runs', 1_000_000)).toBe(true);
    expect(await ads.showInterstitial('between-runs', 1_060_000)).toBe(false);
    expect(await ads.showInterstitial('between-runs', 1_200_000)).toBe(true);
    expect(await ads.showRewarded('rewarded-cosmetic')).toBe(true);
    expect(shown).toEqual(['between-runs', 'between-runs', 'rewarded-cosmetic']);
    registerAdProvider(null);
  });
});
