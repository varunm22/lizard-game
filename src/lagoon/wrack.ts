import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import type { PlayerController } from '../player/controller';
import { WATER_Y } from '../world/shore';
import { PLAYER_GROUP, terrainHeight } from '../world/terrain';
import { CREEK_FLOW, current, DAM, depthAt, inChannel, SNAG } from './layout';

/** Shoved along up to this speed (m/s), picking it up at this rate (per second); stilled by the water at this rate. */
const PUSH_SPEED = 0.12;
const PUSH_GRIP = 6;
const DRAG = 1.5;
/** Rolled along the bed by the current at this share of its speed at the surface. */
const BED_SHARE = 0.75;
/** The lizard's snout is this far ahead of its middle (m); it shoves within this gap of a piece. */
const SNOUT = 0.08;
const PUSH_GAP = 0.025;
/** It reaches a piece this far below (or above) its middle (m): swimming over the dam, its feet catch the twigs. */
const REACH = 0.18;
/** Within this far (m) of the snag on the bed, a piece catches and racks up against it, taking this long (s). */
const CATCH = 0.1;
const RACK_TIME = 0.9;
/** The rack's top: just awash (m under the water), a little more or less piece to piece. */
const RACK_TOP = 0.004;
/** How far each piece leans from upright, pinned downstream against the snag by the current (radians). */
const LEAN = 0.4;
/** A log limb within this gap (m) of a racked piece's top hooks on it. */
const HOOK_GAP = 0.006;
/** How far each piece in the dam leans from upright (radians). */
const DAM_LEAN = 0.75;

export type WrackState = 'dam' | 'loose' | 'racking' | 'racked';

/** One piece of drift wrack: a dead twig or an old propagule, waterlogged, so it lies on the bed. */
export interface WrackPiece {
  kind: string;
  state: WrackState;
  readonly pos: THREE.Vector3;
  readonly quat: THREE.Quaternion;
  readonly body: RAPIER.RigidBody;
  readonly mesh: THREE.Mesh;
  /** Its colliders' segments in its own frame: the long axis is the first, end to end. */
  readonly limbs: { a: THREE.Vector3; b: THREE.Vector3; r: number }[];
  /** Its length along its own X, end to end (m), and how far its underside is below its middle. */
  length: number;
  readonly vel: { x: number; z: number };
  /** Where it lay in the dam. */
  readonly home: { x: number; z: number; yaw: number };
  /** Racking up against the snag: from where, to which slot, how far along (0 to 1). */
  rackT: number;
  from: THREE.Vector3;
  fromQ: THREE.Quaternion;
  slot: number;
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
}

/** The dam, as it lies at the start: offsets from `DAM` (m), heading (radians) and which model. */
const DAM_LAYOUT: { dx: number; dz: number; yaw: number; kind: string }[] = [
  { dx: -0.06, dz: -0.12, yaw: 0.4, kind: 'wrack_stick_0' },
  { dx: 0.02, dz: -0.03, yaw: 1.9, kind: 'propagule' },
  { dx: -0.03, dz: 0.08, yaw: -0.5, kind: 'wrack_stick_1' },
  { dx: 0.06, dz: 0.13, yaw: 1.2, kind: 'propagule' },
  { dx: 0.09, dz: -0.09, yaw: 2.6, kind: 'wrack_stick_1' },
  { dx: -0.1, dz: 0.02, yaw: 1.4, kind: 'wrack_stick_0' },
  { dx: 0.12, dz: 0.04, yaw: -1.1, kind: 'propagule' },
  { dx: -0.02, dz: 0.15, yaw: 0.1, kind: 'wrack_stick_0' },
];
/** Where each racked piece stands along the snag (m from its middle, toward its foot positive): from the lava knob's tip out across the channel, as they come. */
const SLOTS = [0.02, -0.03, -0.08, -0.13, -0.18, -0.23, -0.28, -0.33];

