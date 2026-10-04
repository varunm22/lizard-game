import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { IGNORE_STEMS } from '../world/terrain';
import type { LizardModel } from './lizardModel';

/**
 * Tail bones from the hips back, each with the radius of the tail at its far end (m). The far end of
 * the last is the tail tip.
 */
const TAIL = [
  ['tail1', 0.0045],
  ['tail2', 0.0035],
  ['tail3', 0.0025],
  ['tail4', 0.0015],
] as const;
/** Points along each bone that are kept clear, as fractions of its length. */
const ALONG = [0.5, 1];
/** Radius kept clear round the sole of each foot (m): none, so a foot rests on a face, not in it, without being lifted off the ground. */
const SOLE_RADIUS = 0;
/** Most a tail bone or leg may be turned away from its pose to clear something (radians). */
const MAX_TAIL_TURN = 1.3;
const MAX_LEG_TURN = 0.6;
/** Halvings when searching for the smallest turn that clears. */
const SEARCH_STEPS = 6;
/** A push this much shorter (m) counts as clear: contact, not overlap. */
const SLOP = 0.0002;

const UP = new THREE.Vector3(0, 1, 0);

interface Link {
  bone: THREE.Object3D;
  /** The points kept clear, in the bone's frame unless `from` names a child they ride on. */
  points: { at: THREE.Vector3; r: number; from?: THREE.Object3D }[];
  max: number;
}

/**
 * Turns tail bones and legs out of rocks, logs and the ground after everything else has posed the
 * body. The spine fit only sees the surface on a line under the body, and only bends up and down, so
 * a tail swung sideways or a foot beside a face can end up inside something; and the tail has no
 * collider, so backing or turning beside a rock sweeps it through. Each bone in turn, from the body
 * outward, is rotated about its joint by the smallest angle that brings the points along it clear,
 * trying the way out of whatever it's in first, then up, then to either side (a tail pushed straight
 * into a face can only bend round it). The rest of the chain follows before it is checked.
 */
export class BodyClearance {
  private links: Link[] = [];
  private ball = new RAPIER.Ball(0.001);
  private rot = { x: 0, y: 0, z: 0, w: 1 };
  private p = new THREE.Vector3();
  private push = new THREE.Vector3();
  private worstPush = new THREE.Vector3();
  private worstAt = new THREE.Vector3();
  private joint = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private parentQ = new THREE.Quaternion();
  private boneQ = new THREE.Quaternion();
  private posed = new THREE.Quaternion();

  constructor(
    private model: LizardModel,
    private world: RAPIER.World,
    private exclude: RAPIER.RigidBody,
  ) {
    const root = model.root;
    root.updateMatrixWorld(true);
    TAIL.forEach(([name, r], i) => {
      const bone = root.getObjectByName(name)!;
      const next = TAIL[i + 1];
      const end = next
        ? root.getObjectByName(next[0])!.getWorldPosition(new THREE.Vector3())
        : root.localToWorld(new THREE.Vector3(...model.tailTip));
      bone.worldToLocal(end);
      this.links.push({ bone, points: ALONG.map((t) => ({ at: end.clone().multiplyScalar(t), r })), max: MAX_TAIL_TURN });
    });
    for (const { upper, lower, foot } of model.legs) {
      this.links.push({ bone: upper, points: [{ at: foot, r: SOLE_RADIUS, from: lower }], max: MAX_LEG_TURN });
    }
  }

