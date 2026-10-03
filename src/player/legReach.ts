import * as THREE from 'three';
import type { LizardModel } from './lizardModel';

/** Furthest each leg swings up or down from its clip pose (radians). */
const MAX_SWING = 0.6;

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);

interface Leg {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  girdle: THREE.Object3D;
  /** Sole centre in the lower leg's frame. */
  foot: THREE.Vector3;
  /** Sole centre in the girdle's frame at rest, and the girdle's up axis in its own frame. */
  restInGirdle: THREE.Vector3;
  girdleUp: THREE.Vector3;
  /** The body's long axis in the upper leg's frame: swinging about it lifts or drops the foot. */
  axis: THREE.Vector3;
  /** Sideways distance from the leg's root to its foot, with +1 for the left legs and -1 for the right. */
  lever: number;
}

/**
 * Swings each leg up or down about the body's long axis so its foot lands on the surface under it,
 * after the clips and the spine fit have posed the body. It keeps the clip's own lift (a stepping
 * foot stays up), so it only corrects for ground that isn't flat under the body: one side of a log,
 * a rim, a sideways slope. A single swing per leg, not full IK.
 */
export class LegReach {
  private legs: Leg[] = [];
  private v = new THREE.Vector3();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();

  constructor(private model: LizardModel) {
    const root = model.root;
    root.updateMatrixWorld(true);
    const rootQ = root.getWorldQuaternion(new THREE.Quaternion()).invert();
    const frameOf = (o: THREE.Object3D) => rootQ.clone().multiply(o.getWorldQuaternion(new THREE.Quaternion())).invert();
    for (const [leg, soles] of model.soles) {
      const upper = root.getObjectByName('upper_' + leg);
      const lower = root.getObjectByName('lower_' + leg);
      const girdle = upper?.parent;
      if (!upper || !lower || !girdle) continue;
      // Sole centre in world space at rest, from its vertices as bound.
      const centre = new THREE.Vector3();
      for (const { mesh, index } of soles) centre.add(mesh.getVertexPosition(index, this.v).applyMatrix4(mesh.matrixWorld));
      centre.divideScalar(soles.length);
      const hip = upper.getWorldPosition(new THREE.Vector3());
      const side = leg.endsWith('_L') ? 1 : -1;
      this.legs.push({
        upper,
        lower,
        girdle,
        foot: lower.worldToLocal(centre.clone()),
        restInGirdle: girdle.worldToLocal(centre.clone()),
        girdleUp: UP.clone().applyQuaternion(frameOf(girdle)),
        axis: FORWARD.clone().applyQuaternion(frameOf(upper)),
        lever: side * Math.max(0.005, Math.abs(root.worldToLocal(centre.clone()).x - root.worldToLocal(hip).x)),
      });
    }
  }

  /**
   * @param surfaceAt Height of the surface under a foot at (x, z) near height y, or null if none.
   * @param weight 0 leaves the clip pose alone (in the air), 1 reaches fully.
   */
  apply(surfaceAt: (x: number, y: number, z: number) => number | null, weight: number) {
    if (weight <= 0) return;
    this.model.root.updateMatrixWorld(true);
    for (const leg of this.legs) {
      const foot = this.v.copy(leg.foot).applyMatrix4(leg.lower.matrixWorld);
      const ground = surfaceAt(foot.x, foot.y, foot.z);
      if (ground === null) continue;
      // The clip's own lift of this foot off its stance, measured in the girdle's frame.
      const inGirdle = foot.clone().applyMatrix4(this.m.copy(leg.girdle.matrixWorld).invert());
      const lift = inGirdle.sub(leg.restInGirdle).dot(leg.girdleUp);
      const error = ground + lift - foot.y;
      const swing = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(error / leg.lever, -1, 1)), -MAX_SWING, MAX_SWING);
      leg.upper.quaternion.multiply(this.q.setFromAxisAngle(leg.axis, swing * weight));
    }
  }
}
