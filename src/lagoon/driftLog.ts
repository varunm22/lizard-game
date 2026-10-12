import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import type { PlayerController } from '../player/controller';
import { WATER_Y } from '../world/shore';
import { terrainHeight } from '../world/terrain';
import { channelX, CREEK, current, inChannel, JAM, JAM_Z, LOG_POOL } from './layout';

/** The log: half its length and its radius (m). It floats with its middle this far under the surface. */
const HALF = 0.475;
const RADIUS = 0.04;
const FLOAT = 0.005;
/** It needs this much water under its middle line to float (m): its draft, with a little to spare. */
const DRAFT = RADIUS - FLOAT + 0.004;
/** Swum into from behind, it's shoved along at this speed (m/s), slower than the lizard swims. */
const PUSH = 0.1;
/** The lizard's snout is this far ahead of its middle (m); it shoves within this gap of the log's side, from at most this far under it. */
const SNOUT = 0.08;
const PUSH_GAP = 0.025;
const PUSH_BELOW = 0.2;
/** How quickly it picks up a push or the current, and how quickly the water stills it (per second). */
const PUSH_GRIP = 4;
const CURRENT_GRIP = 1.2;
const DRAG = 0.8;
const SPIN_DRAG = 2.5;
/** How much a shove off its middle turns it (radians per second per metre off the middle). */
const SPIN_GAIN = 2.2;
/** How hard a current swings it to lie along the flow. */
const ALIGN = 1.2;
/** Within this far (m) of the narrows, in the channel, it catches on the snags and swings across. */
const JAM_REACH = 0.4;
const JAM_TIME = 1.6;
/** Swept further south than this (m), it's gone out to sea; another washes into the pool. */
const LOST_Z = -5.4;

export type LogState = 'float' | 'jamming' | 'jammed';

/**
 * The driftwood log in the pool behind the channel's fringe: the lagoon's gate. It floats, so a
 * lizard far too small to shift it on land can shove it along by swimming into it, turning it by
 * pushing off its middle. Out of the pool through the creek, the channel's ebb takes it south, and
 * at the narrows it catches on the snags either side, swings across and settles there with its ends
 * on the banks: a bridge to the lava field. It's a kinematic body moved here at the fixed rate, so it
 * stops dead against roots, rocks and the bed rather than tunnelling, and a lizard standing on it is
 * carried along. Scripted, not simulated: the fall into place is a fixed, tested settle.
 */
export class DriftLog {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly mesh: THREE.Mesh;
  state: LogState = 'float';
  /** Middle (m), heading of its long axis (radians: (cos a, sin a) in x and z) and drift. */
  readonly pos = new THREE.Vector3();
  heading = 0;
  readonly vel = { x: 0, z: 0 };
  spin = 0;
  /** Seconds swung toward the jam, and the pose it settles into. */
  private jamT = 0;
  private jamFrom = { x: 0, y: 0, z: 0, q: new THREE.Quaternion() };
  private jamTo = { x: 0, y: 0, z: 0, q: new THREE.Quaternion() };
  readonly quat = new THREE.Quaternion();
  private prevPos = new THREE.Vector3();
  private prevQuat = new THREE.Quaternion();
  /** Counts for tests and goals: shoves, times it reached the channel, lost out to sea. */
  pushes = 0;
  inChannel = false;
  private wasInChannel = false;
  reachedChannel = 0;
  lost = 0;
  /** Seconds the lizard has ridden it while it moved. */
  ridden = 0;
  /** Whether the lizard is standing on it this step. */
  rider = false;
  onJammed: (() => void) | null = null;
  onLost: (() => void) | null = null;
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private shape: RAPIER.Shape;
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private feet = new THREE.Vector3();
  private cur = { x: 0, z: 0 };
  private only: (c: RAPIER.Collider) => boolean;

