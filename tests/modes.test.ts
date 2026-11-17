import { describe, expect, it } from 'vitest';
import { buildDaily, challengeNumber, currentStreak, dailySpec, dateKey, LocalDailyProvider, recordDaily, shiftDate } from '../src/modes/daily';
import { newUnlocksAt, unlockedAt } from '../src/modes/progression';
import { advanceRun, buildUnlimitedLevel, difficultyForLevel, recordLevelScore, specForLevel, startRun } from '../src/modes/unlimited';
import { LocalLeaderboard } from '../src/services/leaderboard';
import { MemoryStore, ProfileStore } from '../src/services/storage';

describe('daily challenge', () => {
  it('is a pure function of the date', () => {
    const a = buildDaily('2026-11-17');
    const b = buildDaily('2026-11-17');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.number).toBe(321);
    expect(challengeNumber('2026-01-01')).toBe(1);
    expect(a.title.length).toBeGreaterThan(3);
    expect(a.level.id).toBe('daily-2026-11-17');
    expect(JSON.stringify(buildDaily('2026-11-18').level)).not.toBe(JSON.stringify(a.level));
  });

  it('rotates through every challenge type without back-to-back repeats', () => {
    const templates: string[] = [];
    const kits = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const s = dailySpec(shiftDate('2026-11-01', i));
      templates.push(s.template);
      kits.add(JSON.stringify(s.tools));
    }
    for (let i = 1; i < templates.length; i++) expect(templates[i]).not.toBe(templates[i - 1]);
    expect(new Set(templates).size).toBe(10);
    expect(kits.size).toBeGreaterThan(4);
    // Any 10 consecutive days starting on a cycle boundary contain all 10 types.
    const n = challengeNumber('2026-11-01');
    const offset = (10 - (n % 10)) % 10;
    expect(new Set(templates.slice(offset, offset + 10)).size).toBe(10);
  });

  it('caches today, tracks completion, personal best and streaks', async () => {
    const store = new ProfileStore(new MemoryStore());
    const today = dateKey();
    const provider = new LocalDailyProvider(store);
    const ch = await provider.getChallenge(today);
    expect(store.get().daily.cache?.date).toBe(today);
    expect(JSON.stringify((await provider.getChallenge(today)).level)).toBe(JSON.stringify(ch.level));

    // Yesterday was cleared, so today extends the streak.
    store.update((d) => { d.daily.streak = 3; d.daily.bestStreak = 3; d.daily.lastCompleted = shiftDate(today, -1); });
    const m = { time: 4, devicesUsed: 2, energy: 1000 };
    const first = recordDaily(store, ch, 60000, m);
    expect(first).toMatchObject({ best: true, first: true });
    expect(currentStreak(store)).toBe(4);
    const worse = recordDaily(store, ch, 50000, m);
    expect(worse.best).toBe(false);
    const better = recordDaily(store, ch, 70000, { ...m, time: 3 });
    expect(better).toMatchObject({ best: true, first: false, previousBest: 60000 });
    const r = store.get().daily.results[today];
    expect(r.bestScore).toBe(70000); expect(r.firstScore).toBe(60000); expect(r.completions).toBe(3); expect(r.bestTime).toBe(3);
    expect(store.get().daily.streak).toBe(4); // replays never double-count

    // A missed day breaks the streak; archive plays do not touch it.
    store.update((d) => { d.daily.lastCompleted = shiftDate(today, -3); });
    expect(currentStreak(store)).toBe(0);
    const old = await provider.getChallenge(shiftDate(today, -2));
    recordDaily(store, old, 55000, m);
    expect(store.get().daily.lastCompleted).toBe(shiftDate(today, -3));
  });
});

