import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import type { PlayerController } from '../player/controller';
import { WATER_Y } from '../world/shore';
import { PLAYER_GROUP } from '../world/terrain';
import { acrossChannel, current, eastEdge, inChannel, LOG_POOL, LOG_START } from './layout';

/** Densities (kg/m³): the bleached limb, its waterlogged prop-root keel, and the water. */
const WOOD = 330;
const KEEL_WOOD = 1400;
const WATER = 1000;
/** Water drag on each bit of it: a linear part and a quadratic part (per m² of its side). */
const DRAG_LINEAR = 30;
const DRAG_QUADRATIC = 600;
/** Samples per collider for buoyancy and drag. */
const SAMPLES = 3;
/**
 * The lizard's weight standing on it (N): a 0.1 kg lizard, made several times heavier because a
 * game log that a lizard can roll has to be a lot lighter than a real one. Out on a branch it
 * rolls the limb, a round trunk having almost nothing to right it.
 */
const RIDER_WEIGHT = 4;
/** Swum into from behind, it's shoved along up to this speed (m/s), with this force (N). */
const PUSH_SPEED = 0.1;
const PUSH_FORCE = 0.9;
/** The lizard's snout is this far ahead of its middle (m); it shoves within this gap of a limb, seen from above. */
const SNOUT = 0.08;
const PUSH_GAP = 0.03;
/** It reaches a limb this far above or below its middle (m). */
const PUSH_REACH = 0.06;
/**
 * Settled this long (s) lying across the channel, its ends within this far of the west bank
 * and the lava face (`acrossChannel`, `eastEdge`), it's wedged for good.
 */
const WEDGE_TIME = 1.2;
const WEDGE_SPEED = 0.012;
const WEDGE_GAP = 0.35;
/** How far its origin floats below the water (m), about: where it's placed. */
const FLOAT_DRAFT = 0.005;
/** Shoved this long (s) in all, its keel root works loose of the mud it's stuck in. */
const WORK_LOOSE = 0.4;
/** Within this (m) of something, it's touching it: the solver holds a floating limb off a little. */
const CONTACT = 0.02;
/** Swept further south than this (m), it's gone out to sea; another washes into the pool. */
const LOST_Z = -5.4;

export type LogState = 'aground' | 'float' | 'jammed';

/** One collider of the limb, in its own frame. */
interface Limb {
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
  keel: boolean;
}

/**
 * The driftwood in the pool behind the channel's fringe: the lagoon's gate. A forked red mangrove
 * limb, bleached and barkless, with an arching prop-root stub near its butt, waterlogged and heavy,
 * that hangs under it as a keel. It's a real floating body: Rapier moves it, and each step this adds
 * buoyancy, the water's drag (toward the current where there is one), the lizard's weight where it
 * stands on it and its shove where it swims into it. So it drifts, bumps, grounds and snags on its
 * own: aground on its keel where the water is shallow, it's freed by standing out on the fork, which
 * rolls the keel up; standing on the far side dips the keel deeper. The lizard never touches it
 * through the solver (`PLAYER_GROUP` is out of its solver groups), only through those forces, and
 * rides it by following its pose. Lying across the narrows, settled against both banks, it's
 * wedged: from then on it's fixed, a bridge to the lava field.
 */
