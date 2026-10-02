import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Obstacle } from '../world/obstacles';

/** Opacity of an obstacle standing between the camera and the lizard. */
const FADED_OPACITY = 0.3;
/** How fast opacity eases toward its target (per second, exponential). */
const FADE_RATE = 12;
/** Sight lines run to the lizard's middle and to points this far ahead of and behind it (m). */
const BODY_REACH = 0.06;

/**
 * Makes obstacles translucent while they block the view of the lizard, so the camera can stay at
 * its full distance behind rocks and logs instead of zooming in past them. Checks a few sight lines
 * from the camera to the lizard's body, plus whether the camera itself is inside an obstacle.
 */
export class OccluderFade {
  /** Obstacle colliders by handle; the camera's own collision sweep skips these. */
  readonly handles: Set<number>;
  private byHandle = new Map<number, Obstacle>();
  private opacity = new Map<Obstacle, number>();
  private blocking = new Set<Obstacle>();
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  private to = new THREE.Vector3();
  private only = (c: RAPIER.Collider) => this.byHandle.has(c.handle);

  constructor(
    private world: RAPIER.World,
    private obstacles: Obstacle[],
  ) {
    for (const o of obstacles) {
      this.byHandle.set(o.collider.handle, o);
      this.opacity.set(o, 1);
    }
    this.handles = new Set(this.byHandle.keys());
  }

  /** Names of the obstacles currently fading out (for tests). */
  get faded(): string[] {
    return [...this.blocking].map((o) => o.name);
  }

  update(camera: THREE.Vector3, target: THREE.Vector3, facingYaw: number, dt: number) {
    this.blocking.clear();
    const fx = Math.sin(facingYaw) * BODY_REACH;
    const fz = Math.cos(facingYaw) * BODY_REACH;
    for (const k of [0, 1, -1]) {
      this.to.set(target.x + fx * k, target.y, target.z + fz * k).sub(camera);
      const len = this.to.length();
      if (len < 1e-4) continue;
      this.ray.origin = camera;
      this.ray.dir = this.to.divideScalar(len);
      this.world.intersectionsWithRay(
        this.ray,
        len,
        true,
        (hit) => {
          this.blocking.add(this.byHandle.get(hit.collider.handle)!);
          return true;
        },
        undefined,
        undefined,
        undefined,
        undefined,
        this.only,
      );
    }
    this.world.intersectionsWithPoint(
      camera,
      (c) => {
        this.blocking.add(this.byHandle.get(c.handle)!);
        return true;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      this.only,
    );

    const k = 1 - Math.exp(-FADE_RATE * dt);
    for (const o of this.obstacles) {
      const goal = this.blocking.has(o) ? FADED_OPACITY : 1;
      let a = this.opacity.get(o)!;
      a = Math.abs(goal - a) < 0.01 ? goal : a + (goal - a) * k;
      this.opacity.set(o, a);
      const m = o.mesh.material as THREE.Material;
      const see = a < 1;
      if (m.transparent !== see) {
        m.transparent = see;
        m.depthWrite = !see;
        // Self-shadowing shows as dark streaks through a see-through surface.
        o.mesh.receiveShadow = !see;
        m.needsUpdate = true;
      }
      m.opacity = a;
    }
  }
}