describe('unlimited mode', () => {
  it('advances, banks the best score per level and unlocks mechanics', () => {
    const store = new ProfileStore(new MemoryStore());
    const run = startRun(store, 12345);
    expect(run.level).toBe(1);
    const first = buildUnlimitedLevel(store.get().unlimited.run!);
    expect(first.spec.template).toBe('direct');
    expect(first.level.tools.repulsor + first.level.tools.vortex + first.level.tools.field).toBe(0);

    expect(advanceRun(store, first.spec)).toEqual([]); // cannot advance without a clear
    expect(store.get().unlimited.run!.level).toBe(1);
    recordLevelScore(store, 50000);
    recordLevelScore(store, 42000);
    recordLevelScore(store, 61000);
    const gained = advanceRun(store, first.spec);
    const u = store.get().unlimited;
    expect(u.run!.level).toBe(2);
    expect(u.run!.score).toBe(61000);
    expect(u.highestLevel).toBe(1);
    expect(u.bestRunScore).toBe(61000);
    expect(gained).toContain('tool:repulsor');
    expect(store.get().unlocks).toContain('template:narrow');
  });

  it('is reproducible per run seed and ramps difficulty through content, not just numbers', () => {
    const run = { seed: 777, level: 1, score: 0, levelBest: 0, history: [] };
    expect(JSON.stringify(specForLevel(run, 9))).toBe(JSON.stringify(specForLevel({ ...run }, 9)));
    expect(difficultyForLevel(1)).toBe(1);
    expect(difficultyForLevel(20)).toBe(5);
    expect(specForLevel(run, 10).template).toBe('sync'); // showcased on unlock
    expect(unlockedAt(1).map((x) => x.id)).toEqual(['tool:attractor', 'template:direct']);
    expect(newUnlocksAt(15).some((x) => x.id === 'template:survive')).toBe(true);
    const early = specForLevel(run, 2);
    const late = specForLevel(run, 18);
    expect(late.modifiers.length).toBeGreaterThan(early.modifiers.length);
  });
});

describe('persistence and leaderboards', () => {
  it('round-trips through the key-value store and survives corrupt data', () => {
    const kv = new MemoryStore();
    const a = new ProfileStore(kv);
    a.update((d) => { d.settings.playerName = 'Ada'; d.tutorialDone = true; d.stats.simulations = 9; });
    const b = new ProfileStore(kv);
    expect(b.get().settings.playerName).toBe('Ada');
    expect(b.get().tutorialDone).toBe(true);
    expect(b.get().stats.simulations).toBe(9);
    kv.setItem('vectorlab.save.v1', '{not json');
    expect(new ProfileStore(kv).get().settings.playerName).toBe('You');
    b.reset();
    expect(new ProfileStore(kv).get().tutorialDone).toBe(false);
  });

  it('labels simulated rows as demo and ranks the real player among them', async () => {
    const store = new ProfileStore(new MemoryStore());
    const board = new LocalLeaderboard(store);
    expect(board.live).toBe(false);
    const today = dateKey();
    let rows = await board.getBoard('daily', 'score', today);
    expect(rows.every((r) => r.demo && !r.isPlayer)).toBe(true);
    store.update((d) => { d.daily.results[today] = { date: today, number: 1, title: 't', difficulty: 2, bestScore: 99000, bestTime: 1.1, bestEnergy: 10, bestDevices: 1, firstScore: 99000, completions: 1, completedAt: '' }; });
    rows = await board.getBoard('daily', 'score', today);
    expect(rows[0]).toMatchObject({ isPlayer: true, demo: false, rank: 1 });
    expect((await board.getBoard('daily', 'time', today))[0].isPlayer).toBe(true);
    expect((await board.getBoard('daily', 'energy', today))[0].isPlayer).toBe(true);
    for (const scope of ['friends', 'weekly', 'alltime'] as const) {
      const r = await board.getBoard(scope, 'score', today);
      expect(r.filter((x) => x.isPlayer).length).toBe(1);
      expect(r.filter((x) => !x.isPlayer).every((x) => x.demo)).toBe(true);
      expect(r.map((x) => x.rank)).toEqual(r.map((_, i) => i + 1));
    }
  });
});
