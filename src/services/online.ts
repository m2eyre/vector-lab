import { Level } from '../game/level';
import { ScoreBreakdown } from '../game/scoring';
import { GENERATOR_VERSION } from '../gen/generator';
import { ChallengeSpec } from '../gen/spec';
import { DailyChallenge, DailyProvider, dateKey, LocalDailyProvider, setUtcDays } from '../modes/daily';
import { Device } from '../physics/types';
import { AuthService, AuthState, createAuth } from './auth';
import { ApiError, Backend, BackendConfig, readBackendConfig } from './backend';
import { BoardEntry, BoardMetric, BoardScope, LeaderboardService } from './leaderboard';
import { DailyResult, defaultSave, profile, ProfileStore, Replay, SaveData, UnlimitedRun } from './storage';

export interface AccountProfile { id: string; name: string; skin: string; joined: string; friendCode: string }
export interface PublicProfile {
  profile: { id: string; name: string; skin: string; joined: string };
  stats: { bestScore: number; dailiesCompleted: number; streak: number; bestStreak: number; highestLevel: number; bestRunScore: number; longestRun: number };
  recent: { date: string; number: number; title: string; score: number; time: number; rank: number }[];
}
export interface Friend { id: string; name: string; skin: string; joined: string }
export interface SubmitResult {
  verified: true;
  date: string;
  score: ScoreBreakdown;
  time: number;
  energy: number;
  devices: number;
  duplicate: boolean;
  improved: boolean;
  first: boolean;
  previousBest: number;
  replayId: string | null;
  best: { score: number; time: number; energy: number };
  rank: number;
  players: number;
}
export interface RemoteReplaySummary { id: string; kind: 'daily' | 'unlimited'; date: string | null; title: string | null; number: number | null; score: number; time: number; energy: number; devicesUsed: number; createdAt: string }

interface ServerProgress {
  unlimited: { highestLevel: number; bestRunScore: number; longestRun: number; runsStarted: number; run: UnlimitedRun | null };
  stats: SaveData['stats'];
  daily: { completed: number; streak: number; bestStreak: number; lastCompleted: string | null; results: DailyResult[] };
  unlocks: string[];
  cosmetics: string[];
  tutorialDone: boolean;
}

export interface OnlineState {
  /** A backend is configured in this build. False means a purely offline build. */
  configured: boolean;
  /** null until the first request settles. */
  reachable: boolean | null;
  auth: AuthState;
  profile: AccountProfile | null;
  syncing: boolean;
  lastSync: number | null;
  /** Today's rank per date, learned from score submissions. */
  ranks: Record<string, { rank: number; players: number }>;
}

/** Merge server progress into the local save. Progress only ever moves forward. */
export function applyProgress(store: ProfileStore, p: ServerProgress): void {
  store.update((d) => {
    const u = d.unlimited;
    u.highestLevel = Math.max(u.highestLevel, p.unlimited.highestLevel);
    u.bestRunScore = Math.max(u.bestRunScore, p.unlimited.bestRunScore);
    u.longestRun = Math.max(u.longestRun ?? 0, p.unlimited.longestRun);
    u.runsStarted = Math.max(u.runsStarted, p.unlimited.runsStarted);
    const remote = p.unlimited.run;
    if (remote && (!u.run || (remote.stamp ?? 0) > (u.run.stamp ?? 0))) u.run = remote;
    for (const k of ['simulations', 'successes', 'failures', 'devicesPlaced', 'simSeconds', 'bestScore', 'levelsCleared'] as const) {
      d.stats[k] = Math.max(d.stats[k], p.stats[k] ?? 0);
    }
    for (const [k, v] of Object.entries(p.stats.byTemplate ?? {})) d.stats.byTemplate[k] = Math.max(d.stats.byTemplate[k] ?? 0, v);
    d.unlocks = Array.from(new Set([...d.unlocks, ...p.unlocks, ...p.cosmetics]));
    d.tutorialDone = d.tutorialDone || p.tutorialDone;
    for (const r of p.daily.results) {
      const mine = d.daily.results[r.date];
      if (!mine) d.daily.results[r.date] = r;
      else if (r.bestScore > mine.bestScore) Object.assign(mine, { bestScore: r.bestScore, bestTime: r.bestTime, bestEnergy: r.bestEnergy, bestDevices: r.bestDevices });
    }
    d.daily.bestStreak = Math.max(d.daily.bestStreak, p.daily.bestStreak);
    if (p.daily.lastCompleted && (!d.daily.lastCompleted || p.daily.lastCompleted >= d.daily.lastCompleted)) {
      d.daily.streak = p.daily.lastCompleted === d.daily.lastCompleted ? Math.max(d.daily.streak, p.daily.streak) : p.daily.streak;
      d.daily.lastCompleted = p.daily.lastCompleted;
    }
  });
}