export class DriftLog {
  readonly body: RAPIER.RigidBody;
  readonly colliders: RAPIER.Collider[] = [];
  readonly mesh: THREE.Mesh;
  state: LogState = 'aground';
  /** Its pose now, and one step ago for drawing between steps. */
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  private prevPos = new THREE.Vector3();
  private prevQuat = new THREE.Quaternion();
  private limbs: Limb[] = [];
  /** The main limb's two ends, in its own frame. */
  private ends: [THREE.Vector3, THREE.Vector3];
  /** The main limb's joints, butt to tip, in its own frame. */
  private spinePoints: THREE.Vector3[];
  private handles = new Set<number>();
  /** Counts for tests and goals: shoves, times it reached the channel, lost out to sea. */
  pushes = 0;
  inChannel = false;
  private wasInChannel = false;
  reachedChannel = 0;
  lost = 0;
  /** Seconds the lizard has ridden it while it moved. */
  ridden = 0;
  /** Whether the lizard is standing on it this step, and how far below the water the keel's tip is (m). */
  rider = false;
  keelDepth = 0;
  /** Whether it's touching the bed or anything else solid this step (grounded, snagged). */
  touching = false;
  contacts: { x: number; y: number; z: number; what: string }[] = [];
  private settled = 0;
  /** Seconds it's been shoved while stuck. */
  private worked = 0;
  onJammed: (() => void) | null = null;
  onLost: (() => void) | null = null;
  onAfloat: (() => void) | null = null;
  /** Whether a limb from a to b (radius r) hooks on something, and where (the drift wrack racked on the snag). */
  hooksOn: ((a: THREE.Vector3, b: THREE.Vector3, r: number, out: THREE.Vector3) => boolean) | null = null;
  /** Hooked: a twig fork it's caught on, holding it at one point while the current swings it round. */
  private pin: { joint: RAPIER.ImpulseJoint; anchor: RAPIER.RigidBody } | null = null;
  private hookAt = new THREE.Vector3();
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private p = new THREE.Vector3();
  private v = new THREE.Vector3();
  private feet = new THREE.Vector3();
  private cur = { x: 0, z: 0 };

