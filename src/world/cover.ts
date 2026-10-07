import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { IGNORE_STEMS_AND_IGUANAS } from './terrain';
import { waterDepth } from './shore';
import type { Obstacle } from './obstacles';
import type { Plants } from './plants';

/** Under this much water (m) a point can't be seen from the air. */
const WATER_HIDES = 0.01;
/** A plant at least this grown and this little trampled hides what's in its crown. */
const PLANT_HIDES = 0.6;
/** A plant's crown hides points up to this share of its height, and this far out from its stem (m, plus its radius). */
const CROWN_HEIGHT = 0.85;
const CROWN_REACH = 0.006;

/**
 * Whether something can be seen from a point up in the air: a predator's sight line. A point is out
 * of sight under water, inside a standing plant's crown, or with anything solid between it and the
 * eye: the ground, rocks, logs, trunks and the tortoise (physics rays), or a tree's crown or a
 * cactus, which have no colliders, so their drawn meshes are checked instead.
 */
export class Cover {
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  private raycaster = new THREE.Raycaster();
  private crowns: THREE.Object3D[];
  private dir = new THREE.Vector3();
  private hits: THREE.Intersection[] = [];

  constructor(
    private world: RAPIER.World,
    obstacles: Obstacle[],
    private plants: Plants,
  ) {
    this.crowns = obstacles.filter((o) => o.kind === 'tree' || o.kind === 'cactus').map((o) => o.mesh);
  }

  /** Whether `p` can be seen from `eye`. Bodies in `ignore` (the one `p` is on) don't block the view. */
  inSight(eye: THREE.Vector3, p: { x: number; y: number; z: number }, ignore?: RAPIER.RigidBody): boolean {
    if (waterDepth(p) > WATER_HIDES) return false;
    if (this.inCrown(p)) return false;
    this.dir.set(p.x - eye.x, p.y - eye.y, p.z - eye.z);
    const dist = this.dir.length();
    if (dist < 1e-4) return true;
    this.dir.divideScalar(dist);
    this.ray.origin = eye;
    this.ray.dir = this.dir;
    if (this.world.castRay(this.ray, dist - 0.004, true, undefined, IGNORE_STEMS_AND_IGUANAS, undefined, ignore)) return false;
    this.raycaster.set(eye, this.dir);
    this.raycaster.far = dist;
    this.hits.length = 0;
    return this.raycaster.intersectObjects(this.crowns, false, this.hits).length === 0;
  }

  /** Inside a standing plant: under most of its height and within its reach of the stem. */
  private inCrown(p: { x: number; y: number; z: number }): boolean {
    for (const plant of this.plants.all) {
      const r = plant.radius + CROWN_REACH;
      const dx = p.x - plant.x;
      const dz = p.z - plant.z;
      if (Math.abs(dx) > r || Math.abs(dz) > r || dx * dx + dz * dz > r * r) continue;
      if (plant.growth * (1 - plant.crush) < PLANT_HIDES) continue;
      if (p.y < plant.y + plant.height * CROWN_HEIGHT) return true;
    }
    return false;
  }
}
