import { useEffect, useState } from 'react';
import { Friend, online, PublicProfile, RemoteReplaySummary } from '../services/online';
import { fmtScore, fmtTime, Screen } from './common';
import { useOnline, useProfile } from './hooks';

const message = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

/** Sign-in form. Email one-time code with Supabase; a name-only login on the local dev server. */
function SignIn() {
  const kind = online.auth!.kind;
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };

  if (kind === 'dev') {
    return (
      <form className="auth-form" onSubmit={(e) => { e.preventDefault(); run(() => online.auth!.devLogin(name.trim())); }}>
        <div className="banner"><strong>Local dev server.</strong> This login creates a throwaway test account. Real sign-in by email is used when a Supabase project is configured.</div>
        <label className="field" htmlFor="dev-name"><span>Player name</span>
          <input id="dev-name" type="text" minLength={2} maxLength={20} required value={name} onChange={(e) => setName(e.target.value)} placeholder="2 to 20 characters" />
        </label>
        <button className="btn primary" id="dev-login" disabled={busy || name.trim().length < 2}>Create test account</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    );
  }
  return (
    <div className="auth-form">
      {!sent ? (
        <form onSubmit={(e) => { e.preventDefault(); run(async () => { await online.auth!.sendCode(email.trim()); setSent(true); }); }}>
          <label className="field" htmlFor="auth-email"><span>Email</span>
            <input id="auth-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </label>
          <button className="btn primary" disabled={busy || !email.includes('@')}>Email me a sign-in code</button>
          <p className="muted">No password. The same email signs you in on any device. New here? This also creates your account.</p>
        </form>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); run(() => online.auth!.verifyCode(email.trim(), code)); }}>
          <p>We sent a message to <b>{email}</b>. Enter the code from it, or open the link in it on this device.</p>
          <label className="field" htmlFor="auth-code"><span>Sign-in code</span>
            <input id="auth-code" type="text" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <div className="actions left">
            <button className="btn primary" disabled={busy || code.trim().length < 4}>Sign in</button>
            <button type="button" className="btn ghost" onClick={() => { setSent(false); setCode(''); }}>Use a different email</button>
          </div>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export function AccountScreen({ onBack, onWatch, onProfile }: { onBack: () => void; onWatch: (replayId: string) => void; onProfile: (id: string) => void }) {
  const state = useOnline();
  const save = useProfile();
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [code, setCode] = useState('');
  const [replays, setReplays] = useState<RemoteReplaySummary[] | null>(null);
  const [confirmOut, setConfirmOut] = useState(false);
  const signedIn = state.auth.status === 'signedIn';
  const p = state.profile;

  useEffect(() => { if (p) setName(p.name); }, [p?.name]);
  useEffect(() => {
    if (!signedIn || !p) { setFriends(null); setReplays(null); return; }
    online.friends().then(setFriends).catch(() => setFriends([]));
    online.myReplays().then(setReplays).catch(() => setReplays([]));
  }, [signedIn, p?.id]);
  const flash = (m: string) => { setNote(m); window.setTimeout(() => setNote(''), 3500); };
  const act = async (fn: () => Promise<void>, ok?: string) => {
    try { await fn(); if (ok) flash(ok); } catch (err) { flash(message(err)); }
  };

  if (!state.configured) {
    return (
      <Screen title="Account" onBack={onBack}>
        <div className="banner"><strong>Offline build.</strong> This copy of VECTOR LAB is not connected to a server, so there are no accounts, global leaderboards or shared replays here. Everything else works, and your progress is saved in this browser.</div>
      </Screen>
    );
  }
  if (!signedIn) {
    return (
      <Screen title="Account" onBack={onBack}>
        <p className="lead">You are playing as a guest. Everything is playable and saved in this browser.</p>
        <ul className="facts">
          <li>Sign in to post verified scores to the global leaderboards.</li>
          <li>Your streak, Unlimited progress and unlocks follow you to other devices.</li>
          <li>Progress you have already made as a guest is kept and moved into your account.</li>
        </ul>
        {state.reachable === false && <div className="banner warn"><strong>Server unreachable.</strong> You can keep playing; sign-in will work again once the connection is back.</div>}
        <h2 className="section">Sign in or create an account</h2>
        {state.auth.status === 'loading' ? <p className="muted">Checking session…</p> : <SignIn />}
      </Screen>
    );
  }
  return (
    <Screen title="Account" onBack={onBack}>
      {!p ? <p className="muted">{state.reachable === false ? 'Signed in, but the server cannot be reached right now.' : 'Loading your profile…'}</p> : (
        <>
          <div className="tiles">
            <div className="tile"><span className="eyebrow">Signed in as</span><b id="account-name">{p.name}</b></div>
            <div className="tile"><span className="eyebrow">Friend code</span><b className="mono" id="friend-code">{p.friendCode}</b></div>
            <div className="tile"><span className="eyebrow">Cloud save</span><b>{state.syncing ? 'Syncing…' : state.lastSync ? 'Up to date' : 'Pending'}</b></div>
            <div className="tile"><span className="eyebrow">Dailies cleared</span><b className="mono">{Object.keys(save.daily.results).length}</b></div>
          </div>

          <h2 className="section">Display name</h2>
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); act(() => online.rename(name.trim()), 'Name updated'); }}>
            <input id="account-rename" type="text" minLength={2} maxLength={20} value={name} onChange={(e) => setName(e.target.value)} aria-label="Display name" />
            <button className="btn" disabled={name.trim().length < 2 || name.trim() === p.name}>Save name</button>
          </form>

          <h2 className="section">Friends</h2>
          <p className="muted">Share your friend code. Adding someone's code puts them on your Friends leaderboard.</p>
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); act(async () => { setFriends(await online.addFriend(code)); setCode(''); }, 'Friend added'); }}>
            <input id="friend-input" type="text" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="8-character code" aria-label="Friend code" />
            <button className="btn" id="friend-add" disabled={code.trim().length !== 8}>Add friend</button>
          </form>
          {friends && friends.length > 0 ? (
            <ul className="replays">
              {friends.map((f) => (
                <li key={f.id}><button className="link" onClick={() => onProfile(f.id)}>{f.name}</button><span />
                  <button className="link" onClick={() => act(async () => setFriends(await online.removeFriend(f.id)))}>Remove</button></li>
              ))}
            </ul>
          ) : <p className="muted">{friends ? 'No friends added yet.' : 'Loading…'}</p>}

          <h2 className="section">Your verified solutions</h2>
          {replays && replays.length > 0 ? (
            <ul className="replays">
              {replays.slice(0, 12).map((r) => (
                <li key={r.id}>
                  <span>{r.kind === 'daily' ? `Daily #${r.number} · ${r.title}` : r.title ?? 'Unlimited'}</span>
                  <span className="mono">{fmtScore(r.score)} · {fmtTime(r.time)}</span>
                  <button className="link" onClick={() => onWatch(r.id)}>Watch</button>
                </li>
              ))}
            </ul>
          ) : <p className="muted">{replays ? 'Solutions you submit appear here.' : 'Loading…'}</p>}

          <h2 className="section">Session</h2>
          <div className="actions left">
            <button className="btn" onClick={() => act(() => online.sync(true), 'Progress synced')}>Sync now</button>
            <button className="btn" onClick={() => onProfile(p.id)}>View public profile</button>
            {!confirmOut ? <button className="btn danger" id="sign-out" onClick={() => setConfirmOut(true)}>Sign out</button> : (
              <span className="confirm">
                <span>Sign out? Your progress stays in your account and is removed from this device.</span>
                <button className="btn danger" id="sign-out-confirm" onClick={() => { setConfirmOut(false); act(() => online.signOut()); }}>Sign out</button>
                <button className="btn" onClick={() => setConfirmOut(false)}>Cancel</button>
              </span>
            )}
          </div>
          <span className="status" role="status">{note}</span>
        </>
      )}
    </Screen>
  );
}