  apply() {
    this.model.root.updateMatrixWorld(true);
    for (const link of this.links) {
      const depth = this.worst(link);
      if (depth <= SLOP) continue;
      const bone = link.bone;
      bone.getWorldPosition(this.joint);
      const along = this.p.copy(this.worstAt).sub(this.joint).normalize().clone();
      // Ways to turn the worst point, each perpendicular to the bone: out along its push, up, either side.
      const sideways = new THREE.Vector3().crossVectors(along, UP).normalize();
      const ways = [this.worstPush.clone(), UP.clone(), sideways, sideways.clone().negate()]
        .map((w) => w.addScaledVector(along, -w.dot(along)))
        .filter((w) => w.lengthSq() > 1e-8)
        .map((w) => new THREE.Vector3().crossVectors(along, w.normalize()).normalize());
      this.posed.copy(bone.quaternion);
      let bestAxis: THREE.Vector3 | null = null;
      let bestAngle = Infinity;
      let fallback: THREE.Vector3 | null = null;
      let fallbackDepth = depth;
      for (const axis of ways) {
        const atMax = this.turnBy(link, axis, link.max);
        if (atMax > SLOP) {
          if (atMax < fallbackDepth) {
            fallbackDepth = atMax;
            fallback = axis;
          }
          continue;
        }
        // Clear at the limit: halve down to the smallest turn that still clears.
        let lo = 0;
        let hi = link.max;
        for (let i = 0; i < SEARCH_STEPS && hi - lo > 0.01; i++) {
          const mid = (lo + hi) / 2;
          if (this.turnBy(link, axis, mid) > SLOP) lo = mid;
          else hi = mid;
        }
        if (hi < bestAngle) {
          bestAngle = hi;
          bestAxis = axis;
        }
      }
      if (bestAxis) this.turnBy(link, bestAxis, bestAngle);
      else if (fallback) this.turnBy(link, fallback, link.max);
      else this.turnBy(link, UP, 0);
    }
  }

  /**
   * How deep each kept-clear point is inside the world (m, 0 when clear), tail first then feet, for
   * tests. Measured on the pose as drawn.
   */
  depths(): number[] {
    this.model.root.updateMatrixWorld(true);
    const out: number[] = [];
    for (const link of this.links) {
      for (const pt of link.points) {
        const p = this.p.copy(pt.at).applyMatrix4((pt.from ?? link.bone).matrixWorld);
        out.push(this.pushOut(p, 0, this.push));
      }
    }
    return out;
  }

  /**
   * Pose `link`'s bone turned by `angle` about the world `axis` through its joint, from its posed
   * rotation (saved in `posed`), and return how far its worst point is from clear.
   */
  private turnBy(link: Link, axis: THREE.Vector3, angle: number): number {
    const bone = link.bone;
    bone.quaternion.copy(this.posed);
    bone.updateMatrixWorld(true);
    if (angle > 0) {
      bone.parent!.getWorldQuaternion(this.parentQ);
      bone.getWorldQuaternion(this.boneQ);
      this.q.setFromAxisAngle(axis, angle);
      bone.quaternion.copy(this.parentQ.invert().multiply(this.q).multiply(this.boneQ));
      bone.updateMatrixWorld(true);
    }
    return this.worst(link);
  }

  /** The biggest push any point on `link` needs to clear by its radius; the push and point go in worstPush/worstAt. */
  private worst(link: Link): number {
    let most = 0;
    for (const pt of link.points) {
      const p = this.p.copy(pt.at).applyMatrix4((pt.from ?? link.bone).matrixWorld);
      const d = this.pushOut(p, pt.r, this.push);
      if (d > most) {
        most = d;
        this.worstPush.copy(this.push);
        this.worstAt.copy(p);
      }
    }
    return most;
  }

  /**
   * The move (into `out`) that takes a ball of radius `r` at `p` clear of the collider it's deepest
   * in or nearest touching; returns its length. Inside a collider counts as a depth past its surface.
   */
  private pushOut(p: THREE.Vector3, r: number, out: THREE.Vector3): number {
    out.set(0, 0, 0);
    let most = 0;
    this.ball.radius = Math.max(r, 1e-4);
    this.world.intersectionsWithShape(
      p,
      this.rot,
      this.ball,
      (c) => {
        const hit = c.projectPoint(p, false);
        if (!hit) return true;
        const dx = hit.point.x - p.x;
        const dy = hit.point.y - p.y;
        const dz = hit.point.z - p.z;
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-7) return true;
        // Inside: out through the nearest surface and on by r. Outside but within r: straight away from it.
        const need = hit.isInside ? d + r : r - d;
        const s = (hit.isInside ? need : -need) / d;
        if (need > most) {
          most = need;
          out.set(dx * s, dy * s, dz * s);
        }
        return true;
      },
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      IGNORE_STEMS,
      undefined,
      this.exclude,
    );
    return most;
  }
}
