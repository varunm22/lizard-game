import { smoothstep, valueNoise } from '../world/noise';

/**
 * The grieta: a deep lava fissure running the whole length of the island's west side, wall to wall,
 * too wide for the lizard to jump. West of it is the trail out of the colony; the way over is the
 * dead tree on its east rim, once the tortoise knocks it down (`snag.ts`). Centre line x at the
 * middle, how far it wanders, its half-width at the rim and how deep it is (m).
 */
export const CRACK = { x: -2.95, wander: 0.06, half: 0.14, depth: 0.26 } as const;
/** The walls drop over this much of the half-width (m): a little more than one heightfield cell, so they're sheer. */
const WALL = 0.035;

/** X of the crack's centre line at z. */
export const crackX = (z: number) => CRACK.x + CRACK.wander * Math.sin(1.3 * z + 0.4) + 0.03 * Math.sin(3.1 * z - 1);

/** Half-width (m) at z: a little ragged along its length. */
export const crackHalf = (z: number) => CRACK.half + 0.012 * valueNoise(z / 0.25, 3, 41);

/** How far below the ground around it the crack cuts at (x, z) (m, 0 outside it). */
export function crackCut(x: number, z: number): number {
  const s = Math.abs(x - crackX(z));
  const half = crackHalf(z);
  if (s >= half) return 0;
  const floor = 0.02 * valueNoise(x / 0.06, z / 0.06, 42);
  return (CRACK.depth + floor) * smoothstep(half, half - WALL, s);
}

/** Whether (x, z) is over the crack, or within `margin` of its rim (m). */
export const overCrack = (x: number, z: number, margin = 0) => Math.abs(x - crackX(z)) < crackHalf(z) + margin;

/** Which side of the crack (x, z) is on: -1 the far (west) side, 1 the colony's. */
export const crackSide = (x: number, z: number) => (x < crackX(z) ? -1 : 1);
