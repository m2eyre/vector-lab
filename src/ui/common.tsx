import { useEffect, useRef } from 'react';
import { DEVICE_COLORS } from '../game/controller';
import { DeviceType } from '../physics/types';
import { drawDeviceGlyph } from '../render/renderer';

export const DEVICE_INFO: Record<DeviceType, { name: string; hint: string; key: string }> = {
  attractor: { name: 'Attractor', hint: 'Pulls objects toward its centre', key: '1' },
  repulsor: { name: 'Repulsor', hint: 'Pushes objects away from its centre', key: '2' },
  vortex: { name: 'Vortex', hint: 'Swirls objects around its centre', key: '3' },
  field: { name: 'Field', hint: 'Pushes in one direction across a strip', key: '4' },
};

export function DeviceIcon({ type, size = 30 }: { type: DeviceType; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    cv.width = size * dpr;
    cv.height = size * dpr;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const color = DEVICE_COLORS[type];
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1.5, 0, Math.PI * 2);
    ctx.stroke();
    drawDeviceGlyph(ctx, type, size / 2, size / 2, size / 32, color);
  }, [type, size]);
  return <canvas ref={ref} className="device-icon" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function Pips({ value, max = 5 }: { value: number; max?: number }) {
  return (
    <span className="pips" role="img" aria-label={`Difficulty ${value} of ${max}`}>
      {Array.from({ length: max }, (_, i) => <i key={i} className={i < value ? 'on' : ''} />)}
    </span>
  );
}

const DIFF_NAMES = ['', 'Gentle', 'Easy', 'Medium', 'Hard', 'Expert'];
export function difficultyName(d: number): string {
  return DIFF_NAMES[Math.max(1, Math.min(5, d))];
}

export function fmtScore(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function fmtTime(t: number): string {
  return `${t.toFixed(2)}s`;
}

export function BackButton({ onClick, label = 'Back' }: { onClick: () => void; label?: string }) {
  return (
    <button className="btn ghost back" onClick={onClick}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      {label}
    </button>
  );
}

export function Screen({ title, onBack, children, wide }: { title: string; onBack: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="screen">
      <header className="screen-head">
        <BackButton onClick={onBack} label="Home" />
        <h1>{title}</h1>
      </header>
      <div className={`screen-body${wide ? ' wide' : ''}`}>{children}</div>
    </div>
  );
}