/** Public player profile, opened from leaderboards and friend lists. */
export function ProfileModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [data, setData] = useState<PublicProfile | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setData(null);
    online.publicProfile(userId).then(setData).catch((err) => setError(message(err)));
  }, [userId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal" role="dialog" aria-label="Player profile" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card">
        <div className="modal-head"><h2>{data ? data.profile.name : 'Player'}</h2><button className="btn ghost small" onClick={onClose}>Close</button></div>
        {error && <p className="error">{error}</p>}
        {!data && !error && <p className="muted">Loading…</p>}
        {data && (
          <>
            <p className="muted">Playing since {new Date(data.profile.joined).toLocaleDateString()}</p>
            <div className="tiles">
              <div className="tile"><span className="eyebrow">Best daily score</span><b className="mono">{data.stats.bestScore ? fmtScore(data.stats.bestScore) : '—'}</b></div>
              <div className="tile"><span className="eyebrow">Dailies cleared</span><b className="mono">{data.stats.dailiesCompleted}</b></div>
              <div className="tile"><span className="eyebrow">Streak</span><b className="mono">{data.stats.streak}</b></div>
              <div className="tile"><span className="eyebrow">Best streak</span><b className="mono">{data.stats.bestStreak}</b></div>
              <div className="tile"><span className="eyebrow">Unlimited best level</span><b className="mono">{data.stats.highestLevel}</b></div>
              <div className="tile"><span className="eyebrow">Longest run</span><b className="mono">{data.stats.longestRun}</b></div>
            </div>
            <p className="muted">Daily results are server-verified. Unlimited figures are the player's own synced progress.</p>
            {data.recent.length > 0 && (
              <table className="board">
                <thead><tr><th>Daily</th><th>Challenge</th><th className="num">Score</th><th className="num">Rank</th></tr></thead>
                <tbody>{data.recent.map((r) => <tr key={r.date}><td className="mono">#{r.number}</td><td>{r.title}</td><td className="num mono">{fmtScore(r.score)}</td><td className="num mono">#{r.rank}</td></tr>)}</tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}
