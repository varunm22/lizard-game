import { smoothstep, valueNoise } from '../world/noise';
import { WATER_Y } from '../world/shore';

/**
 * Beyond the island's west wall, past the lava crack: the forest bank drops away into a mangrove
 * lagoon, the next stage, seen from the bank top as the lizard walks out at the end of the run
 * (`walkOut.ts`, `lagoonView.ts`). It's outside the walkable square but for the gap cut in the
 * bank, which stays well above the water, so no plant or prop on the island moves. Centred on z, this far either side; the bank starts down at x0 and is under water
 * by x1 (m).
 */
export const BASIN = { z: 1.35, half: 1.5, x0: -4.0, x1: -4.7 } as const;
/** The lagoon floor: this far under the water, a little uneven (m). */
const FLOOR = 0.05;

/** How open the island's west bank is at z, 0 to 1: it's cut down in a gap facing the lagoon, so its water shows from inside the walls. */
export const basinGap = (z: number) => smoothstep(BASIN.half - 0.5, BASIN.half - 1.1, Math.abs(z - BASIN.z));

/** How far (x, z) is into the lagoon basin, 0 (the island's ground) to 1 (its floor). */
export function basinDip(x: number, z: number): number {
  if (x >= BASIN.x0) return 0;
  return smoothstep(BASIN.x0, BASIN.x1, x) * smoothstep(BASIN.half, BASIN.half - 0.8, Math.abs(z - BASIN.z));
}

/** The lagoon's muddy floor at (x, z). */
export const basinFloor = (x: number, z: number) => WATER_Y - FLOOR + 0.025 * valueNoise(x / 0.6 - 3, z / 0.6 + 8, 51);
