import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEVICE_COLORS, GameController, RunOutcome } from '../game/controller';
import { objectiveText } from '../game/level';
import { formatEnergy } from '../game/scoring';
import { COACH, CoachStep } from '../game/tutorial';
import { solveLevel } from '../gen/solver';
import { TEMPLATES, TemplateId } from '../gen/spec';
import { validateLevel } from '../gen/validate';
import { recordDaily } from '../modes/daily';
import { getSkin } from '../modes/progression';
import { recordLevelScore } from '../modes/unlimited';
import { Device, DEVICE_LIMITS, DEVICE_TYPES, DeviceType } from '../physics/types';
import { ads } from '../services/ads';
import { playSound, setSoundEnabled, unlockAudio } from '../services/audio';
import { ApiError } from '../services/backend';
import { online } from '../services/online';
import { profile, Replay, saveReplay } from '../services/storage';
import { ArenaCanvas } from './ArenaCanvas';
import { BackButton, DEVICE_INFO, DeviceIcon, difficultyName, fmtScore, fmtTime, Pips } from './common';
import { useController, useOnline, useProfile, useTicker } from './hooks';
import { ResultsPanel, ResultInfo } from './ResultsPanel';
import { sameLevel, Session, Submission } from './session';
import { ShareDialog } from './Share';
import { CardData } from './sharecard';

interface Props {
  session: Session;
  onExit: () => void;
  onNextLevel: () => void;
  onLeaderboard: () => void;
  onPlayDaily: () => void;
  onAccount: () => void;
  /** Watch `mine` with `theirs` as a ghost. */
  onCompare: (mine: Replay, theirs: Replay) => void;
}

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const FAIL_TEXT: Record<string, string> = {
  hazard: 'Object destroyed by a hazard',
  timeout: 'Out of time',
  sync: 'Arrivals were too far apart',
  stalled: 'Everything came to rest',
};

