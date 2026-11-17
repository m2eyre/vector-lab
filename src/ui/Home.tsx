import { useEffect, useMemo, useRef, useState } from 'react';
import { objectiveTextForTemplate } from './text';
import { MODIFIER_INFO, TEMPLATES } from '../gen/spec';
import { challengeNumber, currentStreak, dailySpec, dateKey } from '../modes/daily';
import { online } from '../services/online';
import { ChallengeSpec } from '../gen/spec';
import { AdSlot } from './AdSlot';
import { profile } from '../services/storage';
import { difficultyName, fmtScore, Pips } from './common';
import { useOnline, useProfile } from './hooks';

interface Props {
  onDaily: () => void;
  onUnlimited: () => void;
  onTutorial: () => void;
  onHowTo: () => void;
  onLeaderboards: () => void;
  onStats: () => void;
  onSettings: () => void;
  onAccount: () => void;
}

function useCountdown(utc: boolean): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const next = new Date(now);
  // Online, the challenge changes at 00:00 UTC for everyone; offline, at local midnight.
  if (utc) next.setUTCHours(24, 0, 0, 0); else next.setHours(24, 0, 0, 0);
  const s = Math.max(0, Math.floor((next.getTime() - now) / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** Ambient backdrop: a few particles orbiting an invisible attractor, simulated for real. */
function Backdrop() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || profile.get().settings.reducedMotion;
    let raf = 0;
    let w = 0;
    let h = 0;
    const colors = ['#5ee6ff', '#ffc857', '#c58bff', '#35e0a5', '#ff8a3d'];
    const ps = colors.map((color, i) => ({ x: 0, y: 0, vx: 0, vy: 0, color, r: 170 + i * 70, trail: [] as number[] }));
    const size = () => {
      w = cv.clientWidth; h = cv.clientHeight;
      cv.width = w; cv.height = h;
      ps.forEach((p, i) => {
        const a = i * 1.3;
        p.x = w * 0.82 + Math.cos(a) * p.r; p.y = h * 0.36 + Math.sin(a) * p.r * 0.8;
        const v = Math.sqrt(26000 / p.r) * 3.2;
        p.vx = -Math.sin(a) * v; p.vy = Math.cos(a) * v * 0.8;
        p.trail = [];
      });
    };
    size();
    window.addEventListener('resize', size);
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const cx = w * 0.82;
      const cy = h * 0.36;
      for (const p of ps) {
        for (let s = 0; s < 2; s++) {
          const dx = cx - p.x; const dy = cy - p.y;
          const d = Math.max(40, Math.hypot(dx, dy));
          const f = 280000 / (d * d);
          p.vx += (dx / d) * f * 0.008; p.vy += (dy / d) * f * 0.008;
          p.x += p.vx * 0.008; p.y += p.vy * 0.008;
        }
        p.trail.push(p.x, p.y);
        if (p.trail.length > 240) p.trail.splice(0, 2);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.5;
        for (let i = 2; i < p.trail.length; i += 2) {
          ctx.globalAlpha = (i / p.trail.length) * 0.5;
          ctx.beginPath(); ctx.moveTo(p.trail[i - 2], p.trail[i - 1]); ctx.lineTo(p.trail[i], p.trail[i + 1]); ctx.stroke();
        }
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    if (reduce) { for (let i = 0; i < 200; i++) draw(); } else raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', size); };
  }, []);
  return <canvas ref={ref} className="backdrop" aria-hidden="true" />;
}