  constructor(
    private world: RAPIER.World,
    geometry: THREE.BufferGeometry,
    extras: { radius: number; length: number },
    material: THREE.Material,
    private player: PlayerController,
  ) {
    // The prop log lies along X with its underside at y = 0: centre it and size it.
    const g = geometry.clone().translate(0, -extras.radius, 0);
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.scale.set((2 * HALF) / extras.length, RADIUS / extras.radius, RADIUS / extras.radius);
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.name = 'drift-log';
    // A 14-sided prism with a flat face on top, as the island's logs.
    const prism = new THREE.CylinderGeometry(RADIUS, RADIUS, 2 * HALF, 14).rotateZ(Math.PI / 2);
    const points = new Float32Array(prism.getAttribute('position').array);
    prism.dispose();
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    this.collider = world.createCollider(RAPIER.ColliderDesc.convexHull(points)!.setFriction(1), this.body);
    this.shape = new RAPIER.ConvexPolyhedron(points.map((p) => p * 0.96), null);
    this.only = (c) => c.handle !== this.collider.handle;
    this.reset();
  }

  /** Back floating in its pool, as at the start. */
  reset() {
    this.state = 'float';
    this.place(LOG_POOL.x - 0.2, LOG_POOL.z + 0.15, 0.2);
  }

  /** Put it floating at (x, z) along `heading` (tests). */
  place(x: number, z: number, heading: number) {
    this.state = 'float';
    this.wasInChannel = false;
    this.pos.set(x, WATER_Y - FLOAT, z);
    this.heading = heading;
    this.vel.x = this.vel.z = this.spin = 0;
    this.jamT = 0;
    this.quat.setFromAxisAngle(UP, -heading);
    this.body.setTranslation(this.pos, true);
    this.body.setRotation(this.quat, true);
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
  }

  /** One end of it (sign ±1), at the middle line. */
  end(sign: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(HALF * sign, 0, 0).applyQuaternion(this.quat).add(this.pos);
  }

  /** Whether the log could lie at (x, z) along `heading`: enough water under it and nothing in the way. */
  private fits(x: number, z: number, heading: number): boolean {
    const cx = Math.cos(heading);
    const cz = Math.sin(heading);
    for (const t of [-1, -0.5, 0, 0.5, 1]) {
      const px = x + cx * HALF * t;
      const pz = z + cz * HALF * t;
      if (WATER_Y - FLOAT - terrainHeight(px, pz) < DRAFT) return false;
    }
    this.q.setFromAxisAngle(UP, -heading);
    let hit = false;
    this.world.intersectionsWithShape({ x, y: WATER_Y - FLOAT, z }, this.q, this.shape, (c) => {
      if (c.parent()?.handle === this.player.body.handle || c.shape.type === RAPIER.ShapeType.HeightField) return true;
      hit = true;
      return false;
    }, undefined, undefined, this.collider, this.body, this.only);
    return !hit;
  }