function syncPayload(d: SaveData) {
  return {
    unlimited: { highestLevel: d.unlimited.highestLevel, bestRunScore: d.unlimited.bestRunScore, longestRun: d.unlimited.longestRun ?? 0, runsStarted: d.unlimited.runsStarted, run: d.unlimited.run },
    stats: d.stats,
    unlocks: d.unlocks.filter((x) => !x.startsWith('cosmetic:')),
    cosmetics: d.unlocks.filter((x) => x.startsWith('cosmetic:')),
    tutorialDone: d.tutorialDone,
  };
}

/**
 * Everything online in one place: account state, the published daily, verified score
 * submission, cloud progress and social data. When no backend is configured, or it cannot be
 * reached, every method degrades to the local game, which stays fully playable.
 */
export class OnlineService {
  readonly backend: Backend | null;
  readonly auth: AuthService | null;
  private state: OnlineState;
  private listeners = new Set<() => void>();
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPayload = '';
  private applying = false;
  private local: LocalDailyProvider;

  constructor(private store: ProfileStore, readonly config: BackendConfig | null = readBackendConfig()) {
    this.local = new LocalDailyProvider(store);
    this.auth = config ? createAuth(config) : null;
    this.backend = config ? new Backend(config, () => this.auth!.getToken()) : null;
    this.state = { configured: !!config, reachable: null, auth: this.auth?.getState() ?? { status: 'guest', userId: null, email: null }, profile: null, syncing: false, lastSync: null, ranks: {} };
    if (!config) return;
    // With a backend, everyone shares the server's UTC calendar day.
    setUtcDays(true);
    this.auth!.subscribe(() => this.onAuth());
    this.store.subscribe(() => this.scheduleSync());
    this.onAuth();
  }