export function Home(p: Props) {
  const save = useProfile();
  const today = dateKey();
  const net = useOnline();
  const localSpec = useMemo(() => dailySpec(today), [today]);
  // Online, show the challenge the server actually published (it may be AI-designed).
  const [published, setPublished] = useState<{ date: string; spec: ChallengeSpec; number: number; source?: string } | null>(null);
  const [checked, setChecked] = useState(!net.configured);
  useEffect(() => {
    if (!net.configured) return;
    let alive = true;
    online.dailyProvider.getChallenge(today).then((c) => {
      if (!alive) return;
      setPublished(c.published ? { date: c.date, spec: c.spec, number: c.number, source: c.source } : null);
      setChecked(true);
    });
    return () => { alive = false; };
  }, [net.configured, today]);
  const spec = published && published.date === today ? published.spec : localSpec;
  const offlineFallback = net.configured && checked && !published;
  const result = save.daily.results[today];
  const streak = currentStreak(profile, today);
  const countdown = useCountdown(net.configured);
  const rank = net.ranks[today];
  const signedIn = net.auth.status === 'signedIn';
  const run = save.unlimited.run;
  const info = TEMPLATES[spec.template];

  return (
    <div className="home">
      <Backdrop />
      <div className="home-inner">
        <header className="brand">
          <div className="logo" aria-hidden="true"><i /><i /><i /></div>
          <div>
            <h1>VECTOR<span>LAB</span></h1>
            <p>Shape the forces. The physics does the rest.</p>
          </div>
        </header>

        <section className="daily-card" aria-label="Daily challenge">
          <div className="daily-head">
            <span className="eyebrow">Daily Challenge · #{challengeNumber(today)}</span>
            <span className="countdown mono" title="Time until the next challenge">Next in {countdown}</span>
          </div>
          <h2 id="daily-title">{net.configured && !checked ? 'Loading today\'s challenge…' : spec.title}</h2>
          <p className="daily-objective">{objectiveTextForTemplate(spec)}</p>
          <div className="chips">
            <span className="chip"><Pips value={spec.difficulty} /> {difficultyName(spec.difficulty)}</span>
            <span className="chip">{info.name}</span>
            {spec.modifiers.map((m) => <span className="chip mod" key={m}>{MODIFIER_INFO[m].name}</span>)}
          </div>
          <div className="daily-foot">
            <button className="btn primary big" onClick={p.onDaily}>{result ? 'Improve today\'s score' : 'Play Daily Challenge'}</button>
            <div className="daily-stats">
              <div><span className="eyebrow">Status</span><b className={result ? 'good' : ''}>{result ? 'Completed' : 'Not played'}</b></div>
              <div><span className="eyebrow">Your best</span><b className="mono">{result ? fmtScore(result.bestScore) : '—'}</b></div>
              <div><span className="eyebrow">Streak</span><b className="mono">{streak} day{streak === 1 ? '' : 's'}</b></div>
              {rank && <div><span className="eyebrow">Global rank</span><b className="mono">#{rank.rank}</b></div>}
            </div>
          </div>
          <p className="daily-note" id="daily-note">
            {!net.configured ? 'Offline build: the challenge is generated on this device and scores are stored locally.'
              : offlineFallback ? 'Server unreachable: playing the offline version of today\'s challenge. Scores stay on this device until you reconnect.'
                : !checked ? ''
                  : `Shared worldwide · same arena for every player · ${published?.source === 'ai' ? 'AI-designed, solver-verified' : 'procedurally designed, solver-verified'}`}
          </p>
        </section>

        <nav className="menu" aria-label="Main menu">
          <button className="menu-item" onClick={p.onUnlimited}>
            <strong>Unlimited Mode</strong>
            <span>{run ? `Run in progress · Level ${run.level}` : 'Endless procedural challenges'}</span>
          </button>
          <button className="menu-item" onClick={p.onTutorial}>
            <strong>Tutorial</strong>
            <span>{save.tutorialDone ? 'Completed · replay the basics' : 'Two minutes to learn the basics'}</span>
          </button>
          <button className="menu-item" onClick={p.onLeaderboards}><strong>Leaderboards</strong><span>{net.configured ? 'Live global, friends, weekly, all-time' : 'Demo data in this offline build'}</span></button>
          <button className="menu-item" onClick={p.onStats}><strong>Statistics</strong><span>History, bests and replays</span></button>
          <button className="menu-item" onClick={p.onHowTo}><strong>How to Play</strong><span>Generators, scoring, controls</span></button>
          <button className="menu-item" onClick={p.onSettings}><strong>Settings</strong><span>Name, visuals, sound</span></button>
          <button className="menu-item" id="menu-account" onClick={p.onAccount}>
            <strong>Account</strong>
            <span>{!net.configured ? 'Offline build · progress saved locally' : signedIn ? `Signed in${net.profile ? ` as ${net.profile.name}` : ''} · cloud save on` : 'Guest · sign in to compete and sync'}</span>
          </button>
        </nav>
        <AdSlot placement="menu-banner" />
        {!save.tutorialDone && <p className="first-time">New here? Start with the <button className="link" onClick={p.onTutorial}>tutorial</button>.</p>}
      </div>
    </div>
  );
}
