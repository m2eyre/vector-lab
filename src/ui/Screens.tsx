import { useEffect, useState } from 'react';
import { DEVICE_COLORS } from '../game/controller';
import { formatEnergy } from '../game/scoring';
import { TEMPLATES, TemplateId } from '../gen/spec';
import { challengeNumber, currentStreak, dateKey, shiftDate } from '../modes/daily';
import { nextUnlock, SKINS, skinUnlocked, UNLOCKS } from '../modes/progression';
import { difficultyForLevel } from '../modes/unlimited';
import { DEVICE_TYPES } from '../physics/types';
import { BoardEntry, BoardMetric, BoardScope, LeaderboardService } from '../services/leaderboard';
import { profile, Replay } from '../services/storage';
import { DEVICE_INFO, DeviceIcon, difficultyName, fmtScore, fmtTime, Pips, Screen } from './common';
import { online } from '../services/online';
import { ads } from '../services/ads';
import { AdSlot } from './AdSlot';
import { useAdsConfigured, useOnline, useProfile } from './hooks';

// ---------------------------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------------------------
const SCOPES: { id: BoardScope; label: string }[] = [
  { id: 'daily', label: 'Global' },
  { id: 'friends', label: 'Friends' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'alltime', label: 'All-time' },
];
const METRICS: { id: BoardMetric; label: string }[] = [
  { id: 'score', label: 'Highest score' },
  { id: 'time', label: 'Fastest' },
  { id: 'energy', label: 'Lowest energy' },
];

interface BoardProps {
  service: LeaderboardService;
  onBack: () => void;
  onReplay: (r: Replay) => void;
  onWatchRemote: (replayId: string) => void;
  onCompareRemote: (replayId: string, mine: Replay) => void;
  onProfile: (userId: string) => void;
  onAccount: () => void;
  onPlayDaily: () => void;
}