  getState = (): OnlineState => this.state;
  subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  private set(patch: Partial<OnlineState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  get signedIn(): boolean { return this.state.auth.status === 'signedIn'; }

  private async call<T>(fn: (b: Backend) => Promise<T>): Promise<T> {
    if (!this.backend) throw new ApiError(0, 'Online features are not configured in this build.');
    try {
      const out = await fn(this.backend);
      if (this.state.reachable !== true) this.set({ reachable: true });
      return out;
    } catch (err) {
      if (err instanceof ApiError && err.offline && this.state.reachable !== false) this.set({ reachable: false });
      throw err;
    }
  }

  // ---- account ---------------------------------------------------------------------------
  private async onAuth(): Promise<void> {
    const auth = this.auth!.getState();
    const was = this.state.auth;
    this.set({ auth, profile: auth.status === 'signedIn' ? this.state.profile : null });
    if (auth.status !== 'signedIn' || (was.status === 'signedIn' && was.userId === auth.userId && this.state.profile)) return;
    try {
      const me = await this.call((b) => b.get<{ profile: AccountProfile; progress: ServerProgress }>('/me'));
      this.set({ profile: me.profile });
      // Adopt the local display name the first time, if the player already chose one.
      const localName = this.store.get().settings.playerName.trim();
      if (/^Pilot-/.test(me.profile.name) && localName && localName !== 'You') await this.rename(localName).catch(() => {});
      else if (me.profile.name !== localName) this.store.update((d) => { d.settings.playerName = this.state.profile?.name ?? me.profile.name; });
      await this.sync(true);
      await this.submitPendingDaily();
    } catch (err) {
      // A rejected token means the session is gone; anything else is a network problem.
      if (err instanceof ApiError && err.status === 401) await this.auth!.signOut().catch(() => {});
    }
  }

  async rename(name: string): Promise<void> {
    const res = await this.call((b) => b.post<{ profile: AccountProfile }>('/me', { displayName: name }));
    this.set({ profile: res.profile });
    this.store.update((d) => { d.settings.playerName = res.profile.name; });
  }

  async setSkin(skin: string): Promise<void> {
    if (!this.signedIn) return;
    const res = await this.call((b) => b.post<{ profile: AccountProfile }>('/me', { skin })).catch(() => null);
    if (res) this.set({ profile: res.profile });
  }

  /** Sign out and clear this device's copy of the account's progress (settings are kept). */
  async signOut(): Promise<void> {
    if (!this.auth) return;
    await this.sync(true).catch(() => {});
    await this.auth.signOut();
    const settings = this.store.get().settings;
    this.applying = true;
    this.store.reset();
    this.store.update((d) => { d.settings = { ...settings, playerName: defaultSave().settings.playerName }; d.tutorialDone = true; });
    this.applying = false;
    this.lastPayload = '';
    this.set({ profile: null, lastSync: null, ranks: {} });
  }

  // ---- cloud progress --------------------------------------------------------------------
  private scheduleSync(): void {
    if (this.applying || !this.signedIn) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => { this.sync().catch(() => {}); }, 3000);
  }

  async sync(force = false): Promise<void> {
    if (!this.signedIn || this.state.syncing) return;
    const payload = syncPayload(this.store.get());
    const text = JSON.stringify(payload);
    if (!force && text === this.lastPayload) return;
    this.set({ syncing: true });
    try {
      const res = await this.call((b) => b.post<{ progress: ServerProgress }>('/sync', payload));
      this.applying = true;
      applyProgress(this.store, res.progress);
      this.applying = false;
      this.lastPayload = JSON.stringify(syncPayload(this.store.get()));
      this.set({ syncing: false, lastSync: Date.now() });
    } catch (err) {
      this.applying = false;
      this.set({ syncing: false });
      throw err;
    }
  }

  // ---- daily challenge -------------------------------------------------------------------
  /**
   * The published challenge when the server can be reached; otherwise the last published
   * copy cached on this device; otherwise the deterministic local generator. The game is
   * therefore always playable, and `published` says which of these the player got.
   */
  readonly dailyProvider: DailyProvider = {
    getChallenge: async (key: string): Promise<DailyChallenge> => {
      if (!this.backend) return this.local.getChallenge(key);
      try {
        const res = await this.call((b) => b.request<{ today: string; challenge: { date: string; number: number; title: string; difficulty: number; seed: number; spec: ChallengeSpec; level: Level; source: 'ai' | 'procedural' } }>('GET', `/daily?date=${key}`, undefined, 30000));
        const c = res.challenge;
        if (key === res.today) {
          this.applying = true;
          this.store.update((d) => { d.daily.cache = { date: key, generator: GENERATOR_VERSION, spec: c.spec, level: c.level, published: true, number: c.number, source: c.source }; });
          this.applying = false;
        }
        return { date: c.date, number: c.number, title: c.title, difficulty: c.difficulty, seed: c.seed, spec: c.spec, level: c.level, published: true, source: c.source };
      } catch (err) {
        // 404: the server is fine but never published that (past) date. Anything else: unreachable.
        const unpublished = err instanceof ApiError && err.status === 404;
        if (unpublished) return { ...(await this.local.getChallenge(key)), published: false, fallbackReason: 'unpublished' };
        const cache = this.store.get().daily.cache;
        if (cache && cache.published && cache.date === key) {
          return { date: key, number: cache.number ?? 0, title: cache.spec.title, difficulty: cache.spec.difficulty, seed: cache.spec.seed, spec: cache.spec, level: cache.level, published: true, source: cache.source as 'ai' | 'procedural' };
        }
        return { ...(await this.local.getChallenge(key)), published: false, fallbackReason: 'offline' };
      }
    },
  };

