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
 * How far above and below the hips to look for what the lizard is on (m). A tail bone in anything
 * else (a rock beside it) turns aside first, level with the ground, so the sway stops against the
 * rock instead of lifting over it; one in what the lizard is on (the ground, a bobbing shell) is
 * lifted out of it, not swung about.
 */
const SUPPORT_ABOVE = 0.01;
const SUPPORT_BELOW = 0.03;
/** Most more (radians) a bone keeps turning the way it's turned already, before trying the other ways. */
const KEEP_SLACK = 0.3;
/** Step out (radians), then halvings, when searching for the smallest turn that clears. */
const SEARCH_STEP = 0.1;
const SEARCH_STEPS = 4;
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
  /** Turn aside first (the tail) when in something beside the lizard, before out along the push or up. */
  aside: boolean;
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
  /** The collider the last point `pushOut` measured needs moving out of most, and the worst point's. */
  private from: number | null = null;
  private worstFrom: number | null = null;
  /** The collider under the hips this frame: what the lizard is lying or standing on. */
  private support: number | null = null;
  private down = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private hips: THREE.Object3D;
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
    this.hips = root.getObjectByName(TAIL[0][0])!;
    TAIL.forEach(([name, r], i) => {
      const bone = root.getObjectByName(name)!;
      const next = TAIL[i + 1];
      const end = next
        ? root.getObjectByName(next[0])!.getWorldPosition(new THREE.Vector3())
        : root.localToWorld(new THREE.Vector3(...model.tailTip));
      bone.worldToLocal(end);
      this.links.push({ bone, points: ALONG.map((t) => ({ at: end.clone().multiplyScalar(t), r })), max: MAX_TAIL_TURN, tolerance: TAIL_TOLERANCE, aside: true, turn: new THREE.Quaternion() });
    });
    for (const { upper, lower, foot } of model.legs) {
      this.links.push({ bone: upper, points: [{ at: foot, r: SOLE_RADIUS, from: lower }], max: MAX_LEG_TURN, tolerance: LEG_TOLERANCE, aside: false, turn: new THREE.Quaternion() });
    }
  }

  /** @param dt Seconds since the last frame, for easing the turns. */
  apply(dt: number) {
    this.model.root.updateMatrixWorld(true);
    // What it's lying or standing on, from just above the hips (where the tail joins) down.
    const at = this.hips.getWorldPosition(this.p);
    this.down.origin = { x: at.x, y: at.y + SUPPORT_ABOVE, z: at.z };
    const hit = this.world.castRay(this.down, SUPPORT_ABOVE + SUPPORT_BELOW, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, IGNORE_STEMS, undefined, this.exclude);
    this.support = hit ? hit.collider.handle : null;
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
    const ways = [this.worstPush.clone(), UP.clone(), sideways, sideways.clone().negate()]
      .map((w) => w.addScaledVector(along, -w.dot(along)))
      .filter((w) => w.lengthSq() > 1e-8)
      .map((w) => new THREE.Vector3().crossVectors(along, w.normalize()).normalize());
    // Keep turning the way it's already turned if that still works, so it doesn't swap sides of a
    // rock (and pass through it on the way) as the overlap shifts.
    const turned = 2 * Math.acos(Math.min(1, Math.abs(link.turn.w)));
    const current = turned > 0.01 ? this.turnAxis(link) : null;
    const asideNow = current !== null && Math.abs(current.y) > 0.7;
    const beside = link.aside && this.support !== null && this.worstFrom !== this.support;
    if (beside) {
      // A tail turns aside first, whichever side needs less, so a sway into a rock stops at it.
      const level = new THREE.Vector3().crossVectors(along, sideways).normalize();
      let best: THREE.Vector3 | null = null;
      let bestAngle = link.max;
      // The way it's already turned aside if that still works (as above), else the nearer side.
      for (const asides of [asideNow ? [current] : [], [level, level.clone().negate()]]) {
        for (const axis of asides) {
          const angle = this.smallest(link, axis, bestAngle);
          if (angle !== null && (best === null || angle < bestAngle)) {
            best = axis;
            bestAngle = angle;
          }
        }
        if (best) break;
      }
      if (best) {
        this.turnBy(link, best, bestAngle);
        this.target.copy(link.bone.quaternion).multiply(this.posedInverse());
        return;
      }
    }
    if (current && !(beside && asideNow)) ways.unshift(current);
    let fallback: THREE.Vector3 | null = null;
    let fallbackDepth = depth;
    for (const axis of ways) {
      const angle = this.smallest(link, axis, link.max);
      // The way it's turned already only while it needs about as much as it has: a much bigger turn
      // that way is swinging round into something else.
      if (axis === current && angle !== null && angle > turned + KEEP_SLACK) continue;
      if (angle === null) {
        const atMax = this.turnBy(link, axis, link.max);
        if (atMax < fallbackDepth) {
          fallbackDepth = atMax;
          fallback = axis;
        }
        continue;
      }
      this.turnBy(link, axis, angle);
      this.target.copy(link.bone.quaternion).multiply(this.posedInverse());
      return;
    }
    if (fallback) {
      this.turnBy(link, fallback, link.max);
      this.target.copy(link.bone.quaternion).multiply(this.posedInverse());
    }
  }

  /** The world axis the bone is turned about now (from `link.turn`, in its parent's frame). */
  private turnAxis(link: Link): THREE.Vector3 {
    const sign = link.turn.w < 0 ? -1 : 1;
    const axis = new THREE.Vector3(link.turn.x, link.turn.y, link.turn.z).multiplyScalar(sign).normalize();
    return axis.applyQuaternion(link.bone.parent!.getWorldQuaternion(this.parentQ));
  }

  /**
   * The smallest turn about `axis`, up to `max`, that brings `link` within its tolerance of clear;
   * null if none does. Stepped out from no turn, since turning far enough one way can swing the
   * bone into something else (a tail lifted out of the ground and into the side of a rock).
   */
  private smallest(link: Link, axis: THREE.Vector3, max: number): number | null {
    let lo = 0;
    let hi = -1;
    for (let a = Math.min(SEARCH_STEP, max); ; a = Math.min(a + SEARCH_STEP, max)) {
      if (this.turnBy(link, axis, a) <= link.tolerance) {
        hi = a;
        break;
      }
      lo = a;
      if (a >= max) return null;
    }
    for (let i = 0; i < SEARCH_STEPS && hi - lo > 0.01; i++) {
      const mid = (lo + hi) / 2;
      if (this.turnBy(link, axis, mid) > link.tolerance) lo = mid;
      else hi = mid;
    }
    return hi;
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
        this.worstFrom = this.from;
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
    this.from = null;
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
          this.from = c.handle;
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
