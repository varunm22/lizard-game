import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { IGNORE_STEMS } from '../world/terrain';
import { exactShape, surfacePose } from '../world/exactSurface';
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
/**
 * How far a tail bone or a sole may sit inside something before it is turned out (m). The bones are
 * left alone for a graze, so the small, ever-changing overlaps of resting on a curved or moving surface
 * (a bobbing shell) don't swing them about; the feet are planted by the leg reach and only turned out
 * of a face they're well inside.
 */
const TAIL_TOLERANCE = 0.0015;
const LEG_TOLERANCE = 0.003;
/**
 * A tail bone pushed sideways into something (its push at least this much across the bone, as a share
 * of the push) turns aside first, so the resting sway stops against a rock instead of lifting over it.
 */
const SIDE_FIRST = 0.3;
/** Halvings when searching for the smallest turn that clears. */
const SEARCH_STEPS = 6;
/**
 * How fast a bone's turn eases toward the turn it needs (per second, exponential): quickly out of
 * something, slowly back to its pose, so it doesn't flick back and forth.
 */
const TURN_OUT_RATE = 20;
const TURN_BACK_RATE = 5;
/** Furthest above a point inside something to look for the top of it (m). */
const LOOK_UP = 0.1;

const UP = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Quaternion();

interface Link {
  bone: THREE.Object3D;
  /** The points kept clear, in the bone's frame unless `from` names a child they ride on. */
  points: { at: THREE.Vector3; r: number; from?: THREE.Object3D }[];
  max: number;
  tolerance: number;
  /** Turn aside before up when pushed sideways (the tail), rather than out along the push first. */
  sideFirst: boolean;
  /** The turn applied last frame, in the parent bone's frame, eased toward what the pose needs. */
  turn: THREE.Quaternion;
}

