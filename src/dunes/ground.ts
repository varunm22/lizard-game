import RAPIER from '@dimforge/rapier3d-compat';
import { IGNORE_STEMS_AND_IGUANAS, terrainHeight } from '../world/terrain';
import { WATER_Y } from '../world/shore';
import { covers, type Obstacle } from '../world/obstacles';

/**
 * Ground under the dunes' drawn animals (snakes and hatchlings, which have no colliders of their
 * own): the first surface below a point, sand, lava or the top of a rock, never the player's body
 * or a plant stem. Falls back to the terrain before physics can answer rays.
 */
export class GroundProbe {
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(
    private world: RAPIER.World,
    private exclude: RAPIER.RigidBody,
  ) {}

  /** Height of the surface under (x, z), looking down from `above` m over `from` (default the terrain). */
  at(x: number, z: number, from = terrainHeight(x, z), above = 0.12): number {
    const top = from + above;
    this.ray.origin = { x, y: top, z };
    const hit = this.world.castRay(this.ray, above + 0.3, true, undefined, IGNORE_STEMS_AND_IGUANAS, undefined, this.exclude);
    return hit ? top - hit.timeOfImpact : terrainHeight(x, z);
  }

  /** The point (x, y, z) to `to` is in the clear: nothing solid between them but the player. */
  clear(x: number, y: number, z: number, tx: number, ty: number, tz: number): boolean {
    const dx = tx - x;
    const dy = ty - y;
    const dz = tz - z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return true;
    this.ray.origin = { x, y, z };
    this.ray.dir = { x: dx / len, y: dy / len, z: dz / len };
    const hit = this.world.castRay(this.ray, len, true, undefined, IGNORE_STEMS_AND_IGUANAS, undefined, this.exclude);
    this.ray.dir = { x: 0, y: -1, z: 0 };
    return !hit;
  }
}

/** Obstacles taller than this (m) are gone round; lower rocks are crawled or run straight over. */
const CLIMBABLE = 0.055;
const EDGE = 3.85;

/**
 * Whether a small animal can go to (x, z): inside the walls, out of the sea, and not into a tree,
 * cactus or any rock too tall to crawl over (with `margin` m to spare).
 */
export function passable(obstacles: readonly Obstacle[], x: number, z: number, margin: number): boolean {
  if (Math.abs(x) > EDGE || Math.abs(z) > EDGE) return false;
  if (terrainHeight(x, z) < WATER_Y + 0.006) return false;
  for (const o of obstacles) {
    if (o.kind === 'rock' && o.height < CLIMBABLE) continue;
    if (covers(o, x, z, margin)) return false;
  }
  return true;
}

/** Turns tried, in order, when the way ahead is blocked (radians either side). */
const TURNS = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.8, -1.8, 2.3, -2.3, Math.PI];

/**
 * The heading nearest `yaw` (as the lizard's: 0 is +Z) that is passable for `look` m ahead of
 * (x, z), checked at a few points along the way; `yaw` itself if nothing is.
 */
export function steer(obstacles: readonly Obstacle[], x: number, z: number, yaw: number, look: number, margin: number): number {
  for (const turn of TURNS) {
    const a = yaw + turn;
    const sx = Math.sin(a);
    const sz = Math.cos(a);
    let ok = true;
    for (const f of [0.35, 0.7, 1]) {
      if (!passable(obstacles, x + sx * look * f, z + sz * look * f, margin)) {
        ok = false;
        break;
      }
    }
    if (ok) return a;
  }
  return yaw;
}
