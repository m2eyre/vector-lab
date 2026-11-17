import { DEVICE_COLORS } from '../game/controller';
import { BODY_COLORS, Level } from '../game/level';
import { ObjectiveTracker } from '../game/objectives';
import { formatEnergy } from '../game/scoring';
import { Simulation } from '../physics/simulation';
import { Device } from '../physics/types';

export interface CardData {
  /** e.g. "Daily Challenge #321" or "Unlimited · Level 7". */
  heading: string;
  title: string;
  score: number;
  time: number;
  energy: number;
  devicesUsed: number;
  level: Level;
  devices: Device[];
  player?: string;
  /** Global rank, when the server has verified the score. */
  rank?: { rank: number; players: number } | null;
}

export function gradeOf(total: number): string {
  if (total >= 90000) return 'S';
  if (total >= 80000) return 'A';
  if (total >= 70000) return 'B';
  if (total >= 60000) return 'C';
  return 'D';
}

/** Plain-text result for pasting anywhere. */
export function shareText(d: CardData, link?: string | null): string {
  const lines = [
    `VECTOR LAB · ${d.heading}`,
    `${d.title}`,
    `Score ${Math.round(d.score).toLocaleString('en-US')} (${gradeOf(d.score)})${d.rank ? ` · Rank #${d.rank.rank} of ${d.rank.players}` : ''}`,
    `Time ${d.time.toFixed(2)}s · ${d.devicesUsed} generator${d.devicesUsed === 1 ? '' : 's'} · ${formatEnergy(d.energy)} kJ`,
  ];
  if (link) lines.push(link);
  return lines.join('\n');
}

/** Re-run the solution to get the paths the objects took, for the preview. */
export function solutionPaths(level: Level, devices: Device[]): number[][] {
  const sim = new Simulation(level, devices);
  sim.collectEvents = false;
  const tracker = new ObjectiveTracker(level, sim);
  const paths = sim.bodies.map((b) => [b.x, b.y]);
  do {
    sim.step();
    if (sim.steps % 3 === 0) sim.bodies.forEach((b, i) => { if (b.active || b.captured) paths[i].push(b.x, b.y); });
  } while (tracker.update() === 'running');
  return paths;
}

/** Miniature of the arena with the solution drawn on it. */
export function drawPreview(ctx: CanvasRenderingContext2D, level: Level, devices: Device[], x: number, y: number, w: number): void {
  const s = w / level.arena.w;
  const h = level.arena.h * s;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#0a1020';
  ctx.strokeStyle = 'rgba(140,170,220,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.scale(s, s);
  for (const z of level.zones) {
    ctx.fillStyle = z.kind === 'gel' ? 'rgba(53,224,165,0.14)' : z.kind === 'ice' ? 'rgba(94,230,255,0.12)' : 'rgba(197,139,255,0.12)';
    ctx.fillRect(z.x, z.y, z.w, z.h);
  }
  for (const d of devices) {
    ctx.strokeStyle = DEVICE_COLORS[d.type];
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.type === 'field' ? d.range * 0.5 : d.range, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = '#2a3a5c';
  for (const wl of level.walls) {
    ctx.globalAlpha = wl.gate ? 0.5 : 1;
    ctx.fillRect(wl.x, wl.y, wl.w, wl.h);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffd166';
  for (const b of level.bumpers) { ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = 'rgba(255,68,102,0.75)';
  for (const hz of level.hazards) {
    ctx.beginPath();
    if (hz.shape === 'circle') ctx.arc(hz.x, hz.y, hz.r, 0, Math.PI * 2); else ctx.rect(hz.x, hz.y, hz.w, hz.h);
    ctx.fill();
  }
  for (const t of level.targets) {
    ctx.strokeStyle = '#e8f0ff';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(t.x, t.y, t.radius, 0, Math.PI * 2); ctx.stroke();
  }
  const paths = solutionPaths(level, devices);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  paths.forEach((p, i) => {
    const body = level.bodies[i];
    const color = BODY_COLORS[body.hue % BODY_COLORS.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k], p[k + 1]);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(body.x, body.y, body.radius, 0, Math.PI * 2); ctx.fill();
  });
  for (const d of devices) {
    ctx.fillStyle = DEVICE_COLORS[d.type];
    ctx.beginPath(); ctx.arc(d.x, d.y, 11, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#0a1020';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  ctx.restore();
}

export const CARD_W = 1200;
export const CARD_H = 630;

/** Shareable score card: challenge, score, rank, time and a picture of the solution. */
export function drawScoreCard(canvas: HTMLCanvasElement, d: CardData): void {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const bg = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
  bg.addColorStop(0, '#070b16');
  bg.addColorStop(1, '#101a33');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.strokeStyle = 'rgba(94,230,255,0.07)';
  ctx.lineWidth = 1;
  for (let gx = 0; gx < CARD_W; gx += 40) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, CARD_H); ctx.stroke(); }
  for (let gy = 0; gy < CARD_H; gy += 40) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(CARD_W, gy); ctx.stroke(); }

  const head = '"Chakra Petch", "Segoe UI", sans-serif';
  const mono = '"JetBrains Mono", ui-monospace, monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#e8f0ff';
  ctx.font = `700 34px ${head}`;
  ctx.fillText('VECTOR', 56, 82);
  const vw = ctx.measureText('VECTOR').width;
  ctx.fillStyle = '#5ee6ff';
  ctx.fillText('LAB', 56 + vw + 4, 82);

  ctx.fillStyle = '#8ea3c8';
  ctx.font = `600 22px ${head}`;
  ctx.fillText(d.heading.toUpperCase(), 56, 150);
  ctx.fillStyle = '#e8f0ff';
  ctx.font = `700 44px ${head}`;
  let title = d.title;
  while (ctx.measureText(title).width > 500 && title.length > 4) title = `${title.slice(0, -2).trimEnd()}…`;
  ctx.fillText(title, 56, 204);

  ctx.fillStyle = '#5ee6ff';
  ctx.font = `700 104px ${mono}`;
  ctx.fillText(Math.round(d.score).toLocaleString('en-US'), 52, 330);
  ctx.fillStyle = '#8ea3c8';
  ctx.font = `500 22px ${head}`;
  ctx.fillText(`of 100,000 · grade ${gradeOf(d.score)}`, 58, 366);

  const stat = (label: string, value: string, sx: number, sy: number) => {
    ctx.fillStyle = '#8ea3c8';
    ctx.font = `600 18px ${head}`;
    ctx.fillText(label.toUpperCase(), sx, sy);
    ctx.fillStyle = '#e8f0ff';
    ctx.font = `600 34px ${mono}`;
    ctx.fillText(value, sx, sy + 42);
  };
  stat('Rank', d.rank ? `#${d.rank.rank} of ${d.rank.players}` : 'Unranked', 56, 440);
  stat('Time', `${d.time.toFixed(2)}s`, 330, 440);
  stat('Generators', `${d.devicesUsed}`, 330, 548);
  stat('Energy kJ', `${formatEnergy(d.energy)}`, 56, 548);
  ctx.fillStyle = '#8ea3c8';
  ctx.font = `500 18px ${head}`;
  

  drawPreview(ctx, d.level, d.devices, 620, 118, 524);
  ctx.fillStyle = '#8ea3c8';
  ctx.font = `500 18px ${head}`;
  ctx.fillText(`${d.rank ? 'Server-verified solution' : 'Solution preview'}${d.player ? ` · ${d.player}` : ''}`, 620, 118 + 524 * (d.level.arena.h / d.level.arena.w) + 34);
}
