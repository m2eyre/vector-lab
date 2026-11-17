import { dcos, dsin } from '../core/dmath';
import { Device, DEVICE_LIMITS } from './types';

/** Inside this radius point devices fade to zero force, which removes the 1/r style singularity. */
const CORE_RADIUS = 16;
/** Fraction of a vortex's force that pulls inward, so objects orbit instead of being flung out. */
const VORTEX_INWARD = 0.4;
/** Fraction of peak force still felt at the very edge of a radial device's range. */
const EDGE_FORCE = 0.3;

export interface ForceOut {
  x: number;
  y: number;
}

/**
 * Force exerted by one device on a point at (px, py). Written into `out` to avoid allocation
 * in the hot loop. Forces are in force units: a heavier body accelerates less (a = F / m).
 *
 * Radial devices use the falloff  f(d) = 0.3 + 0.7 * (1 - (d / R)^2)  for d < R: strongest at
 * the centre, still 30% at the rim (so objects at the edge respond promptly), zero outside.
 * The force is bounded everywhere, which keeps the integrator stable.
 */
export function deviceForce(d: Device, px: number, py: number, out: ForceOut): ForceOut {
  out.x = 0;
  out.y = 0;
  const dx = px - d.x;
  const dy = py - d.y;

  if (d.type === 'field') {
    // Rotate into the field's local frame; the field is a strip aligned with its direction.
    const c = dcos(d.angle);
    const s = dsin(d.angle);
    const lx = dx * c + dy * s;
    const ly = -dx * s + dy * c;
    const halfW = d.range * DEVICE_LIMITS.fieldAspect;
    if (Math.abs(lx) <= d.range && Math.abs(ly) <= halfW) {
      out.x = c * d.strength;
      out.y = s * d.strength;
    }
    return out;
  }

  const distSq = dx * dx + dy * dy;
  if (distSq >= d.range * d.range || distSq < 1e-9) return out;
  const dist = Math.sqrt(distSq);
  const nx = dx / dist; // unit vector pointing away from the device
  const ny = dy / dist;
  const q = dist / d.range;
  let mag = d.strength * (EDGE_FORCE + (1 - EDGE_FORCE) * (1 - q * q));

  if (d.type === 'repulsor') {
    out.x = nx * mag;
    out.y = ny * mag;
    return out;
  }
  // Attractors and vortices soften to zero at the very centre.
  if (dist < CORE_RADIUS) mag *= dist / CORE_RADIUS;
  if (d.type === 'attractor') {
    out.x = -nx * mag;
    out.y = -ny * mag;
    return out;
  }
  // Vortex: tangential component (perpendicular to the radius) plus a mild inward pull.
  // Screen space has y pointing down, so (ny, -nx) is counter-clockwise as the player sees it.
  const tx = ny * d.spin;
  const ty = -nx * d.spin;
  out.x = (tx - nx * VORTEX_INWARD) * mag;
  out.y = (ty - ny * VORTEX_INWARD) * mag;
  return out;
}

const scratch: ForceOut = { x: 0, y: 0 };

/** Net device force at a point; used by the force-vector overlay. */
export function netDeviceForce(devices: Device[], px: number, py: number, out: ForceOut): ForceOut {
  let fx = 0;
  let fy = 0;
  for (let i = 0; i < devices.length; i++) {
    deviceForce(devices[i], px, py, scratch);
    fx += scratch.x;
    fy += scratch.y;
  }
  out.x = fx;
  out.y = fy;
  return out;
}
