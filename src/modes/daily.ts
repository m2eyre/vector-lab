import { RuleBasedDesigner } from '../ai/designer';
import { hashString, RNG } from '../core/rng';
import { generateLevel, GENERATOR_VERSION } from '../gen/generator';
import { Signature, signatureOf } from '../gen/signature';
import { ChallengeSpec, TEMPLATE_IDS, TemplateId } from '../gen/spec';
import { Level } from '../game/level';
import { RunMetrics } from '../game/scoring';
import { ProfileStore } from '../services/storage';

export interface DailyChallenge {
  date: string;
  number: number;
  title: string;
  difficulty: number;
  seed: number;
  spec: ChallengeSpec;
  level: Level;
  /** True when this exact level came from the server's published record for the date. */
  published?: boolean;
  /** How the published challenge was designed. */
  source?: 'ai' | 'procedural';
  /** Why a backend-connected game fell back to local generation. */
  fallbackReason?: 'offline' | 'unpublished';
}

const EPOCH = Date.UTC(2026, 0, 1);
const DAY = 86400000;
/** Monday..Sunday difficulty curve: the week ramps up and peaks at the weekend. */
const WEEK_CURVE = [3, 2, 2, 3, 3, 4, 4]; // index = Date.getUTCDay(), 0 = Sunday

let utcDays = false;
/**
 * Offline, the daily rolls over at the player's local midnight. When a backend publishes the
 * challenge, every player shares the server's UTC calendar day instead.
 */
export function setUtcDays(on: boolean): void { utcDays = on; }

export function utcDateKey(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Today's challenge date as YYYY-MM-DD (local calendar offline, UTC when online). */
export function dateKey(d: Date = new Date()): string {
  if (utcDays) return utcDateKey(d);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function keyToUTC(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function shiftDate(key: string, days: number): string {
  const t = new Date(keyToUTC(key) + days * DAY);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

export function challengeNumber(key: string): number {
  return Math.round((keyToUTC(key) - EPOCH) / DAY) + 1;
}

export function dailySeed(key: string): number {
  return hashString(`VECTOR-LAB-DAILY-${key}`);
}

/** Target difficulty for a date (the weekly curve). */
export function dailyDifficulty(key: string): number {
  return WEEK_CURVE[new Date(keyToUTC(key)).getUTCDay()];
}

export function isDateKey(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = keyToUTC(v);
  return Number.isFinite(t) && shiftDate(v, 0) === v;
}

const CYCLE = TEMPLATE_IDS.length;

/** Template order for one cycle: a seeded shuffle, so every challenge type appears once per cycle. */
function cycleOrder(cycle: number): TemplateId[] {
  const order = new RNG(hashString(`VL-CYCLE-${cycle}`)).shuffle(TEMPLATE_IDS);
  if (cycle > 0) {
    const prev = new RNG(hashString(`VL-CYCLE-${cycle - 1}`)).shuffle(TEMPLATE_IDS);
    // Never repeat a template across a cycle boundary.
    if (order[0] === prev[prev.length - 1]) [order[0], order[1]] = [order[1], order[0]];
  }
  return order;
}

const designer = new RuleBasedDesigner();

/**
 * The spec for a given date. Purely a function of the date: specs are designed in order from
 * the start of the date's cycle, each seeing the signatures of the days before it, so the
 * variety logic is deterministic and identical for every player.
 */
export function dailySpec(key: string): ChallengeSpec {
  const n = challengeNumber(key);
  const index = ((n % CYCLE) + CYCLE) % CYCLE;
  const cycle = Math.floor(n / CYCLE);
  const order = cycleOrder(Math.max(0, cycle));
  const history: Signature[] = [];
  let spec!: ChallengeSpec;
  for (let i = 0; i <= index; i++) {
    const k = shiftDate(key, i - index);
    const weekday = new Date(keyToUTC(k)).getUTCDay();
    spec = designer.designSync({
      seed: dailySeed(k),
      difficulty: WEEK_CURVE[weekday],
      history,
      template: order[i],
      // Daily challenges always draw from the complete toolset, whatever the player has unlocked.
      allowedTools: ['attractor', 'repulsor', 'vortex', 'field'],
    });
    history.push(signatureOf(spec));
  }
  return spec;
}

export function buildDaily(key: string, spec: ChallengeSpec = dailySpec(key)): DailyChallenge {
  const { level } = generateLevel(spec);
  level.id = `daily-${key}`;
  return { date: key, number: challengeNumber(key), title: spec.title, difficulty: spec.difficulty, seed: spec.seed, spec, level };
}

/** Where daily challenges come from. A server-published implementation can replace the local one. */
export interface DailyProvider {
  getChallenge(key: string): Promise<DailyChallenge>;
}

/** Generates the daily on-device from the date seed and caches today's result. */
export class LocalDailyProvider implements DailyProvider {
  constructor(private store: ProfileStore) {}
  async getChallenge(key: string): Promise<DailyChallenge> {
    const cache = this.store.get().daily.cache;
    if (cache && cache.date === key && cache.generator === GENERATOR_VERSION && !cache.published) {
      const { spec, level } = cache;
      return { date: key, number: challengeNumber(key), title: spec.title, difficulty: spec.difficulty, seed: spec.seed, spec, level };
    }
    const ch = buildDaily(key);
    if (key === dateKey()) {
      this.store.update((d) => { d.daily.cache = { date: key, generator: GENERATOR_VERSION, spec: ch.spec, level: ch.level }; });
    }
    return ch;
  }
}

/** Record a completed daily run. Returns whether it was a personal best and a first clear. */
export function recordDaily(store: ProfileStore, ch: DailyChallenge, score: number, m: RunMetrics): { best: boolean; first: boolean; previousBest: number } {
  let best = false;
  let first = false;
  let previousBest = 0;
  store.update((d) => {
    const existing = d.daily.results[ch.date];
    previousBest = existing?.bestScore ?? 0;
    first = !existing;
    best = score > previousBest;
    if (!existing) {
      d.daily.results[ch.date] = {
        date: ch.date, number: ch.number, title: ch.title, difficulty: ch.difficulty,
        bestScore: score, bestTime: m.time, bestEnergy: m.energy, bestDevices: m.devicesUsed,
        firstScore: score, completions: 1, completedAt: new Date().toISOString(),
      };
      // Streak: only today's challenge extends it, and only if yesterday was also cleared.
      if (ch.date === dateKey()) {
        d.daily.streak = d.daily.lastCompleted === shiftDate(ch.date, -1) ? d.daily.streak + 1 : 1;
        d.daily.bestStreak = Math.max(d.daily.bestStreak, d.daily.streak);
        d.daily.lastCompleted = ch.date;
      }
    } else {
      existing.completions++;
      if (best) {
        existing.bestScore = score;
        existing.bestTime = m.time;
        existing.bestEnergy = m.energy;
        existing.bestDevices = m.devicesUsed;
      }
    }
  });
  return { best, first, previousBest };
}

/** The streak as it should be displayed today (it lapses if yesterday was missed). */
export function currentStreak(store: ProfileStore, today = dateKey()): number {
  const d = store.get().daily;
  if (!d.lastCompleted) return 0;
  return d.lastCompleted === today || d.lastCompleted === shiftDate(today, -1) ? d.streak : 0;
}
