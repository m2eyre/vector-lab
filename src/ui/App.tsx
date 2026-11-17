import { useCallback, useEffect, useMemo, useState } from 'react';
import { TUTORIAL_LEVEL } from '../game/tutorial';
import { dateKey } from '../modes/daily';
import { advanceRun, buildUnlimitedLevel, startRun } from '../modes/unlimited';
import { UNLOCKS } from '../modes/progression';
import { ads } from '../services/ads';
import { ApiError } from '../services/backend';
import { LocalLeaderboard } from '../services/leaderboard';
import { online } from '../services/online';
import { unlockAudio } from '../services/audio';
import { profile, Replay } from '../services/storage';
import { AccountScreen, ProfileModal } from './Account';
import { GameScreen } from './GameScreen';
import { Home } from './Home';
import { HowToPlay, Leaderboards, SettingsScreen, Statistics, UnlimitedHub } from './Screens';
import { Session } from './session';

type View = 'home' | 'game' | 'leaderboards' | 'stats' | 'settings' | 'howto' | 'unlimited' | 'account';
interface Notice { eyebrow: string; text: string; action?: { label: string; run: () => void } }

/** Top-level navigation. Services are created once here and passed down. */
export function App() {
  const [view, setView] = useState<View>('home');
  const [session, setSessionRaw] = useState<Session | null>(null);
  const [nonce, setNonce] = useState(0);
  const setSession = useCallback((s: Session) => { setSessionRaw(s); setNonce((n) => n + 1); }, []);
  const [loading, setLoading] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [returnTo, setReturnTo] = useState<View>('home');
  const [profileId, setProfileId] = useState<string | null>(null);
  const daily = online.dailyProvider;
  // Real rankings when a backend is configured; otherwise the labelled demo board.
  const boards = useMemo(() => (online.getState().configured ? online.leaderboard : new LocalLeaderboard(profile)), []);

  /** Level generation can take a moment, so show the loader for a frame first. */
  const withLoader = useCallback((label: string, work: () => Promise<void> | void) => {
    unlockAudio();
    setLoading(label);
    window.setTimeout(async () => {
      try { await work(); } finally { setLoading(null); }
    }, 60);
  }, []);

  const playDaily = useCallback((date: string = dateKey(), from: View = 'home') => {
    withLoader('Calibrating today\'s arena', async () => {
      const challenge = await daily.getChallenge(date);
      setSession({ mode: 'daily', level: challenge.level, challenge, isToday: date === dateKey() });
      setReturnTo(from);
      setView('game');
    });
  }, [daily, withLoader]);

  const playUnlimited = useCallback((fresh: boolean) => {
    withLoader('Fabricating arena', () => {
      const run = fresh || !profile.get().unlimited.run ? startRun(profile) : profile.get().unlimited.run!;
      const { level, spec } = buildUnlimitedLevel(run);
      setSession({ mode: 'unlimited', level, spec, levelNumber: run.level });
      setReturnTo('unlimited');
      setView('game');
    });
  }, [withLoader]);

  const nextLevel = useCallback(async () => {
    if (session?.mode !== 'unlimited') return;
    const gained = advanceRun(profile, session.spec);
    const names = UNLOCKS.filter((u) => gained.includes(u.id) && u.level > 1).map((u) => `${u.name}`);
    if (names.length) setNotice({ eyebrow: 'Unlocked', text: names.join(' · ') });
    // Between-levels ad opportunity. Resolves immediately unless an ad provider is configured.
    await ads.showInterstitial('between-runs');
    playUnlimited(false);
  }, [session, playUnlimited]);

  const playTutorial = useCallback(() => {
    unlockAudio();
    setSession({ mode: 'tutorial', level: JSON.parse(JSON.stringify(TUTORIAL_LEVEL)) });
    setReturnTo('home');
    setView('game');
  }, []);

  const watchReplay = useCallback((replay: Replay, from: View, rival?: Replay) => {
    unlockAudio();
    setSession({ mode: 'replay', level: replay.level, replay, rival });
    setReturnTo(from);
    setView('game');
  }, []);

  /** Fetch a server-stored replay (leaderboard row, shared link) and play it. */
  const watchRemote = useCallback((id: string, from: View, compareWith?: Replay) => {
    withLoader('Loading replay', async () => {
      try {
        const remote = await online.fetchReplay(id);
        if (compareWith) watchReplay({ ...compareWith, player: 'You' }, from, remote);
        else watchReplay(remote, from);
      } catch (err) {
        const e = err as ApiError;
        if (e.status === 403 && e.body?.locked) setNotice({ eyebrow: 'Replay locked', text: e.message, action: { label: 'Play today\'s challenge', run: () => playDaily() } });
        else setNotice({ eyebrow: 'Replay unavailable', text: e.offline ? 'The server could not be reached.' : e.message });
      }
    });
  }, [withLoader, watchReplay, playDaily]);

  // Shared replay links: ?replay=<id>
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('replay');
    if (!id) return;
    params.delete('replay');
    const rest = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
    if (!online.getState().configured) { setNotice({ eyebrow: 'Replay unavailable', text: 'This build is not connected to the online service, so shared replays cannot be loaded.' }); return; }
    watchRemote(id, 'home');
    // Run once on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), notice.action ? 12000 : 6000);
    return () => window.clearTimeout(id);
  }, [notice]);

  const go = (v: View) => () => setView(v);

  return (
    <div className="app">
      {view === 'home' && (
        <Home onDaily={() => playDaily()} onUnlimited={go('unlimited')} onTutorial={playTutorial} onHowTo={go('howto')}
          onLeaderboards={go('leaderboards')} onStats={go('stats')} onSettings={go('settings')} onAccount={go('account')} />
      )}
      {view === 'game' && session && (
        <GameScreen
          key={nonce}
          session={session}
          onExit={() => setView(returnTo)}
          onNextLevel={nextLevel}
          onLeaderboard={go('leaderboards')}
          onPlayDaily={() => playDaily()}
          onAccount={go('account')}
          onCompare={(mine, theirs) => watchReplay(mine, returnTo, theirs)}
        />
      )}
      {view === 'leaderboards' && (
        <Leaderboards service={boards} onBack={go('home')} onReplay={(r) => watchReplay(r, 'leaderboards')}
          onWatchRemote={(id) => watchRemote(id, 'leaderboards')} onCompareRemote={(id, mine) => watchRemote(id, 'leaderboards', mine)}
          onProfile={setProfileId} onAccount={go('account')} onPlayDaily={() => playDaily(dateKey(), 'leaderboards')} />
      )}
      {view === 'stats' && <Statistics onBack={go('home')} onReplay={(r) => watchReplay(r, 'stats')} onPlayDate={(d) => playDaily(d, 'stats')} />}
      {view === 'settings' && <SettingsScreen onBack={go('home')} onAccount={go('account')} />}
      {view === 'howto' && <HowToPlay onBack={go('home')} onTutorial={playTutorial} />}
      {view === 'unlimited' && <UnlimitedHub onBack={go('home')} onContinue={() => playUnlimited(false)} onRestart={() => playUnlimited(true)} />}
      {view === 'account' && <AccountScreen onBack={go('home')} onWatch={(id) => watchRemote(id, 'account')} onProfile={setProfileId} />}

      {profileId && <ProfileModal userId={profileId} onClose={() => setProfileId(null)} />}
      {loading && (
        <div className="loader" role="status">
          <div className="loader-ring" />
          <span>{loading}…</span>
        </div>
      )}
      {notice && (
        <div className="unlock-toast" role="status">
          <span className="eyebrow">{notice.eyebrow}</span>
          <strong>{notice.text}</strong>
          {notice.action && <button className="btn small primary" onClick={() => { const a = notice.action!; setNotice(null); a.run(); }}>{notice.action.label}</button>}
          <button className="btn small ghost" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
