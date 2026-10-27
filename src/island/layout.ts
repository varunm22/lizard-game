import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d';
import { covers, type Obstacle } from '../world/obstacles';
import { crackHalf, crackX, overCrack } from './crack';

/**
 * Where the island's way out is laid out: the fig tree at the forest edge west of the spawn, out of
 * the tortoise's notice from its meadow; the dead tree (snag) on the crack's east rim; and a game
 * trail from the meadow through the trees to it, kept clear so the tortoise can be led down it.
 */
export const FIG_TREE = { x: -1.55, z: 0.35 };
/** The dead tree stands this far in from the rim, at this z, and falls west across the crack. */
const SNAG_Z = 1.35;
const SNAG_IN = 0.07;
export const SNAG = { x: crackX(SNAG_Z) + crackHalf(SNAG_Z) + SNAG_IN, z: SNAG_Z };
/** The trail: from the meadow's west end to the dead tree, this wide either side (m). */
export const TRAIL = { x0: -1.0, z0: 1.62, x1: SNAG.x, z1: SNAG.z, half: 0.2 };
/** The dead tree's fall line across the crack, kept clear for this far past the snag and this wide (m). */
const LANDING = { reach: 0.8, half: 0.14 };
/** Room round the fig tree (m). */
const FIG_ROOM = 0.42;

/** How far (x, z) is from the segment a to b, along the ground. */
function segmentDistance(x: number, z: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
}

/** Whether an obstacle would be in the way of the puzzle: in the crack, on the trail, on the dead tree's fall line or by the fig tree. */
function inTheWay(o: Obstacle): boolean {
  const [x, z] = [o.position.x, o.position.z];
  const reach = o.radius + (o.axis ? Math.hypot(o.axis.x, o.axis.z) : 0);
  if (overCrack(x, z, reach + 0.04)) return true;
  // A log's whole length counts, so sample along it.
  const along = o.axis ? [-1, -0.5, 0, 0.5, 1] : [0];
  for (const t of along) {
    const px = x + (o.axis?.x ?? 0) * t;
    const pz = z + (o.axis?.z ?? 0) * t;
    if (overCrack(px, pz, o.radius + 0.04)) return true;
    if (segmentDistance(px, pz, TRAIL.x0, TRAIL.z0, TRAIL.x1, TRAIL.z1) < TRAIL.half + o.radius) return true;
    if (segmentDistance(px, pz, SNAG.x, SNAG.z, SNAG.x - LANDING.reach, SNAG.z) < LANDING.half + o.radius) return true;
  }
  return covers(o, FIG_TREE.x, FIG_TREE.z, FIG_ROOM) || covers(o, SNAG.x, SNAG.z, 0.15);
}

/**
 * Take the scattered props that would be in the puzzle's way out of the world, after they were all
 * laid out, so every other prop stays exactly where it was. Returns the ones kept.
 */
export function clearForPuzzle(obstacles: Obstacle[], scene: THREE.Scene, world: RAPIER.World): Obstacle[] {
  return obstacles.filter((o) => {
    if (!inTheWay(o)) return true;
    scene.remove(o.mesh);
    world.removeCollider(o.collider, false);
    return false;
  });
}