  async submitDaily(date: string, devices: Device[]): Promise<SubmitResult> {
    const res = await this.call((b) => b.post<SubmitResult>('/scores', { date, devices }));
    this.set({ ranks: { ...this.state.ranks, [date]: { rank: res.rank, players: res.players } } });
    if (res.replayId) {
      this.applying = true;
      this.store.update((d) => {
        const r = d.replays.find((x) => x.key === `daily:${date}`);
        if (r && Math.round(r.score) === res.score.total) r.remoteId = res.replayId!;
      });
      this.applying = false;
    }
    return res;
  }

  /** After signing in, post the best solution this device already has for today. */
  private async submitPendingDaily(): Promise<void> {
    const today = dateKey();
    const r = this.store.get().replays.find((x) => x.key === `daily:${today}`);
    if (!r || r.remoteId || !this.store.get().daily.cache?.published) return;
    await this.submitDaily(today, r.devices).catch(() => {});
  }

  // ---- leaderboards, replays, social -----------------------------------------------------
  readonly leaderboard: LeaderboardService = {
    live: true,
    getBoard: async (scope: BoardScope, metric: BoardMetric, date: string): Promise<BoardEntry[]> => {
      const res = await this.call((b) => b.get<{ entries: (Omit<BoardEntry, 'demo'>)[] }>(`/leaderboard?scope=${scope}&metric=${metric}&date=${date}`));
      return res.entries.map((e) => ({ ...e, demo: false }));
    },
  };

  async fetchReplay(id: string): Promise<Replay> {
    const { replay: r } = await this.call((b) => b.get<{ replay: any }>(`/replay?id=${encodeURIComponent(id)}`));
    const what = r.kind === 'daily' ? `Daily #${r.number} · ${r.title}` : `${r.title ?? 'Unlimited'}`;
    return { key: `remote:${r.id}`, label: `${r.player} · ${what}`, level: r.level, devices: r.devices, score: r.score, time: r.time, energy: r.energy, savedAt: r.createdAt, remoteId: r.id, player: r.player, date: r.date ?? undefined };
  }
  async myReplays(): Promise<RemoteReplaySummary[]> {
    return (await this.call((b) => b.get<{ replays: RemoteReplaySummary[] }>('/replays'))).replays;
  }
  /** Upload an Unlimited solution so it can be shared by link. Verified, but never ranked. */
  async shareSolution(level: Level, devices: Device[], label: string): Promise<string> {
    return (await this.call((b) => b.post<{ replayId: string }>('/replays', { level, devices, label }))).replayId;
  }
  async friends(): Promise<Friend[]> { return (await this.call((b) => b.get<{ friends: Friend[] }>('/friends'))).friends; }
  async addFriend(code: string): Promise<Friend[]> { return (await this.call((b) => b.post<{ friends: Friend[] }>('/friends', { code }))).friends; }
  async removeFriend(id: string): Promise<Friend[]> { return (await this.call((b) => b.del<{ friends: Friend[] }>(`/friends?id=${id}`))).friends; }
  async publicProfile(id: string): Promise<PublicProfile> { return this.call((b) => b.get<PublicProfile>(`/profile?id=${id}`)); }

  replayLink(id: string): string {
    const base = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : '';
    return `${base}?replay=${id}`;
  }
}

export const online = new OnlineService(profile);
