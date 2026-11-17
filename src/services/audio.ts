/** Tiny WebAudio synth for feedback blips. No assets; silent until the first user gesture. */
let ctx: AudioContext | null = null;
let enabled = true;
let lastBounce = 0;

export function setSoundEnabled(on: boolean): void {
  enabled = on;
}

/** Call from a user gesture so browsers allow playback. */
export function unlockAudio(): void {
  if (!enabled || ctx) return;
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (AC) ctx = new AC();
  } catch { ctx = null; }
}

function tone(freq: number, dur: number, type: OscillatorType, gain: number, slideTo?: number, delay = 0): void {
  if (!ctx || !enabled) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch { /* audio is optional */ }
}

export function playSound(name: 'capture' | 'bounce' | 'bumper' | 'fail' | 'win' | 'place' | 'start', intensity = 1): void {
  if (!enabled) return;
  switch (name) {
    case 'bounce': {
      const now = performance.now();
      if (now - lastBounce < 60 || intensity < 0.12) return;
      lastBounce = now;
      tone(180 + intensity * 160, 0.06, 'triangle', 0.03 + intensity * 0.04);
      break;
    }
    case 'bumper': tone(520, 0.12, 'square', 0.04, 880); break;
    case 'capture': tone(660, 0.18, 'sine', 0.09, 990); break;
    case 'place': tone(420, 0.07, 'sine', 0.05, 560); break;
    case 'start': tone(240, 0.12, 'sine', 0.05, 360); break;
    case 'fail': tone(220, 0.35, 'sawtooth', 0.05, 70); break;
    case 'win':
      tone(523, 0.16, 'sine', 0.08);
      tone(659, 0.16, 'sine', 0.08, undefined, 0.11);
      tone(784, 0.3, 'sine', 0.09, undefined, 0.22);
      break;
  }
}