/**
 * The drift wrack: a tangle of dead mangrove twigs and old propagules dammed in the creek's mouth,
 * holding the log's pool back (`CREEK_FLOW.open`, the share cleared). The lizard shoves the pieces
 * loose by swimming or wading into them; loose in the creek or the channel, the current rolls them
 * along the bed, and in the channel they catch on the drowned snag above the narrows and rack up
 * against it, standing up off the bed, pinned downstream, until their tops are awash: a spur out
 * from the east bank that catches a log's leading end.
 * Each piece is a kinematic body moved here (the lizard walks through them; the log doesn't).
 */
export class Wrack {
  readonly pieces: WrackPiece[] = [];
  /** Whether the dam's all gone, every piece loose, so the creek runs. */
  get cleared(): boolean {
    return CREEK_FLOW.open >= 1;
  }
  /** Pieces racked on the snag so far. */
  racked = 0;
  onRacked: ((count: number) => void) | null = null;
  onCleared: (() => void) | null = null;
  private feet = new THREE.Vector3();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private p = new THREE.Vector3();
  private cur = { x: 0, z: 0 };

  constructor(
    world: RAPIER.World,
    kit: { geometry: Map<string, THREE.BufferGeometry>; extras: Map<string, Record<string, unknown>> },
    material: THREE.Material,
    scene: THREE.Scene,
    private player: PlayerController,
  ) {
    // The snag: the old trunk drowned across the channel on its bar, solid.
    const trunk = new THREE.Mesh(kit.geometry.get('drowned_trunk')!, material);
    trunk.name = 'drowned-trunk';
    const snagQ = new THREE.Quaternion().setFromAxisAngle(Y, -SNAG.heading);
    const snagAt = new THREE.Vector3(SNAG.x, WATER_Y - SNAG.depth - 0.01, SNAG.z);
    trunk.position.copy(snagAt);
    trunk.quaternion.copy(snagQ);
    trunk.receiveShadow = true;
    scene.add(trunk);
    const snag = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(snagAt.x, snagAt.y, snagAt.z).setRotation(snagQ));
    for (const s of kit.extras.get('drowned_trunk')!.segments as number[][]) {
      const a = new THREE.Vector3(s[0], s[1], s[2]);
      const b = new THREE.Vector3(s[3], s[4], s[5]);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const q = new THREE.Quaternion().setFromUnitVectors(Y, b.clone().sub(a).normalize());
      world.createCollider(RAPIER.ColliderDesc.capsule(a.distanceTo(b) / 2, s[6]).setTranslation(mid.x, mid.y, mid.z).setRotation(q), snag);
    }
    // Only the log is held up by them, not the lizard.
    const groups = (0xffff << 16) | (0xffff & ~PLAYER_GROUP);
    for (const spot of DAM_LAYOUT) {
      const geometry = kit.geometry.get(spot.kind)!;
      // A propagule stands up along Y: lay it along X like the twigs.
      const segments = (kit.extras.get(spot.kind)?.segments as number[][] | undefined) ?? [[0, 0.004, 0, 0, 0.13, 0, 0.0055]];
      const g = spot.kind === 'propagule' ? geometry.clone().rotateZ(-Math.PI / 2).translate(-0.065, 0, 0) : geometry;
      const limbs = segments.map((s) => {
        const a = new THREE.Vector3(s[0], s[1], s[2]);
        const b = new THREE.Vector3(s[3], s[4], s[5]);
        if (spot.kind === 'propagule') {
          a.set(a.y - 0.065, -a.x, a.z);
          b.set(b.y - 0.065, -b.x, b.z);
        }
        return { a, b, r: s[6] };
      });
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      for (const l of limbs) {
        const mid = l.a.clone().add(l.b).multiplyScalar(0.5);
        const q = new THREE.Quaternion().setFromUnitVectors(Y, l.b.clone().sub(l.a).normalize());
        world.createCollider(
          RAPIER.ColliderDesc.capsule(l.a.distanceTo(l.b) / 2, l.r)
            .setTranslation(mid.x, mid.y, mid.z)
            .setRotation(q)
            .setCollisionGroups(groups)
            .setSolverGroups(groups)
            // Wet and smooth: a log pressed against the rack slides along it.
            .setFriction(0)
            .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min),
          body,
        );
      }
      const mesh = new THREE.Mesh(g, material);
      mesh.castShadow = true;
      mesh.name = `wrack-${this.pieces.length}`;
      scene.add(mesh);
      let x0 = Infinity;
      let x1 = -Infinity;
      for (const l of limbs) {
        x0 = Math.min(x0, l.a.x, l.b.x);
        x1 = Math.max(x1, l.a.x, l.b.x);
      }
      this.pieces.push({
        kind: spot.kind,
        state: 'dam',
        pos: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        body,
        mesh,
        limbs,
        length: x1 - x0,
        vel: { x: 0, z: 0 },
        home: { x: DAM.x + spot.dx, z: DAM.z + spot.dz, yaw: spot.yaw },
        rackT: 0,
        from: new THREE.Vector3(),
        fromQ: new THREE.Quaternion(),
        slot: -1,
        prevPos: new THREE.Vector3(),
        prevQuat: new THREE.Quaternion(),
      });
    }
    this.reset();
  }

  /** Back in the creek's mouth, damming it, as at the start. */
  reset() {
    this.racked = 0;
    for (const w of this.pieces) {
      w.state = 'dam';
      w.vel.x = w.vel.z = 0;
      w.slot = -1;
      this.pile(w, this.pieces.indexOf(w));
      w.prevPos.copy(w.pos);
      w.prevQuat.copy(w.quat);
      w.body.setTranslation(w.pos, true);
      w.body.setRotation(w.quat, true);
    }
    CREEK_FLOW.open = 0;
  }

  /** Every piece racked on the snag at once (tests). */
  rackAll() {
    for (const w of this.pieces) if (w.state !== 'racked') this.startRack(w);
    for (const w of this.pieces) this.place(w, 1);
    CREEK_FLOW.open = 1;
  }

  /**
   * Stand a piece in the dam: jammed in the tangle on end, leaning upstream or down, one way and the
   * other piece to piece, its top up at the surface or just out of it.
   */
  private pile(w: WrackPiece, i: number) {
    const jitter = ((i * 37) % 7) / 7 - 0.5;
    const lean = DAM_LEAN + jitter * 0.3;
    const side = i % 2 === 0 ? 1 : -1;
    const up = new THREE.Vector3(side * Math.sin(lean) * Math.cos(w.home.yaw), Math.cos(lean), Math.sin(lean) * Math.sin(w.home.yaw)).normalize();
    w.quat.setFromUnitVectors(X, up);
    const top = WATER_Y + 0.006 + jitter * 0.012;
    w.pos.set(w.home.x, top, w.home.z).addScaledVector(up, -w.length / 2);
  }

  /** Lay a piece on the bed at (x, z), along `yaw`, a little rolled so it isn't level. */
  private lay(w: WrackPiece, x: number, z: number, yaw: number) {
    w.pos.set(x, terrainHeight(x, z) + 0.008, z);
    w.quat.setFromAxisAngle(Y, -yaw);
  }

  step(dt: number, pushing: boolean) {
    this.player.feetAt(1, this.feet);
    const fx = Math.sin(this.player.yaw);
    const fz = Math.cos(this.player.yaw);
    let loose = 0;
    for (const w of this.pieces) {
      w.prevPos.copy(w.pos);
      w.prevQuat.copy(w.quat);
      if (w.state === 'racked') {
        loose++;
        continue;
      }
      if (w.state === 'racking') {
        loose++;
        w.rackT = Math.min(1, w.rackT + dt / RACK_TIME);
        this.place(w, w.rackT);
        continue;
      }
      // A shove from the lizard's snout.
      if (pushing && this.touching(w, fx, fz)) {
        const along = w.vel.x * fx + w.vel.z * fz;
        const gain = Math.max(0, PUSH_SPEED - along) * Math.min(1, PUSH_GRIP * dt);
        w.vel.x += fx * gain;
        w.vel.z += fz * gain;
      }
      // The current along the bed, or the still water.
      current(w.pos.x, w.pos.z, this.cur);
      if (w.state === 'loose' && (this.cur.x !== 0 || this.cur.z !== 0)) {
        const k = Math.min(1, 2 * dt);
        w.vel.x += (this.cur.x * BED_SHARE - w.vel.x) * k;
        w.vel.z += (this.cur.z * BED_SHARE - w.vel.z) * k;
      } else {
        const d = Math.exp(-DRAG * dt);
        w.vel.x *= d;
        w.vel.z *= d;
      }
      const nx = w.pos.x + w.vel.x * dt;
      const nz = w.pos.z + w.vel.z * dt;
      // Standing in the dam until it's shoved; then it topples onto the bed. Only along the bed under
      // water: it stops against a bank.
      if (w.state === 'dam' && Math.hypot(w.vel.x, w.vel.z) < 1e-4) {
        // Still in the tangle.
      } else if (depthAt(nx, nz) > 0.02) {
        // Tumbling a little as it goes.
        const yaw = w.state === 'dam' ? w.home.yaw : -2 * Math.atan2(w.quat.y, w.quat.w) + Math.hypot(w.vel.x, w.vel.z) * dt * 3;
        this.lay(w, nx, nz, yaw);
      } else {
        w.vel.x *= -0.2;
        w.vel.z *= -0.2;
      }
      // Knocked out of the tangle, it's loose.
      if (w.state === 'dam' && Math.hypot(w.vel.x, w.vel.z) >= 1e-4) w.state = 'loose';
      if (w.state !== 'dam') loose++;
      // On the snag: it catches and racks up.
      if (w.state === 'loose' && inChannel(w.pos.x, w.pos.z) && this.toSnag(w.pos.x, w.pos.z) < CATCH) this.startRack(w);
      w.body.setNextKinematicTranslation(w.pos);
      w.body.setNextKinematicRotation(w.quat);
    }
    const open = loose / this.pieces.length;
    if (open === 1 && CREEK_FLOW.open < 1) this.onCleared?.();
    CREEK_FLOW.open = open;
  }

  /** Distance (m) from (x, z) to the snag's line, seen from above. */
  private toSnag(x: number, z: number): number {
    const sx = Math.cos(SNAG.heading);
    const sz = Math.sin(SNAG.heading);
    const t = Math.max(-SNAG.half, Math.min(SNAG.half, (x - SNAG.x) * sx + (z - SNAG.z) * sz));
    return Math.hypot(x - SNAG.x - sx * t, z - SNAG.z - sz * t);
  }

  /** Catch on the snag: the next free slot along it, and it stands up there. */
  private startRack(w: WrackPiece) {
    w.state = 'racking';
    w.rackT = 0;
    w.slot = this.racked++;
    w.from.copy(w.pos);
    w.fromQ.copy(w.quat);
    this.onRacked?.(this.racked);
  }

  /** A racking piece `t` of the way (0 to 1) from where it caught to its slot: standing up off the bed, leaning downstream against the snag, its top at the rack's top. */
  private place(w: WrackPiece, t: number) {
    const sx = Math.cos(SNAG.heading);
    const sz = Math.sin(SNAG.heading);
    const k = SLOTS[w.slot % SLOTS.length];
    // Upstream of the snag's line (north), a little out of line piece to piece.
    const jitter = ((w.slot * 37) % 7) / 7 - 0.5;
    const x = SNAG.x + sx * k + sz * 0.035 + jitter * 0.01;
    const z = SNAG.z + sz * k - sx * 0.035;
    const top = WATER_Y - RACK_TOP + jitter * 0.012;
    // Its own X stands up, leaning downstream (south, across the snag) and along it, one way and the
    // other piece to piece, so they cross like a rack rather than standing in a row.
    const along = (w.slot % 2 === 0 ? 1 : -1) * (0.5 + jitter * 0.3);
    const up = new THREE.Vector3(-sz * Math.sin(LEAN), Math.cos(LEAN), sx * Math.sin(LEAN)).add(new THREE.Vector3(sx, 0, sz).multiplyScalar(along)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(X, up);
    const mid = new THREE.Vector3(x, top, z).addScaledVector(up, -w.length / 2);
    const s = t * t * (3 - 2 * t);
    w.pos.lerpVectors(w.from, mid, s);
    w.quat.slerpQuaternions(w.fromQ, q, s);
    if (t >= 1) w.state = 'racked';
    w.body.setNextKinematicTranslation(w.pos);
    w.body.setNextKinematicRotation(w.quat);
    if (t >= 1 && w.rackT >= 1) {
      w.body.setTranslation(w.pos, true);
      w.body.setRotation(w.quat, true);
    }
  }

  /**
   * Whether a log limb from `a` to `b` (radius `r`, world) touches a racked piece's upper half, where
   * the twigs' forks stand up out of the tangle: the point on the piece it hooks on into `out`.
   */
  hooks(a: THREE.Vector3, b: THREE.Vector3, r: number, out: THREE.Vector3): boolean {
    for (const w of this.pieces) {
      if (w.state !== 'racked') continue;
      const l = w.limbs[0];
      this.a.copy(l.a).applyQuaternion(w.quat).add(w.pos);
      this.b.copy(l.b).applyQuaternion(w.quat).add(w.pos);
      if (this.a.y > this.b.y) this.a.lerp(this.b, 0.5);
      else this.b.lerp(this.a, 0.5);
      if (segmentDistance(a, b, this.a, this.b, this.p, out) < r + l.r + HOOK_GAP) return true;
    }
    return false;
  }

  /** Whether the lizard's snout is against a piece. */
  private touching(w: WrackPiece, fx: number, fz: number): boolean {
    const sx = this.feet.x + fx * SNOUT;
    const sz = this.feet.z + fz * SNOUT;
    const sy = this.player.position.y;
    for (const l of w.limbs) {
      this.a.copy(l.a).applyQuaternion(w.quat).add(w.pos);
      this.b.copy(l.b).applyQuaternion(w.quat).add(w.pos);
      if (Math.abs(sy - (this.a.y + this.b.y) / 2) > REACH) continue;
      const ex = this.b.x - this.a.x;
      const ez = this.b.z - this.a.z;
      const t = Math.max(0, Math.min(1, ((sx - this.a.x) * ex + (sz - this.a.z) * ez) / (ex * ex + ez * ez || 1)));
      this.p.set(this.a.x + ex * t, 0, this.a.z + ez * t);
      if (Math.hypot(sx - this.p.x, sz - this.p.z) < l.r + PUSH_GAP) return true;
    }
    return false;
  }

  /** The drawn pieces, between the last two physics steps. */
  update(alpha: number) {
    for (const w of this.pieces) {
      w.mesh.position.lerpVectors(w.prevPos, w.pos, alpha);
      w.mesh.quaternion.slerpQuaternions(w.prevQuat, w.quat, alpha);
    }
  }
}

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const d1 = new THREE.Vector3();
const d2 = new THREE.Vector3();
const rr = new THREE.Vector3();

/** Closest distance between segments p1-q1 and p2-q2, with the closest points on each into c1 and c2. */
function segmentDistance(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3, c1: THREE.Vector3, c2: THREE.Vector3): number {
  d1.subVectors(q1, p1);
  d2.subVectors(q2, p2);
  rr.subVectors(p1, p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(rr);
  const c = d1.dot(rr);
  const b = d1.dot(d2);
  const den = a * e - b * b;
  let s = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
  let t = (b * s + f) / e;
  if (t < 0) {
    t = 0;
    s = Math.max(0, Math.min(1, -c / a));
  } else if (t > 1) {
    t = 1;
    s = Math.max(0, Math.min(1, (b - c) / a));
  }
  c1.copy(p1).addScaledVector(d1, s);
  c2.copy(p2).addScaledVector(d2, t);
  return c1.distanceTo(c2);
}
