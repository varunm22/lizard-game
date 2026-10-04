import { smoothstep, valueNoise } from './noise';
import { BEACH_WIDTH, rockyShore, shoreX } from './shore';

/**
 * Where each kind of ground is, island-style: a dry clearing in the middle where the lizard starts,
 * forest closing in from the west and the north (-Z), and the coast to the east (`shore.ts`): sand
 * in the middle, black lava at both ends.
 */

/** Spawn on open ground in the clearing, facing the log and the big rock with the forest behind them. */
export const SPAWN = { x: 0.1, z: 0.05, yaw: Math.PI };

/**
 * A strip of open sand from the back of the beach into the sea, kept clear of rocks, so there is
 * always a clean way down to the water: z from - to +, and from this far up the beach.
 */
export const BEACH_PATH = { z0: 0.95, z1: 1.3, from: -0.5 };

/**
 * The giant tortoise's round: an oval through the grassy clearing north of the spawn and back from
 * the beach, clear of every rock, log and tree by more than a shell's width, on gentle ground, and
 * well away from the spawn and the path down to the sea. Centre and half-axes along X and Z (m).
 */
export const TORTOISE_ROUTE = { x: -0.3, z: 2.1, rx: 0.75, rz: 0.65 };

/** How wooded (x, z) is, 0 to 1: forest west of x = -1.3 and north of z = -1.3, with ragged edges. */
export function forestCover(x: number, z: number): number {
  const ragged = valueNoise(x / 0.7 + 5, z / 0.7 - 9, 21) * 0.35;
  const west = smoothstep(-0.9, -1.6, x + ragged);
  const north = smoothstep(-1.0, -1.7, z + ragged) * smoothstep(1.4, 0.7, x);
  return Math.max(west, north);
}

/** Distance east of the waterline (m): negative on land. */
export const shoreDistance = (x: number, z: number) => x - shoreX(z);

/** How much (x, z) is open sand: the beach between the waterline and the land behind it. */
export function sandCover(x: number, z: number): number {
  const s = shoreDistance(x, z) + valueNoise(x / 0.3, z / 0.3, 22) * 0.12;
  return (1 - rockyShore(z)) * smoothstep(-BEACH_WIDTH - 0.15, -BEACH_WIDTH + 0.2, s);
}

/** How much (x, z) is bare black lava: the rocky coast and a strip inland of it. */
export function lavaCover(x: number, z: number): number {
  const s = shoreDistance(x, z) + valueNoise(x / 0.3 - 4, z / 0.3, 23) * 0.2;
  return rockyShore(z) * smoothstep(-1.4, -0.9, s);
}