  /**
   * One physics step, before the world steps: shoved if the lizard is swimming forward into it, the
   * current, drag, then moved as far as it fits; the jam; then the lizard carried if it stands on it.
   */
  step(dt: number, pushing: boolean) {
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    if (this.state === 'jammed') {
      this.carryRider(dt);
      return;
    }
    if (this.state === 'jamming') {
      this.jamT = Math.min(1, this.jamT + dt / JAM_TIME);
      const t = this.jamT * this.jamT * (3 - 2 * this.jamT);
      this.pos.set(
        this.jamFrom.x + (this.jamTo.x - this.jamFrom.x) * t,
        this.jamFrom.y + (this.jamTo.y - this.jamFrom.y) * t,
        this.jamFrom.z + (this.jamTo.z - this.jamFrom.z) * t,
      );
      this.quat.slerpQuaternions(this.jamFrom.q, this.jamTo.q, t);
      if (this.jamT >= 1) {
        this.state = 'jammed';
        this.onJammed?.();
      }
      this.move();
      return;
    }
    // A shove from the lizard swimming forward into it.
    if (pushing && this.touching()) {
      const fx = Math.sin(this.player.yaw);
      const fz = Math.cos(this.player.yaw);
      const along = this.vel.x * fx + this.vel.z * fz;
      const gain = Math.max(0, PUSH - along) * Math.min(1, PUSH_GRIP * dt);
      this.vel.x += fx * gain;
      this.vel.z += fz * gain;
      // Off its middle, the shove turns it.
      this.player.feetAt(1, this.feet);
      const ox = this.feet.x + fx * SNOUT - this.pos.x;
      const oz = this.feet.z + fz * SNOUT - this.pos.z;
      this.spin += (ox * fz - oz * fx) * SPIN_GAIN * gain * 1.5;
      this.pushes++;
    }
    // The water under it: the mean current along it carries it, and a difference between its ends
    // (one end out in the channel's ebb, the other still in the creek) turns it.
    const ax = Math.cos(this.heading);
    const az = Math.sin(this.heading);
    let cx = 0;
    let cz = 0;
    let turn = 0;
    for (const t of [-0.8, 0, 0.8]) {
      current(this.pos.x + ax * HALF * t, this.pos.z + az * HALF * t, this.cur);
      cx += this.cur.x / 3;
      cz += this.cur.z / 3;
      turn += Math.sign(t) * (-this.cur.x * az + this.cur.z * ax);
    }
    turn /= 2 * HALF * 0.8;
    this.inChannel = inChannel(this.pos.x, this.pos.z);
    if (this.inChannel || cx !== 0 || cz !== 0) {
      const k = Math.min(1, CURRENT_GRIP * dt);
      this.vel.x += (cx - this.vel.x) * k;
      this.vel.z += (cz - this.vel.z) * k;
      this.spin += (turn - this.spin) * k;
      // Out in the channel it swings round to lie along the flow, and drifts out to the fast water mid-channel.
      if (this.inChannel) {
        this.spin += Math.sin(2 * (Math.PI / 2 - this.heading)) * ALIGN * dt;
        this.vel.x += (channelX(this.pos.z) - this.pos.x) * 0.6 * dt;
      }
      // The creek's banks steer it to the middle.
      else this.vel.z += (CREEK.z - this.pos.z) * 0.8 * dt;
    } else {
      const d = Math.exp(-DRAG * dt);
      this.vel.x *= d;
      this.vel.z *= d;
    }
    this.spin *= Math.exp(-SPIN_DRAG * dt);
    // Move as far as it fits: all of it, or just the drift, or just the turn.
    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    const nh = this.heading + this.spin * dt;
    if (this.fits(nx, nz, nh)) {
      this.pos.x = nx;
      this.pos.z = nz;
      this.heading = nh;
    } else if (this.fits(nx, nz, this.heading)) {
      this.pos.x = nx;
      this.pos.z = nz;
      this.spin *= -0.3;
    } else if (this.fits(this.pos.x, this.pos.z, nh)) {
      this.heading = nh;
      this.vel.x *= -0.2;
      this.vel.z *= -0.2;
    } else {
      this.vel.x *= -0.2;
      this.vel.z *= -0.2;
      this.spin *= -0.3;
    }
    this.quat.setFromAxisAngle(UP, -this.heading);
    if (this.inChannel) {
      if (!this.wasInChannel) this.reachedChannel++;
      if (Math.abs(this.pos.z - JAM_Z) < JAM_REACH) this.startJam();
    }
    this.wasInChannel = this.inChannel;
    if (this.pos.z < LOST_Z) {
      this.lost++;
      this.reset();
      this.onLost?.();
    }
    this.move();
  }