export function Leaderboards({ service, onBack, onReplay, onWatchRemote, onCompareRemote, onProfile, onAccount, onPlayDaily }: BoardProps) {
  const save = useProfile();
  const net = useOnline();
  const [scope, setScope] = useState<BoardScope>('daily');
  const [metric, setMetric] = useState<BoardMetric>('score');
  const [rows, setRows] = useState<BoardEntry[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const today = dateKey();
  const [date, setDate] = useState(today);
  const aggregate = scope === 'weekly' || scope === 'alltime';
  const activeMetric = aggregate ? 'score' : metric;
  const signedIn = net.auth.status === 'signedIn';
  const needsSignIn = service.live && scope === 'friends' && !signedIn;
  const myResults = Object.keys(save.daily.results).length;

  useEffect(() => {
    let alive = true;
    if (needsSignIn) { setRows([]); setState('ready'); return; }
    setState('loading');
    service.getBoard(scope, activeMetric, date)
      .then((r) => { if (alive) { setRows(r); setState('ready'); } })
      .catch((err) => { if (alive) { setRows([]); setError(err?.offline ? 'The leaderboard server could not be reached.' : err?.message ?? 'Could not load the leaderboard.'); setState('error'); } });
    return () => { alive = false; };
  }, [service, scope, activeMetric, date, reload, needsSignIn, myResults, net.auth.userId, net.ranks]);

  const myReplay = save.replays.find((r) => r.key === `daily:${date}`);
  const mine = rows.find((r) => r.isPlayer);
  const hasToday = !!save.daily.results[today];
  const lockedReplays = service.live && date === today && !hasToday;

  return (
    <Screen title="Leaderboards" onBack={onBack}>
      {!service.live ? (
        <div className="banner">
          <strong>Demo data.</strong> This build is not connected to the online service. Every row except yours is simulated on this device and marked DEMO. Your own results are real and stored locally.
        </div>
      ) : !signedIn && (
        <div className="banner">
          <strong>Live rankings.</strong> Every score here was re-simulated and verified by the server. You are playing as a guest, so your scores are not posted. <button className="link" onClick={onAccount}>Sign in to compete</button>
        </div>
      )}
      <div className="tabs" role="tablist">
        {SCOPES.map((s) => <button key={s.id} role="tab" aria-selected={scope === s.id} className={scope === s.id ? 'on' : ''} onClick={() => setScope(s.id)}>{s.label}</button>)}
      </div>
      {!aggregate ? (
        <div className="segmented" role="group" aria-label="Ranking">
          {METRICS.map((m) => <button key={m.id} className={metric === m.id ? 'on' : ''} onClick={() => setMetric(m.id)}>{m.label}</button>)}
        </div>
      ) : (
        <p className="muted">{scope === 'weekly' ? 'Total of each player\'s best daily scores over the 7 days ending on this date.' : 'Total of every daily best on record.'}</p>
      )}
      <div className="board-head">
        <span className="date-nav">
          <button className="btn small ghost" aria-label="Previous day" onClick={() => setDate(shiftDate(date, -1))}>‹</button>
          <b>{scope === 'alltime' ? 'All-time' : scope === 'weekly' ? `Week to ${date.slice(5)}` : `Daily #${challengeNumber(date)} · ${date === today ? 'Today' : date.slice(5)}`}</b>
          <button className="btn small ghost" aria-label="Next day" disabled={date >= today} onClick={() => setDate(shiftDate(date, 1))}>›</button>
        </span>
        <span id="board-summary">{mine ? `You are #${mine.rank} of ${rows.length}` : needsSignIn ? '' : signedIn || !service.live ? (date === today ? 'Complete today\'s challenge to appear here' : 'You have no result for this day') : `${rows.length} player${rows.length === 1 ? '' : 's'}`}</span>
      </div>
      {needsSignIn ? (
        <div className="empty"><p>Friends rankings need an account, so we know who your friends are.</p><button className="btn primary" onClick={onAccount}>Sign in</button></div>
      ) : state === 'error' ? (
        <div className="empty" role="alert"><p>{error}</p><button className="btn" onClick={() => setReload((n) => n + 1)}>Try again</button></div>
      ) : state === 'ready' && rows.length === 0 ? (
        <div className="empty">
          <p>{scope === 'friends' ? 'None of your friends has a score here yet. Add friends by code on the Account screen.' : 'No verified scores yet. Be the first.'}</p>
          {date === today && <button className="btn primary" onClick={onPlayDaily}>Play today's challenge</button>}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="board" id="board-table" aria-busy={state === 'loading'}>
            <thead>
              <tr><th>Rank</th><th>Player</th><th className="num">Score</th>{!aggregate ? <><th className="num">Time</th><th className="num hide-sm">Devices</th><th className="num hide-sm">Energy</th></> : <th className="num">Days</th>}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={(r.userId ?? r.player) + r.rank} className={r.isPlayer ? 'me' : ''}>
                  <td className="mono">{r.rank}</td>
                  <td>
                    {r.userId ? <button className="link name" onClick={() => onProfile(r.userId!)}>{r.player}</button> : r.player}
                    {r.demo && <span className="tag">DEMO</span>}{r.isPlayer && <span className="tag you">YOU</span>}
                    {!aggregate && r.replayId && !lockedReplays && <button className="link" data-watch={r.rank} onClick={() => onWatchRemote(r.replayId!)}>Watch</button>}
                    {!aggregate && r.replayId && !lockedReplays && !r.isPlayer && myReplay && <button className="link" data-compare={r.rank} onClick={() => onCompareRemote(r.replayId!, myReplay)}>Compare</button>}
                    {!service.live && r.isPlayer && myReplay && !aggregate && <button className="link" onClick={() => onReplay(myReplay)}>Watch replay</button>}
                  </td>
                  <td className="num mono">{fmtScore(r.score)}</td>
                  {!aggregate ? <><td className="num mono">{r.time === null ? '—' : fmtTime(r.time)}</td><td className="num mono hide-sm">{r.devices ?? '—'}</td><td className="num mono hide-sm">{r.energy === null ? '—' : `${formatEnergy(r.energy)} kJ`}</td></>
                    : <td className="num mono">{r.days ?? '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {lockedReplays && rows.length > 0 && <p className="muted">Solve today's challenge to unlock other players' replays. Earlier days are always open.</p>}
    </Screen>
  );
}

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------
export function Statistics({ onBack, onReplay, onPlayDate }: { onBack: () => void; onReplay: (r: Replay) => void; onPlayDate: (date: string) => void }) {
  const save = useProfile();
  const s = save.stats;
  const today = dateKey();
  const dailies = Object.values(save.daily.results).sort((a, b) => (a.date < b.date ? 1 : -1));
  const rate = s.simulations ? Math.round((s.successes / s.simulations) * 100) : 0;
  const tiles: [string, string][] = [
    ['Daily streak', `${currentStreak(profile, today)}`],
    ['Best streak', `${save.daily.bestStreak}`],
    ['Dailies cleared', `${dailies.length}`],
    ['Best score', s.bestScore ? fmtScore(s.bestScore) : '—'],
    ['Simulations run', `${s.simulations}`],
    ['Success rate', s.simulations ? `${rate}%` : '—'],
    ['Unlimited best level', `${save.unlimited.highestLevel}`],
    ['Best run score', save.unlimited.bestRunScore ? fmtScore(save.unlimited.bestRunScore) : '—'],
    ['Longest run', `${save.unlimited.longestRun ?? 0} levels`],
    ['Generators placed', `${s.devicesPlaced}`],
    ['Time simulated', `${Math.round(s.simSeconds)}s`],
  ];
  const week = Array.from({ length: 7 }, (_, i) => shiftDate(today, -i));
  const templates = Object.entries(s.byTemplate).sort((a, b) => b[1] - a[1]);
  return (
    <Screen title="Statistics" onBack={onBack}>
      <div className="tiles">
        {tiles.map(([k, v]) => <div className="tile" key={k}><span className="eyebrow">{k}</span><b className="mono">{v}</b></div>)}
      </div>

      <h2 className="section">Daily challenges · last 7 days</h2>
      <div className="table-wrap">
        <table className="board">
          <thead><tr><th>Date</th><th>Challenge</th><th className="num">Best</th><th className="num hide-sm">Time</th><th /></tr></thead>
          <tbody>
            {week.map((date) => {
              const r = save.daily.results[date];
              const replay = save.replays.find((x) => x.key === `daily:${date}`);
              return (
                <tr key={date}>
                  <td className="mono">{date.slice(5)}</td>
                  <td>#{challengeNumber(date)} {r ? r.title : <span className="muted">not played</span>}</td>
                  <td className="num mono">{r ? fmtScore(r.bestScore) : '—'}</td>
                  <td className="num mono hide-sm">{r ? fmtTime(r.bestTime) : '—'}</td>
                  <td className="num">
                    {replay && <button className="link" onClick={() => onReplay(replay)}>Replay</button>}
                    <button className="link" onClick={() => onPlayDate(date)}>{date === today ? 'Play' : 'Play archive'}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted">Archive plays update your best score for that day but never change your streak.</p>

      {dailies.length > 7 && <p className="muted">{dailies.length} daily challenges cleared in total.</p>}

      {templates.length > 0 && (
        <>
          <h2 className="section">Clears by challenge type</h2>
          <div className="type-bars">
            {templates.map(([id, n]) => (
              <div className="bar-row" key={id}>
                <span className="bar-label">{TEMPLATES[id as TemplateId]?.name ?? 'Tutorial'}</span>
                <span className="bar"><i style={{ width: `${(n / templates[0][1]) * 100}%` }} /></span>
                <span className="bar-value mono">{n}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {save.replays.length > 0 && (
        <>
          <h2 className="section">Saved solutions</h2>
          <ul className="replays">
            {save.replays.map((r) => (
              <li key={r.key}><span>{r.label}</span><span className="mono">{fmtScore(r.score)}</span><button className="link" onClick={() => onReplay(r)}>Watch</button></li>
            ))}
          </ul>
        </>
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------
export function SettingsScreen({ onBack, onAccount }: { onBack: () => void; onAccount: () => void }) {
  const save = useProfile();
  const net = useOnline();
  const adsOn = useAdsConfigured();
  const signedIn = net.auth.status === 'signedIn';
  const st = save.settings;
  const [confirm, setConfirm] = useState(false);
  const set = (patch: Partial<typeof st>) => profile.update((d) => { Object.assign(d.settings, patch); });
  const toggle = (id: string, key: 'trails' | 'vectors' | 'forecast' | 'sound' | 'reducedMotion', label: string, hint: string) => (
    <label className="switch row" htmlFor={id}>
      <input id={id} type="checkbox" checked={st[key]} onChange={(e) => set({ [key]: e.target.checked })} />
      <span><b>{label}</b><small>{hint}</small></span>
    </label>
  );
  return (
    <Screen title="Settings" onBack={onBack}>
      <h2 className="section">Player</h2>
      {signedIn ? (
        <p className="muted">Signed in as <b>{net.profile?.name ?? '…'}</b>. <button className="link" onClick={onAccount}>Manage account and display name</button></p>
      ) : (
        <>
          <label className="field" htmlFor="player-name">
            <span>Display name</span>
            <input id="player-name" type="text" maxLength={16} value={st.playerName} onChange={(e) => set({ playerName: e.target.value })} />
          </label>
          {net.configured && <p className="muted">Playing as a guest. <button className="link" onClick={onAccount}>Sign in</button> to save progress to your account and compete.</p>}
        </>
      )}

      <h2 className="section">Visuals and sound</h2>
      {toggle('set-trails', 'trails', 'Trajectory trails', 'Draw the path each object has travelled')}
      {toggle('set-vectors', 'vectors', 'Force vectors', 'Overlay the net force from your generators')}
      {toggle('set-forecast', 'forecast', 'Path forecast', 'Dotted preview of the first 1.6 seconds while you set up')}
      {toggle('set-sound', 'sound', 'Sound effects', 'Short synthesised cues')}
      {toggle('set-motion', 'reducedMotion', 'Reduced motion', 'Turn off particles and ambient animation')}

      <h2 className="section">Object skin</h2>
      <div className="skins">
        {SKINS.map((s) => {
          const open = skinUnlocked(s, Math.max(save.unlimited.highestLevel + 1, save.unlimited.run?.level ?? 1)) || save.unlocks.includes(`cosmetic:${s.id}`);
          return (
            <div className="skin-cell" key={s.id}>
              <button className={`skin${st.skin === s.id ? ' on' : ''}`} disabled={!open} onClick={() => { set({ skin: s.id }); online.setSkin(s.id); }}>
                <span className="swatches">{s.colors.slice(0, 3).map((c) => <i key={c} style={{ background: c }} />)}</span>
                <b>{s.name}</b>
                <small>{open ? (st.skin === s.id ? 'Equipped' : 'Unlocked') : `Reach Unlimited level ${s.unlockLevel}`}</small>
              </button>
              {/* Optional rewarded ad. Only rendered when an ad provider is configured. */}
              {!open && adsOn && (
                <button className="link" onClick={async () => { if (await ads.showRewarded('rewarded-cosmetic')) profile.update((d) => { d.unlocks = Array.from(new Set([...d.unlocks, `cosmetic:${s.id}`])); }); }}>Unlock early with an ad</button>
              )}
            </div>
          );
        })}
      </div>

      <h2 className="section">Data</h2>
      <p className="muted">{signedIn ? 'Progress is saved to your account and kept in this browser. Erasing here clears this device only; signing in again restores your account progress.' : 'Progress is saved in this browser only. Clearing site data erases it.'}</p>
      {!confirm ? (
        <button className="btn danger" onClick={() => setConfirm(true)}>Erase all progress</button>
      ) : (
        <div className="confirm">
          <span>Erase streak, scores, unlocks and replays?</span>
          <button className="btn danger" onClick={() => { profile.reset(); setConfirm(false); }}>Yes, erase</button>
          <button className="btn" onClick={() => setConfirm(false)}>Cancel</button>
        </div>
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------------------------------------
// How to play
// ---------------------------------------------------------------------------------------------
export function HowToPlay({ onBack, onTutorial }: { onBack: () => void; onTutorial: () => void }) {
  return (
    <Screen title="How to Play" onBack={onBack}>
      <p className="lead">You never move the objects. You build the force field they move through, press Run, and see if your idea holds.</p>
      <ol className="loop">
        <li><b>Read the arena.</b> Objects glow, targets pulse, red plasma destroys.</li>
        <li><b>Place generators.</b> Pick one from the toolbar and click the arena. Drag to move it, drag the white handle to resize or aim it.</li>
        <li><b>Run.</b> Watch, then adjust and run again. Attempts are unlimited and only your best score counts.</li>
      </ol>
      <button className="btn primary" onClick={onTutorial}>Play the tutorial</button>

      <h2 className="section">Generators</h2>
      <div className="gen-list">
        {DEVICE_TYPES.map((t) => (
          <div className="gen" key={t} style={{ ['--tool' as string]: DEVICE_COLORS[t] }}>
            <DeviceIcon type={t} size={36} />
            <div><b>{DEVICE_INFO[t].name}</b><span>{DEVICE_INFO[t].hint}. {t === 'attractor' ? 'Objects overshoot and swing back, so a short pull is often better than a strong one.' : t === 'repulsor' ? 'Strongest at its centre. Good for a launch or for guarding a hazard.' : t === 'vortex' ? 'Bends paths around corners. Flip its rotation in the side panel.' : 'Uniform push inside the strip. Drag the handle to aim and stretch it.'}</span></div>
          </div>
        ))}
      </div>

      <h2 className="section">Physics you can rely on</h2>
      <ul className="facts">
        <li>Forces from every generator add together. Acceleration is force divided by mass, so heavy objects respond slowly.</li>
        <li>Drag bleeds off speed everywhere except in superfluid zones. Gel zones brake hard.</li>
        <li>The simulation is deterministic. The same setup always gives the same result, at any viewing speed.</li>
      </ul>

      <h2 className="section">Scoring (0 to 100,000)</h2>
      <ul className="facts">
        <li><b>40,000</b> for completing the objective.</li>
        <li><b>25,000</b> for speed against the level's par time.</li>
        <li><b>20,000</b> for low energy: the work your generators do on the objects.</li>
        <li><b>15,000</b> for using fewer generators.</li>
      </ul>

      <h2 className="section">Controls</h2>
      <ul className="facts keys-list">
        <li><kbd>Space</kbd> run or pause</li><li><kbd>R</kbd> reset</li><li><kbd>1</kbd>–<kbd>4</kbd> pick a generator</li><li><kbd>Del</kbd> remove the selected generator</li><li><kbd>Esc</kbd> deselect</li>
      </ul>
    </Screen>
  );
}

// ---------------------------------------------------------------------------------------------
// Unlimited hub / progression
// ---------------------------------------------------------------------------------------------
export function UnlimitedHub({ onBack, onContinue, onRestart }: { onBack: () => void; onContinue: () => void; onRestart: () => void }) {
  const save = useProfile();
  const net = useOnline();
  const u = save.unlimited;
  const run = u.run;
  const [confirm, setConfirm] = useState(false);
  const reached = Math.max(u.highestLevel + 1, run?.level ?? 1);
  const upcoming = nextUnlock(reached);
  const KIND = { tool: 'Generator', template: 'Challenge', modifier: 'Modifier', cosmetic: 'Cosmetic' };
  return (
    <Screen title="Unlimited Mode" onBack={onBack}>
      <p className="lead">An endless run of generated challenges. Clear a level to bank its score and move on. New mechanics unlock as you climb.</p>
      <div className="tiles">
        <div className="tile"><span className="eyebrow">Current level</span><b className="mono">{run ? run.level : '—'}</b></div>
        <div className="tile"><span className="eyebrow">Run score</span><b className="mono">{run ? fmtScore(run.score) : '—'}</b></div>
        <div className="tile"><span className="eyebrow">Highest level cleared</span><b className="mono">{u.highestLevel}</b></div>
        <div className="tile"><span className="eyebrow">Best run score</span><b className="mono">{u.bestRunScore ? fmtScore(u.bestRunScore) : '—'}</b></div>
        <div className="tile"><span className="eyebrow">Longest run</span><b className="mono">{u.longestRun ?? 0} levels</b></div>
      </div>
      <p className="muted">{net.configured ? (net.auth.status === 'signedIn' ? 'Run, records and unlocks are saved to your account and follow you across devices.' : 'Sign in from the Account screen to carry this progress to other devices.') : 'Progress is saved in this browser.'}</p>
      <div className="actions left">
        <button className="btn primary big" onClick={onContinue}>{run ? `Continue · Level ${run.level}` : 'Start run'}</button>
        {run && !confirm && <button className="btn" onClick={() => setConfirm(true)}>Restart run</button>}
        {run && confirm && (
          <span className="confirm">
            <span>Abandon this run and start again at level 1?</span>
            <button className="btn danger" onClick={() => { setConfirm(false); onRestart(); }}>Restart</button>
            <button className="btn" onClick={() => setConfirm(false)}>Keep going</button>
          </span>
        )}
      </div>
      {run && <p className="muted">Level {run.level} difficulty: <Pips value={difficultyForLevel(run.level)} /> {difficultyName(difficultyForLevel(run.level))}{upcoming ? ` · Next unlock at level ${upcoming.level}: ${upcoming.name}` : ''}</p>}

      <h2 className="section">Progression</h2>
      <ol className="track">
        {UNLOCKS.map((x) => {
          const open = x.level <= reached;
          return (
            <li key={x.id} className={open ? 'open' : ''}>
              <span className="lvl mono">L{x.level}</span>
              <span className="what"><b>{x.name}</b><small>{KIND[x.kind]} · {x.detail}</small></span>
              <span className="state">{open ? 'Unlocked' : 'Locked'}</span>
            </li>
          );
        })}
      </ol>
      <p className="muted">Daily challenges always use their own fixed toolset, so unlocks here never affect daily fairness. From level 13 levels stack two modifiers, and from level 24 three.</p>
      <AdSlot placement="between-runs" />
    </Screen>
  );
}
