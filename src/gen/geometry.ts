export interface Rect { x: number; y: number; w: number; h: number }

export function circleRect(cx: number, cy: number, r: number, q: Rect): boolean {
  const px = Math.max(q.x, Math.min(cx, q.x + q.w));
  const py = Math.max(q.y, Math.min(cy, q.y + q.h));
  const dx = cx - px;
  const dy = cy - py;
  return dx * dx + dy * dy < r * r;
}

export function rectRect(a: Rect, b: Rect, pad = 0): boolean {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
