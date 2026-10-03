/** A sphere that shoves plants aside (part of the lizard's body), in world space. */
export interface Pusher {
  x: number;
  y: number;
  z: number;
  r: number;
}

/**
 * One plant's sway: a stem standing at (x, y, z) that tilts about its base. The tilt is a vector in
 * the ground plane (radians; its direction is the way the top leans, its length how far), driven by
 * a damped spring back to upright. Plants have no physics body: nothing they do moves the lizard.
 */
export interface PlantBody {
  x: number;
  y: number;
  z: number;
  /** Stem height (m). */
  height: number;
  /** How far from the stem a body has to stay clear (m): half the plant's spread, plus a little. */
  radius: number;
  /** Furthest the stem lies over when pushed (radians). */
  maxTilt: number;
  /** Spring natural frequency (rad/s) and damping ratio; above 1 it returns without overshooting. */
  omega: number;
  zeta: number;
  tx: number;
  tz: number;
  vx: number;
  vz: number;
  /** False once the plant has settled upright and nothing touches it; it's skipped until touched. */
  awake: boolean;
}

/** How fast a pushed stem gives way toward the lean that would clear the pusher (per second, exponential). */
const GIVE_RATE = 10;
/** Below these the plant counts as upright and still. */
const REST_TILT = 2e-4;
const REST_SPIN = 2e-3;

/**
 * Advance one plant by `dt`. The spring pulls the stem upright; then each pusher overlapping the
 * stem eases it toward the lean that would clear it (capped at `maxTilt`, so a stiff plant can't
 * get fully out of the way), and any swing back into the pusher is cancelled. When the pusher moves
 * on, the spring brings the stem back: overdamped plants creep upright without bouncing.
 */
export function stepPlant(p: PlantBody, pushers: readonly Pusher[], dt: number) {
  if (p.awake) {
    const k = p.omega * p.omega;
    const c = 2 * p.zeta * p.omega;
    p.vx += (-k * p.tx - c * p.vx) * dt;
    p.vz += (-k * p.tz - c * p.vz) * dt;
    p.tx += p.vx * dt;
    p.tz += p.vz * dt;
  }

  let touched = false;
  for (const s of pushers) {
    const clear = p.radius + s.r;
    const reach = p.height + clear;
    let ux = s.x - p.x;
    let uz = s.z - p.z;
    if (Math.abs(ux) > reach || Math.abs(uz) > reach) continue;
    const y = s.y - p.y;
    if (y < -s.r || y > reach) continue;
    const d = Math.hypot(ux, uz);
    const rho = Math.hypot(d, y);
    if (rho > reach) continue;
    // Straight above the root there's no "away"; lean the way it already leans.
    if (d < 1e-5) {
      const t = Math.hypot(p.tx, p.tz);
      [ux, uz] = t > 1e-6 ? [-p.tx, -p.tz] : [-1, 0];
    }
    const ul = Math.hypot(ux, uz);
    const ax = -ux / ul;
    const az = -uz / ul;
    // Work in the upright plane through the root and the pusher. The stem leaning `along` radians
    // away from the pusher passes rho * sin(along + phi) from its centre, phi being the pusher's
    // angle off vertical seen from the root. It clears either by leaning away far enough, or, once
    // it is already under the body (a negative distance), by lying flatter beneath it: so a stem
    // flattened by the head stays down under the belly and tail instead of flipping over.
    const along = p.tx * ax + p.tz * az;
    const phi = Math.atan2(d, y);
    const under = rho * Math.sin(along + phi) < 0;
    const gap = rho <= clear ? Infinity : Math.asin(clear / rho);
    let target: number;
    if (under) {
      target = Math.max(-p.maxTilt, -phi - gap);
      if (along <= target) continue;
    } else {
      target = Math.min(p.maxTilt, gap - phi);
      if (along >= target) continue;
    }
    touched = true;
    const give = (target - along) * Math.min(1, GIVE_RATE * dt);
    p.tx += ax * give;
    p.tz += az * give;
    // Cancel any swing back into the pusher.
    const spin = p.vx * ax + p.vz * az;
    if (under ? spin > 0 : spin < 0) {
      p.vx -= ax * spin;
      p.vz -= az * spin;
    }
  }

  const t = Math.hypot(p.tx, p.tz);
  if (t > p.maxTilt) {
    p.tx *= p.maxTilt / t;
    p.tz *= p.maxTilt / t;
  }
  if (touched) p.awake = true;
  else if (p.awake && t < REST_TILT && Math.hypot(p.vx, p.vz) < REST_SPIN) {
    p.awake = false;
    p.tx = p.tz = p.vx = p.vz = 0;
  }
}
