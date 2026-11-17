import { hashString, RNG } from '../core/rng';
import { shiftDate } from '../modes/daily';
import { ProfileStore } from './storage';

export type BoardScope = 'daily' | 'friends' | 'weekly' | 'alltime';
export type BoardMetric = 'score' | 'time' | 'energy';

export interface BoardEntry {
  rank: number;
  player: string;
  score: number;
  /** Completion time in simulated seconds (null for aggregate boards). */
  time: number | null;
  devices: number | null;
  energy: number | null;
  isPlayer: boolean;
  /** True for simulated entries. The UI must label these as demo data. */
  demo: boolean;
  /** Online boards only. */
  userId?: string;
  replayId?: string | null;
  /** Aggregate boards: how many days the total covers. */
  days?: number | null;
}

/**
 * Leaderboard contract. LocalLeaderboard (offline builds) shows the player's own results plus
 * clearly flagged demo rows. OnlineLeaderboard (services/online.ts) reads real, server-verified
 * rankings from the backend.
 */
export interface LeaderboardService {
  /** False while rankings are not coming from a real shared backend. */
  readonly live: boolean;
  getBoard(scope: BoardScope, metric: BoardMetric, date: string): Promise<BoardEntry[]>;
}

const GLOBAL_NAMES = ['Kestrel', 'nova_ql', 'Dr.Momentum', 'Tessellate', 'orbitfox', 'Halcyon', 'QuietTorque', 'm_lagrange', 'Pendulo', 'vectorine', 'Sable', 'IonDrift', 'Curl&Div', 'Hyperbola', 'zephyr04', 'Aphelion', 'TangentTom', 'Lumen', 'Farad', 'Coriolis', 'NullPoint', 'Epsilon', 'drift.king', 'Perigee'];
const FRIEND_NAMES = ['Ada', 'Rosalind', 'Emmy', 'Kelvin', 'Noor'];

function demoRow(name: string, date: string): Omit<BoardEntry, 'rank'> {
  const rng = new RNG(hashString(`demo-${name}-${date}`));
  const skill = (hashString(`skill-${name}`) % 1000) / 1000; // stable per-name ability
  const q = Math.min(1, Math.max(0, skill * 0.7 + rng.next() * 0.4));
  return {
    player: name,
    score: Math.round(48000 + q * 46000),
    time: Math.round((9 - q * 6.5 + rng.range(-0.4, 0.4)) * 100) / 100,
    devices: q > 0.75 ? 1 : q > 0.4 ? 2 : 3,
    energy: Math.round(260000 - q * 200000 + rng.range(0, 30000)),
    isPlayer: false,
    demo: true,
  };
}

export class LocalLeaderboard implements LeaderboardService {
  readonly live = false;
  constructor(private store: ProfileStore) {}

  async getBoard(scope: BoardScope, metric: BoardMetric, date: string): Promise<BoardEntry[]> {
    const save = this.store.get();
    const name = save.settings.playerName || 'You';
    const rows: Omit<BoardEntry, 'rank'>[] = [];

    if (scope === 'daily' || scope === 'friends') {
      const names = scope === 'daily' ? GLOBAL_NAMES : FRIEND_NAMES;
      for (const n of names) rows.push(demoRow(n, date));
      const mine = save.daily.results[date];
      if (mine) rows.push({ player: name, score: mine.bestScore, time: mine.bestTime, devices: mine.bestDevices, energy: mine.bestEnergy, isPlayer: true, demo: false });
      if (metric === 'time') rows.sort((a, b) => a.time! - b.time!);
      else if (metric === 'energy') rows.sort((a, b) => a.energy! - b.energy!);
      else rows.sort((a, b) => b.score - a.score);
    } else {
      // Aggregate boards: total score over the last 7 days, or over every day played.
      const days = scope === 'weekly' ? 7 : 30;
      for (const n of GLOBAL_NAMES) {
        let total = 0;
        for (let i = 0; i < days; i++) {
          // Demo players skip some days, like real ones.
          if (hashString(`plays-${n}-${shiftDate(date, -i)}`) % 10 < 7) total += demoRow(n, shiftDate(date, -i)).score;
        }
        rows.push({ player: n, score: total, time: null, devices: null, energy: null, isPlayer: false, demo: true });
      }
      let mine = 0;
      for (const r of Object.values(save.daily.results)) {
        const age = Math.round((Date.parse(date) - Date.parse(r.date)) / 86400000);
        if (scope === 'alltime' || (age >= 0 && age < 7)) mine += r.bestScore;
      }
      if (mine > 0) rows.push({ player: name, score: mine, time: null, devices: null, energy: null, isPlayer: true, demo: false });
      rows.sort((a, b) => b.score - a.score);
    }
    return rows.map((r, i) => ({ ...r, rank: i + 1 }));
  }
}
