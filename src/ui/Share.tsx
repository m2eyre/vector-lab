import { useEffect, useRef, useState } from 'react';
import { CardData, drawScoreCard, shareText } from './sharecard';

interface Props {
  data: CardData;
  /** Public replay link, when the solution is stored on the server. */
  link: string | null;
  /** Shown when there is no link, explaining why. */
  linkNote?: string;
  onClose: () => void;
}

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** Score card with copy / download / share actions. Every button here does something real. */
export function ShareDialog({ data, link, linkNote, onClose }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState('');
  const text = shareText(data, link);
  // Inside an embedded sandbox (for example a hosted preview frame) downloads are blocked, so the
  // save button is replaced by a hint instead of being a button that does nothing.
  const embedded = (() => { try { return window.self !== window.top; } catch { return true; } })();
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const paint = () => drawScoreCard(cv, data);
    paint();
    // Web fonts may arrive after the first paint; redraw once they are ready.
    (document as any).fonts?.ready?.then(paint).catch(() => {});
  }, [data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const say = (m: string) => { setStatus(m); window.setTimeout(() => setStatus(''), 2500); };
  const download = () => {
    const cv = ref.current;
    if (!cv) return;
    const a = document.createElement('a');
    a.download = `vector-lab-${data.heading.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
    a.href = cv.toDataURL('image/png');
    a.click();
    say('Image saved');
  };
  const nativeShare = async () => {
    try { await navigator.share({ title: 'VECTOR LAB', text: shareText(data, null), url: link ?? undefined }); } catch { /* cancelled */ }
  };

  return (
    <div className="modal" role="dialog" aria-label="Share result" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card share-card">
        <div className="modal-head"><h2>Share result</h2><button className="btn ghost small" onClick={onClose}>Close</button></div>
        <canvas ref={ref} className="score-card" aria-label={text} />
        <pre className="share-text" id="share-text">{text}</pre>
        {!link && linkNote && <p className="muted">{linkNote}</p>}
        {embedded && <p className="muted">To keep the card, right-click or long-press the image and save it.</p>}
        <div className="actions left">
          <button className="btn primary" id="share-copy-text" onClick={async () => say((await copy(text)) ? 'Result copied' : 'Copy failed')}>Copy result</button>
          {link && <button className="btn" id="share-copy-link" onClick={async () => say((await copy(link)) ? 'Replay link copied' : 'Copy failed')}>Copy replay link</button>}
          {!embedded && <button className="btn" id="share-download" onClick={download}>Save image</button>}
          {canNativeShare && <button className="btn" onClick={nativeShare}>Share…</button>}
          <span className="status" role="status">{status}</span>
        </div>
      </div>
    </div>
  );
}