export function GameScreen({ session, onExit, onNextLevel, onLeaderboard, onPlayDaily, onAccount, onCompare }: Props) {
  const save = useProfile();
  const net = useOnline();
  const { settings } = save;
  const level = session.level;

  const controller = useMemo(() => {
    const c = new GameController(level);
    if (session.mode === 'replay') {
      c.readOnly = true;
      c.loadDevices(session.replay.devices);
      if (session.rival) c.setRival(session.rival.player ?? 'Other', session.rival.devices);
    }
    return c;
    // A new session object means a new level instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  useController(controller);
  // Debug/test handle; harmless in production.
  useEffect(() => {
    (window as any).__vectorlab = {
      controller,
      solve: () => solveLevel(level, validateLevel(level).routes, level.seed, 600),
    };
    return () => { delete (window as any).__vectorlab; };
  }, [controller, level]);
  const live = controller.phase === 'running';
  useTicker(live);

  const [result, setResult] = useState<ResultInfo | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [submission, setSubmission] = useState<Submission>({ status: 'none' });
  const [share, setShare] = useState<{ data: CardData; link: string | null; note?: string } | null>(null);
  const lastSolution = useRef<ReturnType<typeof snapshot> | null>(null);

  // Ads are never allowed while a simulation is in progress.
  const simActive = controller.phase === 'running' || controller.phase === 'paused';
  useEffect(() => {
    ads.setSimulationActive(simActive);
    return () => ads.setSimulationActive(false);
  }, [simActive]);

  /** Send a daily solution to the server, which re-simulates it and returns the real score. */
  const submitDaily = useCallback(async (devices: Device[]) => {
    if (session.mode !== 'daily') return;
    if (!online.getState().configured) { setSubmission({ status: 'none' }); return; }
    if (!session.challenge.published) {
      setSubmission({ status: 'local', reason: session.challenge.fallbackReason === 'unpublished'
        ? 'No challenge was published online for this date, so this is a practice arena. The score is saved on this device only.'
        : 'The server could not be reached when this challenge loaded, so this score is saved on this device only.' });
      return;
    }
    if (!online.signedIn) { setSubmission({ status: 'guest' }); return; }
    setSubmission({ status: 'sending' });
    try {
      setSubmission({ status: 'verified', result: await online.submitDaily(session.challenge.date, devices) });
    } catch (err) {
      const e = err as ApiError;
      setSubmission({ status: 'error', message: e.offline ? 'the server could not be reached.' : e.status === 401 ? 'your session expired. Sign in again.' : e.message });
    }
  }, [session]);

  // If the player signs in from the results panel, post the waiting score.
  useEffect(() => {
    if (submission.status === 'guest' && net.auth.status === 'signedIn' && lastSolution.current) submitDaily(lastSolution.current.devices);
  }, [net.auth.status, submission.status, submitDaily]);

  // Keep controller options in sync with settings.
  useEffect(() => {
    controller.colors = getSkin(settings.skin).colors;
    controller.particlesEnabled = !settings.reducedMotion;
    if (controller.forecastEnabled !== settings.forecast) {
      controller.forecastEnabled = settings.forecast;
      controller.updateForecast();
    }
    setSoundEnabled(settings.sound);
  }, [controller, settings]);

  useEffect(() => {
    controller.onSound = (name, intensity) => playSound(name, intensity);
    controller.onFinish = (outcome: RunOutcome) => {
      if (session.mode === 'replay') {
        setResult({ outcome, best: false, first: false, previousBest: 0 });
        setShowResult(true);
        return;
      }
      profile.update((d) => {
        d.stats.simulations++;
        d.stats.simSeconds += outcome.metrics.time;
        d.stats.devicesPlaced += controller.placedCount;
        controller.placedCount = 0;
        if (outcome.success) {
          d.stats.successes++;
          d.stats.bestScore = Math.max(d.stats.bestScore, outcome.score!.total);
          d.stats.byTemplate[level.template] = (d.stats.byTemplate[level.template] ?? 0) + 1;
        } else d.stats.failures++;
      });
      if (!outcome.success) return;
      const score = outcome.score!.total;
      lastSolution.current = snapshot(controller.devices, outcome);
      let info: ResultInfo = { outcome, best: false, first: false, previousBest: 0 };
      const replayBase = { level, devices: controller.devices.map((x) => ({ ...x })), score, time: outcome.metrics.time, energy: outcome.metrics.energy, savedAt: new Date().toISOString() };
      if (session.mode === 'daily') {
        const r = recordDaily(profile, session.challenge, score, outcome.metrics);
        info = { outcome, ...r };
        if (r.best) profile.update((d) => saveReplay(d, { ...replayBase, key: `daily:${session.challenge.date}`, label: `Daily #${session.challenge.number} · ${level.title}`, date: session.challenge.date }));
        submitDaily(replayBase.devices);
      } else if (session.mode === 'unlimited') {
        const prev = profile.get().unlimited.run?.levelBest ?? 0;
        recordLevelScore(profile, score);
        info = { outcome, best: score > prev, first: prev === 0, previousBest: prev };
        if (score > prev) profile.update((d) => saveReplay(d, { ...replayBase, key: `unlimited:${session.levelNumber}`, label: `Unlimited L${session.levelNumber} · ${level.title}` }));
      } else if (session.mode === 'tutorial') {
        profile.update((d) => { d.tutorialDone = true; });
        info = { outcome, best: false, first: true, previousBest: 0 };
      }
      setResult(info);
      window.setTimeout(() => setShowResult(true), 650);
    };
    return () => { controller.onFinish = null; controller.onSound = null; };
  }, [controller, session, level, submitDaily]);

  // Replays start themselves.
  useEffect(() => {
    if (session.mode !== 'replay') return;
    const id = window.setTimeout(() => controller.start(), 500);
    return () => window.clearTimeout(id);
  }, [controller, session]);

  const run = useCallback(() => {
    unlockAudio();
    setShowResult(false);
    controller.toggleRun();
  }, [controller]);
  const reset = useCallback(() => {
    setShowResult(false);
    controller.reset();
  }, [controller]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLInputElement | null;
      if (el?.tagName === 'TEXTAREA' || (el?.tagName === 'INPUT' && el.type !== 'range' && el.type !== 'checkbox')) return;
      if (e.code === 'Space') {
        // Drop focus first so Space never also "clicks" whichever control was focused.
        e.preventDefault();
        if (el && el !== document.body) el.blur?.();
        if (!e.repeat) run();
      }
      else if (e.key === 'r' || e.key === 'R') reset();
      else if ((e.key === 'Delete' || e.key === 'Backspace') && controller.selectedId !== null) controller.remove(controller.selectedId);
      else if (e.key === 'Escape') { controller.arm(null); controller.select(null); }
      else if (['1', '2', '3', '4'].includes(e.key)) {
        const type = DEVICE_TYPES[Number(e.key) - 1];
        controller.arm(controller.armed === type ? null : type);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller, run, reset]);

  const c = controller;
  const sel = c.selected;
  const readOnly = c.readOnly;
  const o = level.objective;
  const time = c.phase === 'success' || c.phase === 'failed' ? c.tracker.finishTime : c.sim.time;
  const limit = o.type === 'survive' ? o.duration! : o.timeLimit;
  const setSetting = (patch: Partial<typeof settings>) => profile.update((d) => { Object.assign(d.settings, patch); });

  // Tutorial coaching: derived entirely from the current state.
  let coach: CoachStep | null = null;
  if (session.mode === 'tutorial' && c.phase !== 'success') {
    const dev = c.devices[0];
    const body = level.bodies[0];
    if (c.phase === 'failed') coach = COACH.retry;
    else if (c.phase === 'running' || c.phase === 'paused') coach = COACH.watch;
    else if (!dev) coach = c.armed ? COACH.place : COACH.pick;
    else if (Math.hypot(dev.x - body.x, dev.y - body.y) > dev.range - 8) coach = COACH.reach;
    else coach = COACH.run;
  }
  const focus = coach?.focus ?? null;

  // ---- sharing and comparing -------------------------------------------------------------
  const myReplayForThis = session.mode === 'replay' && session.replay.remoteId && session.replay.date
    ? save.replays.find((r) => r.key === `daily:${session.replay.date}` && sameLevel(r.level, level)) ?? null
    : null;
  const watchingOwn = session.mode === 'replay' && !!myReplayForThis && Math.round(myReplayForThis.score) === Math.round(session.replay.score) && myReplayForThis.devices.length === session.replay.devices.length;

  const openShare = async () => {
    const sol = lastSolution.current;
    if (session.mode === 'replay') {
      const r = session.replay;
      const heading = r.date ? `Daily Challenge · ${r.date}` : 'Replay';
      setShare({
        data: { heading, title: level.title, score: r.score, time: r.time, energy: r.energy ?? c.sim.energy, devicesUsed: r.devices.length, level, devices: r.devices, player: r.player },
        link: r.remoteId ? online.replayLink(r.remoteId) : null,
        note: 'This solution is only stored on this device, so it has no link.',
      });
      return;
    }
    if (!sol) return;
    const base = { title: level.title, score: sol.score, time: sol.time, energy: sol.energy, devicesUsed: sol.devices.length, level, devices: sol.devices, player: net.profile?.name };
    if (session.mode === 'daily') {
      const v = submission.status === 'verified' ? submission.result : null;
      setShare({
        data: { ...base, heading: `Daily Challenge #${session.challenge.number}`, score: v ? v.score.total : sol.score, rank: v ? { rank: v.rank, players: v.players } : null },
        link: v?.replayId ? online.replayLink(v.replayId) : null,
        note: !net.configured ? 'Replay links need the online service, which this build is not connected to.' : net.auth.status !== 'signedIn' ? 'Sign in to get a replay link and a global rank for this result.' : 'A replay link appears once the server has verified this run.',
      });
    } else if (session.mode === 'unlimited') {
      const data = { ...base, heading: `Unlimited · Level ${session.levelNumber}` };
      if (!net.configured || net.auth.status !== 'signedIn') {
        setShare({ data, link: null, note: !net.configured ? 'Replay links need the online service, which this build is not connected to.' : 'Sign in to create a replay link for this solution.' });
        return;
      }
      setShare({ data, link: null, note: 'Creating replay link…' });
      try {
        const id = await online.shareSolution(level, sol.devices, `Unlimited L${session.levelNumber} · ${level.title}`);
        setShare({ data, link: online.replayLink(id) });
      } catch (err) {
        setShare({ data, link: null, note: `Could not create a replay link: ${(err as Error).message}` });
      }
    }
  };

  const modeLabel =
    session.mode === 'daily' ? `Daily #${session.challenge.number}${session.isToday ? '' : ' · Archive'}`
      : session.mode === 'unlimited' ? `Unlimited · Level ${session.levelNumber}`
        : session.mode === 'tutorial' ? 'Tutorial'
          : session.rival ? `Compare · ${session.replay.player ?? 'You'} vs ${session.rival.player ?? 'Other'}`
            : `Replay${session.replay.player ? ` · ${session.replay.player}` : ''}`;
  const templateName = TEMPLATES[level.template as TemplateId]?.name ?? 'Training';
  const personalBest =
    session.mode === 'daily' ? save.daily.results[session.challenge.date]?.bestScore ?? 0
      : session.mode === 'unlimited' ? save.unlimited.run?.levelBest ?? 0 : 0;

  return (
    <div className="game">
      <header className="topbar">
        <BackButton onClick={onExit} label="Exit" />
        <div className="title-block">
          <span className="eyebrow">{modeLabel} · {templateName}</span>
          <h1>{level.title}</h1>
        </div>
        <div className="objective">
          <span className="eyebrow">Objective</span>
          <p>{objectiveText(level)}</p>
        </div>
        <div className="top-stats">
          <div className="stat">
            <span className="eyebrow">{o.type === 'survive' ? 'Survive' : 'Time'}</span>
            <b className={limit - time < 3 && live ? 'warn' : ''}>{time.toFixed(2)}<small> / {limit.toFixed(0)}s</small></b>
          </div>
          <div className="stat">
            <span className="eyebrow">Progress</span>
            <b>{o.type === 'survive' ? `${Math.min(100, Math.round((time / limit) * 100))}%` : `${c.tracker.capturedCount}/${c.tracker.totalCount}`}</b>
          </div>
          <div className="stat hide-sm">
            <span className="eyebrow">Energy</span>
            <b>{formatEnergy(c.sim.energy)}<small> kJ</small></b>
          </div>
        </div>
      </header>

      <div className="stage">
        <aside className={`toolbar${focus === 'toolbar' ? ' focus' : ''}`} aria-label="Force generators">
          <div className="panel-title">Generators <span>{c.devices.length}/{level.maxDevices}</span></div>
          <div className="tools">
            {DEVICE_TYPES.map((type) => {
              const total = level.tools[type];
              const left = total - c.countOf(type);
              const usable = c.canPlace(type);
              return (
                <button
                  key={type}
                  className={`tool${c.armed === type ? ' armed' : ''}`}
                  style={{ ['--tool' as string]: DEVICE_COLORS[type] }}
                  disabled={!usable}
                  onClick={() => c.arm(c.armed === type ? null : type)}
                  title={total === 0 ? `${DEVICE_INFO[type].name}: not available on this level` : `${DEVICE_INFO[type].hint} (key ${DEVICE_INFO[type].key})`}
                >
                  <DeviceIcon type={type} />
                  <span className="tool-name">{DEVICE_INFO[type].name}</span>
                  <span className="tool-count">{total === 0 ? '—' : `×${left}`}</span>
                </button>
              );
            })}
          </div>
          <p className="tool-hint">
            {readOnly ? (c.rival ? `Solid: ${session.mode === 'replay' ? session.replay.player ?? 'You' : 'You'}. Dashed ghost: ${c.rival.label}.` : 'Watching a saved solution.') : c.armed ? `Click the arena to place the ${DEVICE_INFO[c.armed].name.toLowerCase()}.` : 'Pick a generator, then click the arena. Drag to move.'}
          </p>
        </aside>

        <main className={`arena-wrap${focus === 'arena' ? ' focus' : ''}`}>
          <ArenaCanvas controller={c} trails={settings.trails} vectors={settings.vectors} reducedMotion={settings.reducedMotion} />
          {coach && (
            <div className="coach" role="status">
              <strong>{coach.title}</strong>
              <span>{coach.text}</span>
            </div>
          )}
          {c.phase === 'failed' && !coach && (
            <div className="toast fail" role="status">
              <strong>{FAIL_TEXT[c.outcome?.failReason ?? 'timeout']}</strong>
              <span>Adjust your setup and run it again.</span>
              <button className="btn small" onClick={reset}>Reset</button>
            </div>
          )}
          {c.phase === 'success' && !showResult && <div className="toast win" role="status"><strong>Objective complete</strong></div>}
          {session.mode === 'daily' && session.challenge.published === false && c.phase === 'setup' && (
            <div className="toast note" id="offline-note">{session.challenge.fallbackReason === 'unpublished' ? 'Nothing was published online for this date. This is a locally generated practice arena.' : 'Server unreachable. Playing the offline version of this challenge; scores stay on this device.'}</div>
          )}
          {!level.verified && c.phase === 'setup' && session.mode !== 'replay' && (
            <div className="toast note">Experimental layout: the auto-checker could not confirm a solution.</div>
          )}
          {result && showResult && (
            <ResultsPanel
              info={result}
              session={session}
              level={level}
              runTotal={session.mode === 'unlimited' ? (save.unlimited.run?.score ?? 0) + (save.unlimited.run?.levelBest ?? 0) : 0}
              onImprove={() => { setShowResult(false); c.reset(); }}
              onReplay={() => { setShowResult(false); c.reset(); window.setTimeout(() => c.start(), 250); }}
              onNext={onNextLevel}
              onLeaderboard={onLeaderboard}
              onExit={onExit}
              onPlayDaily={onPlayDaily}
              submission={submission}
              canCompare={session.mode === 'replay' && !session.rival && !!myReplayForThis && !watchingOwn}
              onShare={openShare}
              onAccount={onAccount}
              onRetrySubmit={() => { if (lastSolution.current) submitDaily(lastSolution.current.devices); }}
              onCompare={() => { if (session.mode === 'replay' && myReplayForThis) onCompare({ ...myReplayForThis, player: 'You' }, session.replay); }}
            />
          )}
          {share && <ShareDialog data={share.data} link={share.link} linkNote={share.note} onClose={() => setShare(null)} />}
        </main>

        <aside className={`inspector${focus === 'inspector' ? ' focus' : ''}`}>
          {sel && !readOnly ? (
            <DeviceInspector c={c} />
          ) : (
            <div className="panel-block">
              <div className="panel-title">Briefing</div>
              <div className="brief-row"><span>Difficulty</span><span><Pips value={level.difficulty} /> {difficultyName(level.difficulty)}</span></div>
              <div className="brief-row"><span>Par time</span><span className="mono">{fmtTime(level.par.time)}</span></div>
              <div className="brief-row"><span>Par energy</span><span className="mono">{formatEnergy(level.par.energy)} kJ</span></div>
              {personalBest > 0 && <div className="brief-row"><span>Your best</span><span className="mono best">{fmtScore(personalBest)}</span></div>}
              {level.rules.length > 0 && (
                <ul className="rules">
                  {level.rules.map((r) => <li key={r}>{r}</li>)}
                </ul>
              )}
              {!readOnly && <p className="tip">Select a placed generator to tune its strength, range and direction.</p>}
            </div>
          )}
          <div className="panel-block">
            <div className="panel-title">View</div>
            <label className="switch"><input id="opt-trails" type="checkbox" checked={settings.trails} onChange={(e) => setSetting({ trails: e.target.checked })} /><span>Trajectory trails</span></label>
            <label className="switch"><input id="opt-vectors" type="checkbox" checked={settings.vectors} onChange={(e) => setSetting({ vectors: e.target.checked })} /><span>Force vectors</span></label>
            <label className="switch"><input id="opt-forecast" type="checkbox" checked={settings.forecast} onChange={(e) => setSetting({ forecast: e.target.checked })} /><span>Path forecast</span></label>
          </div>
        </aside>
      </div>

      <footer className="controls">
        <button className={`btn primary run${focus === 'run' ? ' focus' : ''}`} onClick={run}>
          {c.phase === 'running' ? <><i className="ico pause" />Pause</> : c.phase === 'paused' ? <><i className="ico play" />Resume</> : <><i className="ico play" />{c.phase === 'setup' ? 'Run' : 'Run again'}</>}
        </button>
        <button className="btn" onClick={reset} disabled={c.phase === 'setup'}><i className="ico reset" />Reset</button>
        <div className="segmented" role="group" aria-label="Viewing speed">
          {SPEEDS.map((s) => (
            <button key={s} className={c.speed === s ? 'on' : ''} onClick={() => c.setSpeed(s)} title="Viewing speed only: results are identical at any speed">{s}×</button>
          ))}
        </div>
        <span className="spacer" />
        {!readOnly && <button className="btn ghost" onClick={() => c.clearDevices()} disabled={c.devices.length === 0}>Clear all</button>}
        <span className="keys hide-sm">Space run · R reset · 1–4 tools · Del remove</span>
      </footer>
    </div>
  );
}

function snapshot(devices: Device[], outcome: RunOutcome) {
  return { devices: devices.map((d) => ({ ...d })), score: outcome.score!.total, time: outcome.metrics.time, energy: outcome.metrics.energy };
}

function DeviceInspector({ c }: { c: GameController }) {
  const d = c.selected!;
  const L = DEVICE_LIMITS;
  const cap = c.level.strengthCap;
  const deg = Math.round((((-d.angle * 180) / Math.PI) % 360 + 360) % 360);
  const slider = (id: string, label: string, value: number, min: number, max: number, step: number, unit: string, onChange: (v: number) => void) => (
    <label className="slider" htmlFor={id}>
      <span>{label}<b className="mono">{Math.round(value)}{unit}</b></span>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
  return (
    <div className="panel-block device-panel" style={{ ['--tool' as string]: DEVICE_COLORS[d.type] }}>
      <div className="panel-title"><span className="dot" />{DEVICE_INFO[d.type as DeviceType].name}</div>
      <p className="tip">{DEVICE_INFO[d.type as DeviceType].hint}.</p>
      {slider('dev-strength', 'Strength', d.strength, L.strength.min, cap, 10, '', (v) => c.update(d.id, { strength: v }))}
      {slider('dev-range', d.type === 'field' ? 'Length' : 'Range', d.range, L.range.min, L.range.max, 5, '', (v) => c.update(d.id, { range: v }))}
      {d.type === 'field' && slider('dev-angle', 'Direction', deg, 0, 359, 1, '°', (v) => c.update(d.id, { angle: (-v * Math.PI) / 180 }))}
      {d.type === 'vortex' && (
        <div className="segmented full" role="group" aria-label="Rotation direction">
          <button className={d.spin === 1 ? 'on' : ''} onClick={() => c.update(d.id, { spin: 1 })}>↺ Counter-clockwise</button>
          <button className={d.spin === -1 ? 'on' : ''} onClick={() => c.update(d.id, { spin: -1 })}>↻ Clockwise</button>
        </div>
      )}
      <button className="btn danger small" onClick={() => c.remove(d.id)}>Remove generator</button>
    </div>
  );
}
