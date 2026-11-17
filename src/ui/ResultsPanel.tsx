import { useEffect, useState } from 'react';
import { RunOutcome } from '../game/controller';
import { Level } from '../game/level';
import { formatEnergy, SCORE_MAX } from '../game/scoring';
import { fmtScore, fmtTime } from './common';
import { Session, Submission } from './session';
import { gradeOf } from './sharecard';

export interface ResultInfo {
  outcome: RunOutcome;
  best: boolean;
  first: boolean;
  previousBest: number;
}

interface Props {
  info: ResultInfo;
  session: Session;
  level: Level;
  runTotal: number;
  submission: Submission;
  /** Watching someone else's replay and a solution of the player's own exists for this level. */
  canCompare: boolean;
  onImprove: () => void;
  onReplay: () => void;
  onNext: () => void;
  onLeaderboard: () => void;
  onExit: () => void;
  onPlayDaily: () => void;
  onShare: () => void;
  onAccount: () => void;
  onRetrySubmit: () => void;
  onCompare: () => void;
}

function useCountUp(target: number, ms = 900): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      setV(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

/** One line telling the player exactly where their daily score went. */
function SubmissionLine({ s, onAccount, onRetry }: { s: Submission; onAccount: () => void; onRetry: () => void }) {
  if (s.status === 'none') return null;
  if (s.status === 'sending') return <div className="submit-line" role="status"><i className="dot-pulse" />Verifying on the server…</div>;
  if (s.status === 'verified') {
    const r = s.result;
    return (
      <div className="submit-line ok" role="status" id="submit-status">
        <b>Verified by the server.</b> Global rank <b className="mono">#{r.rank}</b> of {r.players}
        {r.improved || r.first ? '' : ` · your best stays ${fmtScore(r.best.score)}`}
      </div>
    );
  }
  if (s.status === 'guest') {
    return (
      <div className="submit-line" id="submit-status">
        <span>Playing as a guest: this score is saved on this device only.</span>
        <button className="link" onClick={onAccount}>Sign in to post it to the leaderboard</button>
      </div>
    );
  }
  if (s.status === 'local') return <div className="submit-line warn" id="submit-status">{s.reason}</div>;
  return (
    <div className="submit-line warn" role="alert" id="submit-status">
      <span>Not posted to the leaderboard: {s.message}</span>
      <button className="link" onClick={onRetry}>Try again</button>
    </div>
  );
}

export function ResultsPanel(p: Props) {
  const { info, session, level } = p;
  const { outcome } = info;
  const s = outcome.score;
  const shown = useCountUp(s?.total ?? 0);
  if (!s) {
    return (
      <div className="results" role="dialog" aria-label="Replay finished">
        <div className="results-card">
          <span className="eyebrow">Replay</span>
          <h2>Run failed</h2>
          <div className="actions"><button className="btn primary" onClick={p.onReplay}>Watch again</button><button className="btn" onClick={p.onExit}>Close</button></div>
        </div>
      </div>
    );
  }
  const isReplay = session.mode === 'replay';
  const rival = session.mode === 'replay' ? session.rival : undefined;

  if (rival) {
    // Compare view: the replay shown in colour against the ghost.
    const mineName = session.mode === 'replay' ? (session.replay.player ?? 'You') : 'You';
    const theirName = rival.player ?? 'Other';
    const rows: { label: string; a: number; b: number | undefined; fmt: (v: number) => string; lowerIsBetter: boolean }[] = [
      { label: 'Score', a: s.total, b: rival.score, fmt: fmtScore, lowerIsBetter: false },
      { label: 'Time', a: outcome.metrics.time, b: rival.time, fmt: fmtTime, lowerIsBetter: true },
      { label: 'Energy', a: outcome.metrics.energy, b: rival.energy, fmt: (v) => `${formatEnergy(v)} kJ`, lowerIsBetter: true },
      { label: 'Generators', a: outcome.metrics.devicesUsed, b: rival.devices.length, fmt: (v) => String(v), lowerIsBetter: true },
    ];
    return (
      <div className="results" role="dialog" aria-label="Comparison">
        <div className="results-card">
          <span className="eyebrow">Solution comparison</span>
          <table className="compare" id="compare-table">
            <thead><tr><th /><th>{mineName}<small>solid</small></th><th>{theirName}<small>ghost</small></th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const win = r.b === undefined ? 0 : r.a === r.b ? 0 : (r.a < r.b) === r.lowerIsBetter ? 1 : -1;
                return (
                  <tr key={r.label}>
                    <th>{r.label}</th>
                    <td className={`mono${win > 0 ? ' better' : ''}`}>{r.fmt(r.a)}</td>
                    <td className={`mono${win < 0 ? ' better' : ''}`}>{r.b === undefined ? '—' : r.fmt(r.b)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted">Both solutions were simulated side by side on the same arena. Dashed outlines are {theirName}'s generators and path.</p>
          <div className="actions"><button className="btn primary" onClick={p.onReplay}>Watch again</button><button className="btn" onClick={p.onExit}>Close</button></div>
        </div>
      </div>
    );
  }

  const rows: { label: string; value: number; max: number; note: string }[] = [
    { label: 'Completion', value: s.completion, max: s.max.completion, note: 'Objective met' },
    ...(s.max.speed > 0 ? [{ label: 'Speed', value: s.speed, max: s.max.speed, note: `${fmtTime(outcome.metrics.time)} vs par ${fmtTime(level.par.time)}` }] : []),
    { label: 'Efficiency', value: s.efficiency, max: s.max.efficiency, note: `${outcome.metrics.devicesUsed} of ${level.maxDevices} generators` },
    { label: 'Energy', value: s.energy, max: s.max.energy, note: `${formatEnergy(outcome.metrics.energy)} kJ vs par ${formatEnergy(level.par.energy)}` },
  ];
  return (
    <div className="results" role="dialog" aria-label="Results">
      <div className="results-card">
        <span className="eyebrow">{isReplay ? `Replay complete${session.replay.player ? ` · ${session.replay.player}` : ''}` : session.mode === 'tutorial' ? 'Tutorial complete' : 'Objective complete'}</span>
        <div className="score-line">
          <div className="grade">{gradeOf(s.total)}</div>
          <div>
            <div className="score">{fmtScore(shown)}</div>
            <div className="score-max">of {fmtScore(SCORE_MAX)}</div>
          </div>
          {!isReplay && session.mode !== 'tutorial' && (
            info.best
              ? <span className="badge good">{info.first ? 'First clear' : `New best  +${fmtScore(s.total - info.previousBest)}`}</span>
              : <span className="badge">Best {fmtScore(info.previousBest)}</span>
          )}
        </div>
        {session.mode === 'daily' && <SubmissionLine s={p.submission} onAccount={p.onAccount} onRetry={p.onRetrySubmit} />}
        <div className="metrics">
          <div><span className="eyebrow">Time</span><b>{fmtTime(outcome.metrics.time)}</b></div>
          <div><span className="eyebrow">Generators</span><b>{outcome.metrics.devicesUsed}</b></div>
          <div><span className="eyebrow">Energy</span><b>{formatEnergy(outcome.metrics.energy)} kJ</b></div>
          {session.mode === 'unlimited' && <div><span className="eyebrow">Run total</span><b>{fmtScore(p.runTotal)}</b></div>}
        </div>
        <div className="breakdown">
          {rows.map((r) => (
            <div className="bar-row" key={r.label}>
              <span className="bar-label">{r.label}</span>
              <span className="bar"><i style={{ width: `${(r.value / r.max) * 100}%` }} /></span>
              <span className="bar-value mono">{fmtScore(r.value)}<small> / {fmtScore(r.max)}</small></span>
              <span className="bar-note">{r.note}</span>
            </div>
          ))}
        </div>
        <div className="actions">
          {isReplay ? (
            <>
              <button className="btn primary" onClick={p.onReplay}>Watch again</button>
              {p.canCompare && <button className="btn" id="compare-btn" onClick={p.onCompare}>Compare with my solution</button>}
              <button className="btn" onClick={p.onShare}>Share</button>
              <button className="btn ghost" onClick={p.onExit}>Close</button>
            </>
          ) : (
            <>
              {session.mode === 'unlimited' && <button className="btn primary" onClick={p.onNext}>Bank score · Next level</button>}
              {session.mode === 'daily' && <button className="btn primary" onClick={p.onLeaderboard}>Leaderboard</button>}
              {session.mode === 'tutorial' && <button className="btn primary" onClick={p.onPlayDaily}>Play today's challenge</button>}
              <button className="btn" onClick={p.onImprove}>Improve score</button>
              <button className="btn" onClick={p.onReplay}>Watch replay</button>
              {session.mode !== 'tutorial' && <button className="btn" id="share-btn" onClick={p.onShare}>Share</button>}
              <button className="btn ghost" onClick={p.onExit}>Exit</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
