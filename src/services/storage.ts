import { Level } from '../game/level';
import { Signature } from '../gen/signature';
import { ChallengeSpec } from '../gen/spec';
import { Device } from '../physics/types';

/** Minimal key-value contract. localStorage today; a synced backend can implement it later. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage wrapper that degrades to memory when storage is blocked or full. */
export class SafeLocalStore implements KeyValueStore {
  private memory = new Map<string, string>();
  getItem(key: string): string | null {
    try {
      const v = globalThis.localStorage?.getItem(key);
      if (v !== null && v !== undefined) return v;
    } catch { /* fall through to memory */ }
    return this.memory.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.memory.set(key, value);
    try { globalThis.localStorage?.setItem(key, value); } catch { /* memory only */ }
  }
  removeItem(key: string): void {
    this.memory.delete(key);
    try { globalThis.localStorage?.removeItem(key); } catch { /* ignore */ }
  }
}

export class MemoryStore implements KeyValueStore {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

export interface Settings {
  playerName: string;
  trails: boolean;
  vectors: boolean;
  forecast: boolean;
  sound: boolean;
  reducedMotion: boolean;
  skin: string;
}

export interface DailyResult {
  date: string;
  number: number;
  title: string;
  difficulty: number;
  bestScore: number;
  bestTime: number;
  bestEnergy: number;
  bestDevices: number;
  firstScore: number;
  completions: number;
  completedAt: string;
}

export interface UnlimitedRun {
  seed: number;
  level: number;
  /** Banked score from cleared levels. */
  score: number;
  /** Best score on the current level this run (0 until cleared). */
  levelBest: number;
  history: Signature[];
  /** Levels cleared so far in this run. */
  cleared?: number;
  /** When this device last changed the run (ms). Newest wins when devices sync. */
  stamp?: number;
}

export interface Stats {
  simulations: number;
  successes: number;
  failures: number;
  devicesPlaced: number;
  simSeconds: number;
  bestScore: number;
  levelsCleared: number;
  byTemplate: Record<string, number>;
}

export interface Replay {
  key: string;
  label: string;
  level: Level;
  devices: Device[];
  score: number;
  time: number;
  savedAt: string;
  energy?: number;
  /** Set once the server has verified and stored this solution. */
  remoteId?: string;
  /** Present on replays fetched from the server. */
  player?: string;
  date?: string;
}

export interface SaveData {
  version: 1;
  settings: Settings;
  tutorialDone: boolean;
  daily: {
    results: Record<string, DailyResult>;
    streak: number;
    bestStreak: number;
    lastCompleted: string | null;
    cache: { date: string; generator: number; spec: ChallengeSpec; level: Level; published?: boolean; number?: number; source?: string } | null;
  };
  unlimited: {
    run: UnlimitedRun | null;
    highestLevel: number;
    bestRunScore: number;
    /** Most levels cleared in a single run. */
    longestRun: number;
    runsStarted: number;
  };
  /** Ids of unlocked mechanics and cosmetics (see modes/progression.ts). */
  unlocks: string[];
  stats: Stats;
  replays: Replay[];
}

export function defaultSave(): SaveData {
  return {
    version: 1,
    settings: { playerName: 'You', trails: true, vectors: false, forecast: true, sound: true, reducedMotion: false, skin: 'ion' },
    tutorialDone: false,
    daily: { results: {}, streak: 0, bestStreak: 0, lastCompleted: null, cache: null },
    unlimited: { run: null, highestLevel: 0, bestRunScore: 0, longestRun: 0, runsStarted: 0 },
    unlocks: [],
    stats: { simulations: 0, successes: 0, failures: 0, devicesPlaced: 0, simSeconds: 0, bestScore: 0, levelsCleared: 0, byTemplate: {} },
    replays: [],
  };
}

const KEY = 'vectorlab.save.v1';

/**
 * Single source of truth for persistent player data. UI subscribes; game code calls update().
 * Swapping the KeyValueStore (or mirroring updates to a server) is all a backend needs.
 */
export class ProfileStore {
  private data: SaveData;
  private listeners = new Set<() => void>();

  constructor(private store: KeyValueStore = new SafeLocalStore()) {
    this.data = this.read();
  }

  private read(): SaveData {
    const base = defaultSave();
    try {
      const raw = this.store.getItem(KEY);
      if (!raw) return base;
      const p = JSON.parse(raw) as Partial<SaveData>;
      if (p.version !== 1) return base;
      // Merge section by section so new fields get defaults on old saves.
      return {
        ...base, ...p,
        settings: { ...base.settings, ...p.settings },
        daily: { ...base.daily, ...p.daily },
        unlimited: { ...base.unlimited, ...p.unlimited },
        stats: { ...base.stats, ...p.stats },
        unlocks: p.unlocks ?? [],
        replays: p.replays ?? [],
      };
    } catch {
      return base;
    }
  }

  get = (): SaveData => this.data;

  update(mutate: (draft: SaveData) => void): void {
    const draft = JSON.parse(JSON.stringify(this.data)) as SaveData;
    mutate(draft);
    this.data = draft;
    this.store.setItem(KEY, JSON.stringify(draft));
    this.listeners.forEach((l) => l());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  reset(): void {
    this.store.removeItem(KEY);
    this.data = defaultSave();
    this.listeners.forEach((l) => l());
  }
}

export const profile = new ProfileStore();

export function saveReplay(draft: SaveData, replay: Replay): void {
  draft.replays = [replay, ...draft.replays.filter((r) => r.key !== replay.key)].slice(0, 12);
}