  /** Swing across the narrows: from where it is to lying with its ends on the two banks. */
  private startJam() {
    this.state = 'jamming';
    this.jamT = 0;
    this.vel.x = this.vel.z = this.spin = 0;
    this.jamFrom = { x: this.pos.x, y: this.pos.y, z: this.pos.z, q: this.quat.clone() };
    const west = new THREE.Vector3(JAM.x - HALF, 0, JAM.z);
    const east = new THREE.Vector3(JAM.x + HALF, 0, JAM.z);
    const ground = (x: number, z: number) => Math.max(...[-0.06, -0.02, 0.02].map((d) => terrainHeight(x + d * Math.sign(x - JAM.x), z)));
    // Each end settles half into the mud or a crack in the lava, its top a step up from the bank,
    // so the lizard walks on and off it rather than climbing.
    west.y = ground(west.x, west.z) - RADIUS * 0.5;
    east.y = ground(east.x, east.z) - RADIUS * 0.5;
    const dir = east.clone().sub(west).normalize();
    // Keep whichever end was upstream on the side it swings to, so it turns the short way.
    const q = new THREE.Quaternion().setFromUnitVectors(X, dir);
    const flipped = new THREE.Quaternion().setFromUnitVectors(X, dir.clone().negate());
    const pick = this.quat.angleTo(q) <= this.quat.angleTo(flipped) ? q : flipped;
    const mid = west.clone().add(east).multiplyScalar(0.5);
    this.jamTo = { x: mid.x, y: mid.y, z: mid.z, q: pick };
  }

  /**
   * Whether the lizard's snout is up against it: within a couple of centimetres of its side, seen
   * from above, and no deeper under it than a swimming lizard sinks while it pushes (it sinks slowly
   * unless it tilts up, and a shove from just below moves a floating log as well).
   */
  private touching(): boolean {
    const fx = Math.sin(this.player.yaw);
    const fz = Math.cos(this.player.yaw);
    const p = this.player.position;
    if (p.y < this.pos.y - RADIUS - PUSH_BELOW || p.y > this.pos.y + RADIUS) return false;
    const sx = p.x + fx * SNOUT - this.pos.x;
    const sz = p.z + fz * SNOUT - this.pos.z;
    const ax = Math.cos(this.heading);
    const az = Math.sin(this.heading);
    const along = Math.max(-HALF, Math.min(HALF, sx * ax + sz * az));
    return Math.hypot(sx - ax * along, sz - az * along) < RADIUS + PUSH_GAP;
  }

  /** Set the body's next pose, and carry a lizard standing on it. */
  private move() {
    this.body.setNextKinematicTranslation(this.pos);
    this.body.setNextKinematicRotation(this.quat);
    this.carryRider(0);
  }

  private carryRider(dt: number) {
    const p = this.player.position;
    this.ray.origin = { x: p.x, y: p.y, z: p.z };
    const hit = this.player.swimming ? null : this.world.castRay(this.ray, 0.045, true, undefined, undefined, undefined, this.player.body, (c) => c.handle === this.collider.handle);
    this.rider = hit !== null;
    if (!this.rider) return;
    // The lizard rides the log's own move: turned about the log's middle and moved with it.
    const dq = this.q.copy(this.quat).multiply(this.prevQuat.clone().invert());
    this.v.set(p.x, p.y, p.z).sub(this.prevPos).applyQuaternion(dq).add(this.pos);
    const dx = this.v.x - p.x;
    const dy = this.v.y - p.y;
    const dz = this.v.z - p.z;
    const fwd = new THREE.Vector3(Math.sin(this.player.yaw), 0, Math.cos(this.player.yaw)).applyQuaternion(dq);
    const dyaw = Math.atan2(fwd.x, fwd.z) - this.player.yaw;
    if (Math.abs(dx) + Math.abs(dz) + Math.abs(dyaw) > 1e-6) {
      this.player.carry(dx, dy, dz, Math.atan2(Math.sin(dyaw), Math.cos(dyaw)));
      this.ridden += dt > 0 ? dt : 1 / 60;
    }
  }

  /** The drawn log, between the last two physics steps. */
  update(alpha: number) {
    this.mesh.position.lerpVectors(this.prevPos, this.pos, alpha);
    this.mesh.quaternion.slerpQuaternions(this.prevQuat, this.quat, alpha);
  }

  /** Its speed through the water now (m/s). */
  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
