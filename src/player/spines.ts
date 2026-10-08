import RAPIER from '@dimforge/rapier3d-compat';
import type { PlayerController } from './controller';
import { MOVEMENT as M } from './movement';
import type { Obstacle } from '../world/obstacles';
import { CACTUS_GROUP } from '../world/terrain';

/** Down rays from the middle of the belly, this far along the body either side of its centre (m). */
const BELLY = [-0.03, 0, 0.03];
/** A cactus top within this of the underside of the body is what it's lying on (m). */
const REACH = M.bodyRadius + M.skin + 0.015;
/** Where the hop lands, roughly: this far from where it starts (m). */
const HOP_REACH = 0.14;
/** A landing spot within this of another cactus's trunk is on that one too (m). */
const LANDING_CLEAR = 0.07;
/** Queries that see only the cactus trunks. */
const ONLY_CACTUS = (0xffff << 16) | CACTUS_GROUP;

/**
 * Lava cactus spines. A lizard that ends up lying on a cactus's top, whether it jumped up there or
 * crawled over the rim, hops straight off again, away from the trunk and from the rest of its clump.
 * Only the top counts, found with rays straight down from the middle of the belly: brushing past a
 * cactus's side does nothing. The player's lizard is hurt too (`Wounds.prick`); the other iguanas
 * never climb onto one in the first place (their `climbGroups` leave cactus out), and this only
 * catches one that lands there from a hop.
 */
export class Spines {
  private cacti: Obstacle[];
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(
    private world: RAPIER.World,
    obstacles: readonly Obstacle[],
  ) {
    this.cacti = obstacles.filter((o) => o.kind === 'cactus');
  }

  /** The cactus whose top `body` is lying on, or null. */
  under(body: PlayerController): Obstacle | null {
    if (!body.grounded || body.swimming || body.climbing) return null;
    const fx = Math.sin(body.yaw);
    const fz = Math.cos(body.yaw);
    for (const s of BELLY) {
      this.ray.origin = { x: body.position.x + fx * s, y: body.position.y, z: body.position.z + fz * s };
      const hit = this.world.castRay(this.ray, REACH, true, undefined, ONLY_CACTUS, undefined, body.body);
      // A ray that starts inside the trunk is beside it, not on it.
      if (hit && hit.timeOfImpact > 1e-4) return this.cacti.find((c) => c.collider.handle === hit.collider.handle) ?? null;
    }
    return null;
  }

  /**
   * If `body` is on a cactus top, hop it off and return the way it hops (level, unit), else null. It
   * goes straight away from the trunk's centre (forward if it's right over it), turning as little as
   * it can from that to land clear of the clump's other cacti.
   */
  shake(body: PlayerController): { x: number; z: number } | null {
    const cactus = this.under(body);
    if (!cactus) return null;
    let dx = body.position.x - cactus.position.x;
    let dz = body.position.z - cactus.position.z;
    const off = Math.hypot(dx, dz);
    const away = off > 0.01 ? Math.atan2(dx, dz) : body.yaw;
    for (const turn of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.2, -2.2, Math.PI]) {
      dx = Math.sin(away + turn);
      dz = Math.cos(away + turn);
      const x = body.position.x + dx * HOP_REACH;
      const z = body.position.z + dz * HOP_REACH;
      if (this.cacti.every((c) => Math.hypot(c.position.x - x, c.position.z - z) > c.radius + LANDING_CLEAR)) break;
    }
    body.hopOff(dx, dz);
    return { x: dx, z: dz };
  }
}