/**
 * Turns tail bones and legs out of rocks, logs and the ground after everything else has posed the
 * body. The spine fit only sees the surface on a line under the body, and only bends up and down, so
 * a tail swung sideways or a foot beside a face can end up inside something; and the tail has no
 * collider, so backing or turning beside a rock sweeps it through. Each bone in turn, from the body
 * outward, is rotated about its joint by the smallest angle that brings the points along it within a
 * small tolerance of clear (see `need`; a tail pushed straight into a face can only bend round it).
 * The rest of the chain follows before it is checked. It is meant to be gentle: a graze is left
 * alone, and a bone eases out of something and settles back slowly, so the small overlaps of resting
 * on a curved or moving surface don't set the tail and legs twitching.
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
  private target = new THREE.Quaternion();
  private up = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });

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
      this.links.push({ bone, points: ALONG.map((t) => ({ at: end.clone().multiplyScalar(t), r })), max: MAX_TAIL_TURN, tolerance: TAIL_TOLERANCE, sideFirst: true, turn: new THREE.Quaternion() });
    });
    for (const { upper, lower, foot } of model.legs) {
      this.links.push({ bone: upper, points: [{ at: foot, r: SOLE_RADIUS, from: lower }], max: MAX_LEG_TURN, tolerance: LEG_TOLERANCE, sideFirst: false, turn: new THREE.Quaternion() });
    }
  }

  /** @param dt Seconds since the last frame, for easing the turns. */
  apply(dt: number) {
    this.model.root.updateMatrixWorld(true);
    for (const link of this.links) {
      const bone = link.bone;
      this.posed.copy(bone.quaternion);
      this.need(link);
      // Ease toward the turn the pose needs, faster when it needs more.
      const out = this.target.angleTo(IDENTITY) > link.turn.angleTo(IDENTITY);
      link.turn.slerp(this.target, 1 - Math.exp(-(out ? TURN_OUT_RATE : TURN_BACK_RATE) * dt));
      bone.quaternion.copy(link.turn).multiply(this.posed);
      bone.updateMatrixWorld(true);
      // Easing between turns can pass through what it's turning round: then it goes straight there.
      if (this.worst(link) > link.tolerance && !link.turn.equals(this.target)) {
        link.turn.copy(this.target);
        bone.quaternion.copy(link.turn).multiply(this.posed);
        bone.updateMatrixWorld(true);
      }
    }
  }

  /**
   * The turn (into `target`, in the parent's frame) that brings `link`'s points within its tolerance
   * of clear: none if they already are. It tries the way out of whatever the worst point is in first,
   * then up, then to either side, and takes the smallest turn the first of those that works needs; so
   * it doesn't hop between ways as the overlap changes. If none clears, it turns as far as it may the
   * way that gets closest.
   */
  private need(link: Link) {
    this.target.identity();
    const depth = this.turnBy(link, null, 0);
    if (depth <= link.tolerance) return;
    link.bone.getWorldPosition(this.joint);
    const along = this.p.copy(this.worstAt).sub(this.joint).normalize().clone();
    // Ways to turn the worst point, each perpendicular to the bone: out along its push, up, either side.
    const sideways = new THREE.Vector3().crossVectors(along, UP).normalize();
    // A tail swung into the side of a rock stops against it: aside, away from the rock, comes first.
    const across = sideways.dot(this.worstPush) / this.worstPush.length();
    const aside = link.sideFirst && Math.abs(across) >= SIDE_FIRST;
    if (aside && across < 0) sideways.negate();
    const ways = (aside ? [sideways.clone(), this.worstPush.clone(), UP.clone()] : [this.worstPush.clone(), UP.clone(), sideways.clone(), sideways.clone().negate()])
      .map((w) => w.addScaledVector(along, -w.dot(along)))
      .filter((w) => w.lengthSq() > 1e-8)
      .map((w) => new THREE.Vector3().crossVectors(along, w.normalize()).normalize());
    // Keep turning the way it's already turned if that still works, so it doesn't swap sides of a
    // rock (and pass through it on the way) as the overlap shifts.
    const turned = 2 * Math.acos(Math.min(1, Math.abs(link.turn.w)));
    if (turned > 0.01) {
      const sign = link.turn.w < 0 ? -1 : 1;
      const axis = new THREE.Vector3(link.turn.x, link.turn.y, link.turn.z).multiplyScalar(sign).normalize();
      ways.unshift(axis.applyQuaternion(link.bone.parent!.getWorldQuaternion(this.parentQ)));
    }
    let fallback: THREE.Vector3 | null = null;
    let fallbackDepth = depth;
    for (const axis of ways) {
      const atMax = this.turnBy(link, axis, link.max);
      if (atMax > link.tolerance) {
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
        if (this.turnBy(link, axis, mid) > link.tolerance) lo = mid;
        else hi = mid;
      }
      this.turnBy(link, axis, hi);
      this.target.copy(link.bone.quaternion).multiply(this.posedInverse());
      return;
    }
    if (fallback) {
      this.turnBy(link, fallback, link.max);
      this.target.copy(link.bone.quaternion).multiply(this.posedInverse());
    }
  }

  private posedInverse() {
    return this.q.copy(this.posed).invert();
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

  /** Each kept-clear point as drawn, in world space, in the same order as `depths`. */
  points(): THREE.Vector3[] {
    this.model.root.updateMatrixWorld(true);
    return this.links.flatMap((link) => link.points.map((pt) => pt.at.clone().applyMatrix4((pt.from ?? link.bone).matrixWorld)));
  }

  /**
   * Pose `link`'s bone turned by `angle` about the world `axis` through its joint, from its posed
   * rotation (saved in `posed`), and return how far its worst point is from clear.
   */
  private turnBy(link: Link, axis: THREE.Vector3 | null, angle: number): number {
    const bone = link.bone;
    bone.quaternion.copy(this.posed);
    bone.updateMatrixWorld(true);
    if (axis && angle > 0) {
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
        const exact = exactShape(c);
        const pose = exact && surfacePose(c);
        const hit = pose ? exact.projectPoint(pose.pos, pose.rot, p, false) : c.projectPoint(p, false);
        if (!hit) return true;
        const dx = hit.point.x - p.x;
        const dy = hit.point.y - p.y;
        const dz = hit.point.z - p.z;
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-7) return true;
        // Inside: out through the nearest surface and on by r. Outside but within r: straight away from it.
        let need = hit.isInside ? d + r : r - d;
        const s = (hit.isInside ? need : -need) / d;
        let ox = dx * s;
        let oy = dy * s;
        let oz = dz * s;
        if (hit.isInside) {
          // Just inside a convex hull, the projection can come out through its far side (down through
          // the bottom of a shell the point is grazing). Up to the top is the move when that's shorter.
          this.up.origin = p;
          const toTop = pose ? exact.castRay(this.up, pose.pos, pose.rot, LOOK_UP, false) : c.castRay(this.up, LOOK_UP, false);
          if (toTop >= 0 && toTop + r < need) {
            need = toTop + r;
            ox = 0;
            oy = need;
            oz = 0;
          }
        }
        if (need > most) {
          most = need;
          out.set(ox, oy, oz);
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