  constructor(
    private world: RAPIER.World,
    geometry: THREE.BufferGeometry,
    extras: { segments: number[][]; keel: number[] },
    material: THREE.Material,
    private player: PlayerController,
  ) {
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.name = 'drift-log';
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setAngularDamping(0.4).setCcdEnabled(true));
    // Everything but the lizard pushes it back; the lizard only through the forces here.
    const solver = (0xffff << 16) | (0xffff & ~PLAYER_GROUP);
    const keel = new Set(extras.keel);
    extras.segments.forEach((s, i) => {
      const a = new THREE.Vector3(s[0], s[1], s[2]);
      const b = new THREE.Vector3(s[3], s[4], s[5]);
      const r = s[6];
      this.limbs.push({ a, b, r, keel: keel.has(i) });
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const half = a.distanceTo(b) / 2;
      const q = new THREE.Quaternion().setFromUnitVectors(Y, b.clone().sub(a).normalize());
      const c = world.createCollider(
        RAPIER.ColliderDesc.capsule(half, r)
          .setTranslation(mid.x, mid.y, mid.z)
          .setRotation(q)
          .setDensity(keel.has(i) ? KEEL_WOOD : WOOD)
          .setFriction(0.7)
          .setSolverGroups(solver),
        this.body,
      );
      this.colliders.push(c);
      this.handles.add(c.handle);
    });
    // The main limb is the first run of segments, butt to tip, end to end.
    let last = 0;
    while (last + 1 < this.limbs.length && this.limbs[last + 1].a.distanceTo(this.limbs[last].b) < 1e-3) last++;
    this.ends = [this.limbs[0].a.clone(), this.limbs[last].b.clone()];
    this.spinePoints = [this.limbs[0].a.clone(), ...this.limbs.slice(0, last + 1).map((l) => l.b.clone())];
    this.reset();
  }

  /** Whether a collider is part of the log. */
  owns(c: RAPIER.Collider) {
    return this.handles.has(c.handle);
  }

  /** As at the start: in the pool by its rim, its keel root stuck fast in the mud, so it's held still. */
  reset() {
    this.place(LOG_START.x, LOG_START.z, LOG_START.heading, LOG_START.roll);
    this.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
    this.state = 'aground';
    this.pushes = this.reachedChannel = this.lost = 0;
    this.ridden = 0;
  }

  /** Another washed into the pool: floating free in the middle of it. */
  washIn() {
    this.place(LOG_POOL.x - 0.1, LOG_POOL.z - 0.2, 0.3, 0);
    this.state = 'float';
  }

  /** Put it at (x, z), its main limb along `heading` (radians: (cos, sin) in x and z), rolled by `roll`, at rest (tests). */
  place(x: number, z: number, heading: number, roll = 0) {
    this.unpin();
    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.state = 'float';
    this.wasInChannel = false;
    this.settled = 0;
    this.worked = 0;
    this.quat.setFromAxisAngle(Y, -heading).multiply(new THREE.Quaternion().setFromAxisAngle(X, roll));
    this.pos.set(x, WATER_Y - FLOAT_DRAFT, z);
    this.body.setTranslation(this.pos, true);
    this.body.setRotation(this.quat, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
  }

  /** One end of the main limb (sign -1 the butt, 1 the forked tip), in the world. */
  end(sign: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.ends[sign < 0 ? 0 : 1]).applyQuaternion(this.quat).add(this.pos);
  }

  /** The main limb's joints, butt to tip, in the world (its top along them is the way across). */
  spine(): THREE.Vector3[] {
    return this.spinePoints.map((p) => p.clone().applyQuaternion(this.quat).add(this.pos));
  }

  /** A point given in the log's own frame (glTF space, as its `segments`), in the world. */
  toWorld(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(x, y, z).applyQuaternion(this.quat).add(this.pos);
  }

  /** Heading of the main limb, butt to tip (radians, as in `place`). */
  get heading(): number {
    this.end(-1, this.a);
    this.end(1, this.b);
    return Math.atan2(this.b.z - this.a.z, this.b.x - this.a.x);
  }

  /** How far it's rolled (radians): the keel's side (away from the big fork) down is positive. */
  get roll(): number {
    this.v.set(0, 0, 1).applyQuaternion(this.quat);
    return Math.asin(Math.max(-1, Math.min(1, -this.v.y)));
  }

  /**
   * One physics step, before the world steps: buoyancy, drag and the current on every limb, the
   * lizard's weight or shove, then whether it's wedged, lost, or afloat again.
   */
  step(dt: number, pushing: boolean) {
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    if (this.state === 'jammed') {
      this.carryRider(dt);
      return;
    }
    const t = this.body.translation();
    const r = this.body.rotation();
    this.pos.set(t.x, t.y, t.z);
    this.quat.set(r.x, r.y, r.z, r.w);
    const com = this.body.worldCom();
    const lin = this.body.linvel();
    const ang = this.body.angvel();
    const impulse = { x: 0, y: 0, z: 0 };
    const point = { x: 0, y: 0, z: 0 };
    let keelDepth = 0;
    for (const limb of this.limbs) {
      this.a.copy(limb.a).applyQuaternion(this.quat).add(this.pos);
      this.b.copy(limb.b).applyQuaternion(this.quat).add(this.pos);
      const len = this.a.distanceTo(this.b);
      const vol = (Math.PI * limb.r * limb.r * len) / SAMPLES;
      const side = (2 * limb.r * len) / SAMPLES;
      if (limb.keel) keelDepth = Math.max(keelDepth, WATER_Y - Math.min(this.a.y, this.b.y) + limb.r);
      for (let k = 0; k < SAMPLES; k++) {
        this.p.lerpVectors(this.a, this.b, (k + 0.5) / SAMPLES);
        const wet = Math.max(0, Math.min(1, (WATER_Y - this.p.y + limb.r) / (2 * limb.r)));
        if (wet <= 0) continue;
        // The water's velocity there, and this bit's through it.
        current(this.p.x, this.p.z, this.cur);
        const rx = this.p.x - com.x;
        const ry = this.p.y - com.y;
        const rz = this.p.z - com.z;
        const vx = lin.x + ang.y * rz - ang.z * ry - this.cur.x;
        const vy = lin.y + ang.z * rx - ang.x * rz;
        const vz = lin.z + ang.x * ry - ang.y * rx - this.cur.z;
        const speed = Math.hypot(vx, vy, vz);
        const k2 = -(DRAG_LINEAR + DRAG_QUADRATIC * speed) * side * wet * dt;
        impulse.x = vx * k2;
        impulse.y = WATER * 9.81 * vol * wet * dt + vy * k2;
        impulse.z = vz * k2;
        point.x = this.p.x;
        point.y = this.p.y;
        point.z = this.p.z;
        this.body.applyImpulseAtPoint(impulse, point, true);
      }
    }
    this.keelDepth = keelDepth;
    // The lizard: its weight where it stands on it, or its shove where it swims into it.
    this.player.feetAt(1, this.feet);
    this.rider = this.standing();
    if (this.rider) this.body.applyImpulseAtPoint({ x: 0, y: -RIDER_WEIGHT * dt, z: 0 }, this.feet, true);
    else if (pushing && this.shove(dt)) {
      this.pushes++;
      // Stuck by its keel: shoved enough, it works loose.
      if (this.state === 'aground' && (this.worked += dt) >= WORK_LOOSE) {
        this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        this.state = 'float';
        this.onAfloat?.();
      }
    }
    this.carryRider(dt);
    // Touching the bed or anything else: aground, snagged or against a bank. Where, for tests.
    const contacts: { x: number; y: number; z: number; what: string }[] = [];
    for (const c of this.colliders) {
      this.world.contactPairsWith(c, (other) => {
        if (this.handles.has(other.handle) || other.parent()?.handle === this.player.body.handle) return;
        this.world.contactPair(c, other, (m) => {
          if (m.numContacts() === 0 || m.contactDist(0) > CONTACT) return;
          const p = (m.numSolverContacts() > 0 ? m.solverContactPoint(0) : null) ?? c.translation();
          const what = other.shapeType() === RAPIER.ShapeType.HeightField ? 'bed' : other.parent()?.isKinematic() ? 'wrack' : 'solid';
          contacts.push({ x: p.x, y: p.y, z: p.z, what });
        });
      });
    }
    // Caught on a twig of the rack: held there, it swings round on it.
    if (!this.pin && this.hooksOn && this.state === 'float') {
      for (const limb of this.limbs) {
        this.a.copy(limb.a).applyQuaternion(this.quat).add(this.pos);
        this.b.copy(limb.b).applyQuaternion(this.quat).add(this.pos);
        if (this.hooksOn(this.a, this.b, limb.r, this.hookAt)) {
          this.hook(this.hookAt);
          break;
        }
      }
    }
    if (this.pin) contacts.push({ x: this.hookAt.x, y: this.hookAt.y, z: this.hookAt.z, what: this.state === 'aground' ? 'bed' : 'wrack' });
    this.contacts = contacts;
    const touching = contacts.length > 0;
    this.touching = touching;
    this.inChannel = inChannel(this.pos.x, this.pos.z);
    if (this.inChannel && !this.wasInChannel) this.reachedChannel++;
    this.wasInChannel = this.inChannel;
    this.checkWedged(dt, Math.hypot(lin.x, lin.z));
    if (this.pos.z < LOST_Z) {
      this.lost++;
      this.washIn();
      this.onLost?.();
    }
  }

  /** Hook on at a point (world): a ball joint to a fixed anchor there. */
  private hook(at: THREE.Vector3) {
    this.hookAt.copy(at);
    const anchor = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(at.x, at.y, at.z));
    this.v.copy(at).sub(this.pos).applyQuaternion(new THREE.Quaternion().copy(this.quat).invert());
    const joint = this.world.createImpulseJoint(RAPIER.JointData.spherical({ x: this.v.x, y: this.v.y, z: this.v.z }, { x: 0, y: 0, z: 0 }), this.body, anchor, true);
    this.pin = { joint, anchor };
  }

  private unpin() {
    if (!this.pin) return;
    this.world.removeImpulseJoint(this.pin.joint, true);
    this.world.removeRigidBody(this.pin.anchor);
    this.pin = null;
  }

  /** Whether it's hooked on the rack. */
  get hooked(): boolean {
    return this.pin !== null;
  }

  /** Lying across the channel, reaching both banks, touching, and still: wedged for good. */
  private checkWedged(dt: number, speed: number) {
    // Its main limb's ends: one at the west bank's foot, the other at the lava face (or the knob).
    this.end(-1, this.a);
    this.end(1, this.b);
    const ua = acrossChannel(this.a.x, this.a.z);
    const ub = acrossChannel(this.b.x, this.b.z);
    const [w, e] = ua < ub ? [ua, ub] : [ub, ua];
    const ez = ua < ub ? this.b.z : this.a.z;
    const spans = w < WEDGE_GAP - 1 && e > eastEdge(ez) - WEDGE_GAP;
    this.settled = spans && speed < WEDGE_SPEED && this.touching ? this.settled + dt : 0;
    if (this.settled >= WEDGE_TIME) {
      this.state = 'jammed';
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      this.body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
      this.unpin();
      this.onJammed?.();
    }
  }

  /** Whether the lizard is standing on it: the log right under its feet. */
  private standing(): boolean {
    if (this.player.swimming) return false;
    const p = this.player.position;
    this.ray.origin = { x: p.x, y: p.y, z: p.z };
    return this.world.castRay(this.ray, 0.045, true, undefined, undefined, undefined, this.player.body, (c) => this.handles.has(c.handle)) !== null;
  }

  /**
   * Swimming forward with its snout against a limb (within a couple of centimetres of it): shove
   * that limb along the lizard's facing, less the faster it's already going that way.
   */
  private shove(dt: number): boolean {
    const fx = Math.sin(this.player.yaw);
    const fz = Math.cos(this.player.yaw);
    const sx = this.feet.x + fx * SNOUT;
    const sy = this.player.position.y;
    const sz = this.feet.z + fz * SNOUT;
    let best = Infinity;
    for (const limb of this.limbs) {
      this.a.copy(limb.a).applyQuaternion(this.quat).add(this.pos);
      this.b.copy(limb.b).applyQuaternion(this.quat).add(this.pos);
      // Seen from above, within reach up or down: swimming just under it still shoves it.
      const ex = this.b.x - this.a.x;
      const ez = this.b.z - this.a.z;
      const t = Math.max(0, Math.min(1, ((sx - this.a.x) * ex + (sz - this.a.z) * ez) / (ex * ex + ez * ez || 1)));
      this.v.lerpVectors(this.a, this.b, t);
      if (Math.abs(this.v.y - sy) > PUSH_REACH) continue;
      const d = Math.hypot(this.v.x - sx, this.v.z - sz) - limb.r;
      if (d < best) {
        best = d;
        this.p.copy(this.v);
      }
    }
    if (best > PUSH_GAP) return false;
    // Stuck fast, it doesn't give yet.
    if (this.state === 'aground') return true;
    const lin = this.body.linvel();
    const along = lin.x * fx + lin.z * fz;
    const k = (PUSH_FORCE * Math.max(0, PUSH_SPEED - along)) / PUSH_SPEED;
    if (k <= 0) return false;
    this.body.applyImpulseAtPoint({ x: fx * k * dt, y: 0, z: fz * k * dt }, this.p, true);
    return true;
  }

  /** Carry a lizard standing on it with its move since the last step: turned about its middle and moved with it. */
  private carryRider(dt: number) {
    if (this.state === 'jammed') {
      this.rider = this.standing();
      return;
    }
    if (!this.rider) return;
    const p = this.player.position;
    const dq = new THREE.Quaternion().copy(this.quat).multiply(this.prevQuat.clone().invert());
    this.v.set(p.x, p.y, p.z).sub(this.prevPos).applyQuaternion(dq).add(this.pos);
    const dx = this.v.x - p.x;
    const dy = this.v.y - p.y;
    const dz = this.v.z - p.z;
    const fwd = new THREE.Vector3(Math.sin(this.player.yaw), 0, Math.cos(this.player.yaw)).applyQuaternion(dq);
    const dyaw = Math.atan2(fwd.x, fwd.z) - this.player.yaw;
    if (Math.abs(dx) + Math.abs(dz) + Math.abs(dyaw) > 1e-6) {
      this.player.carry(dx, dy, dz, Math.atan2(Math.sin(dyaw), Math.cos(dyaw)));
      if (Math.abs(dx) + Math.abs(dz) > 1e-4) this.ridden += dt;
    }
  }

  /** The drawn log, between the last two physics steps. */
  update(alpha: number) {
    this.mesh.position.lerpVectors(this.prevPos, this.pos, alpha);
    this.mesh.quaternion.slerpQuaternions(this.prevQuat, this.quat, alpha);
  }

  /** Its speed through the water now (m/s). */
  get speed(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.z);
  }
}

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
