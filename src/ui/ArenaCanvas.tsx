import { useEffect, useRef } from 'react';
import { GameController } from '../game/controller';
import { handlePosition, renderArena } from '../render/renderer';
import { unlockAudio } from '../services/audio';

interface Props {
  controller: GameController;
  trails: boolean;
  vectors: boolean;
  reducedMotion: boolean;
}

type Drag = { kind: 'move'; id: number; dx: number; dy: number } | { kind: 'handle'; id: number } | null;

/**
 * The canvas: runs the frame loop, forwards pointer input to the controller and calls the
 * renderer. Options are read through a ref so the loop is created only once per controller.
 */
export function ArenaCanvas({ controller: c, trails, vectors, reducedMotion }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const opts = useRef({ trails, vectors, reducedMotion });
  opts.current = { trails, vectors, reducedMotion };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d')!;
    const W = c.level.arena.w;
    const H = c.level.arena.h;
    let cssW = 0;
    let dpr = 1;
    let hover: { x: number; y: number } | null = null;
    let hoverDeviceId: number | null = null;
    let drag: Drag = null;

    const fit = () => {
      const availW = wrap.clientWidth;
      const availH = wrap.clientHeight;
      if (availW <= 0 || availH <= 0) return;
      cssW = Math.floor(Math.min(availW, availH * (W / H)));
      const cssH = Math.floor(cssW * (H / W));
      dpr = Math.min(2.5, window.devicePixelRatio || 1);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);

    const toWorld = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
    };
    const deviceAt = (x: number, y: number, radius: number) => {
      let best: { id: number; d: number } | null = null;
      for (const d of c.devices) {
        const dist = Math.hypot(d.x - x, d.y - y);
        if (dist < radius && (!best || dist < best.d)) best = { id: d.id, d: dist };
      }
      return best ? c.devices.find((d) => d.id === best!.id)! : null;
    };

    const onDown = (e: PointerEvent) => {
      unlockAudio();
      if (c.readOnly) return;
      const p = toWorld(e);
      // Generous hit areas, scaled up when the arena is drawn small or touched with a finger.
      const k = (W / Math.max(1, cssW)) * (e.pointerType === 'touch' ? 1.6 : 1);
      const sel = c.selected;
      if (sel) {
        const h = handlePosition(sel);
        if (Math.hypot(h.x - p.x, h.y - p.y) < 14 * Math.max(1, k)) {
          drag = { kind: 'handle', id: sel.id };
          canvas.setPointerCapture(e.pointerId);
          return;
        }
      }
      const hit = deviceAt(p.x, p.y, 20 * Math.max(1, k));
      if (hit) {
        c.select(hit.id);
        drag = { kind: 'move', id: hit.id, dx: hit.x - p.x, dy: hit.y - p.y };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (c.armed && c.canPlace(c.armed)) {
        const d = c.place(c.armed, p.x, p.y);
        if (d) {
          drag = { kind: 'move', id: d.id, dx: 0, dy: 0 };
          canvas.setPointerCapture(e.pointerId);
        }
        return;
      }
      c.select(null);
    };

    const onMove = (e: PointerEvent) => {
      const p = toWorld(e);
      hover = e.pointerType === 'touch' ? null : p;
      if (!drag) {
        const h = c.readOnly ? null : deviceAt(p.x, p.y, 20);
        hoverDeviceId = h ? h.id : null;
        canvas.style.cursor = h ? 'grab' : c.armed ? 'crosshair' : 'default';
        return;
      }
      if (drag.kind === 'move') {
        c.update(drag.id, { x: p.x + drag.dx, y: p.y + drag.dy });
      } else {
        const d = c.devices.find((x) => x.id === (drag as { id: number }).id);
        if (!d) return;
        const dist = Math.hypot(p.x - d.x, p.y - d.y);
        if (d.type === 'field') c.update(d.id, { range: dist, angle: Math.atan2(p.y - d.y, p.x - d.x) });
        else c.update(d.id, { range: dist });
      }
    };

    const onUp = (e: PointerEvent) => {
      drag = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    const onLeave = () => { hover = null; hoverDeviceId = null; };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      c.tick(dt);
      const s = (cssW / W) * dpr;
      ctx.setTransform(s, 0, 0, s, 0, 0);
      renderArena(ctx, c, { ...opts.current, clock: now / 1000, hover, hoverDeviceId });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, [c]);

  return (
    <div className="arena-fit" ref={wrapRef}>
      <canvas ref={canvasRef} className="arena-canvas" aria-label="Arena. Place force generators here." />
    </div>
  );
}
