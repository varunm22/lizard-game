import * as THREE from 'three';
import type { PlayerController } from '../player/controller';
import { MOVEMENT as M } from '../player/movement';
import { WATER_Y } from '../world/shore';
import { terrainHeight } from '../world/terrain';
import { current, depthAt } from './layout';

/** A propagule's length (m), its base to its tip along the model's Y, and its girth. */
const LENGTH = 0.126;
const RADIUS = 0.0055;
/** Afloat, it lies this far under the surface (m): a red mangrove propagule floats flat at first. */
const FLOAT = 0.002;
/** Shoved, it takes this share of the lizard's speed along the shove, and turns this much (rad/s) per m/s of shove a metre off its middle. */
const CARRY = 1.1;
const SPIN = 60;
/** Slowed by the water (per second), and much faster by the mud (aground). */
const WATER_DRAG = 1.2;
const MUD_DRAG = 10;
const SPIN_DRAG = 4;
/** Afloat, it drifts at this share of the current. */
const DRIFT = 0.9;
/** Knocked over, a seedling stuck upright in the mud takes this long (s) to topple flat. */
const TOPPLE_TIME = 0.35;
/** It can be shoved up a rise of at most this (m) a step: no further up a bank. */
const CLIMB = 0.004;
/** Only those within this far (m) of the lizard are checked for a shove. */
const NEAR = 0.25;
/** Pods out past this square's edge (m) are gone. */
const EDGE = 6;

export interface PodSpot {
  x: number;
  z: number;
  /** Heading of its length, lying flat (radians from +Z toward +X), or for an upright one which way it leans. */
  heading: number;
  upright: boolean;
  /** Upright: its lean and turn as stuck in the mud. */
  rot?: THREE.Quaternion;
}

interface Pod {
  state: 'stuck' | 'toppling' | 'loose';
  /** Its middle, and its heading lying flat. */
  readonly c: THREE.Vector3;
  heading: number;
  readonly vel: { x: number; z: number };
  spin: number;
  /** Stuck upright: its base and pose in the mud; toppling, how far over (0 to 1). */
  readonly base: THREE.Vector3;
  readonly rot: THREE.Quaternion;
  t: number;
  moving: boolean;
}

/**
 * The fallen red mangrove propagules: floating flat in the shallows, lying on the mud and stuck upright
 * where they took root. The lizard shoves them with its body, walking or swimming: one it meets turns
 * and slides along ahead of it (a light one, carried at about its speed), floating ones drift on the
 * current, and an upright one knocked over topples flat and is loose. They're drawn as one
 * InstancedMesh and have no colliders: only the lizard moves them.
 */
export class Pods {
  readonly list: Pod[] = [];
  readonly mesh: THREE.InstancedMesh;
  /** Shoves so far (tests). */
  shoves = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private cur = { x: 0, z: 0 };
  private dirty = true;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    scene: THREE.Scene,
    spots: PodSpot[],
    private player: PlayerController,
  ) {
    for (const s of spots) {
      const pod: Pod = {
        state: s.upright ? 'stuck' : 'loose',
        c: new THREE.Vector3(s.x, 0, s.z),
        heading: s.heading,
        vel: { x: 0, z: 0 },
        spin: 0,
        base: new THREE.Vector3(s.x, terrainHeight(s.x, s.z) - 0.03, s.z),
        rot: s.rot?.clone() ?? new THREE.Quaternion(),
        t: 0,
        moving: false,
      };
      if (!s.upright) pod.c.y = this.restY(s.x, s.z);
      this.list.push(pod);
    }
    this.mesh = new THREE.InstancedMesh(geometry, material, spots.length);
    this.mesh.name = 'propagules';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    this.update();
    this.mesh.computeBoundingSphere();
    // They wander; draw them wherever they get to.
    this.mesh.frustumCulled = false;
  }

  /** Its middle's height lying at (x, z): afloat at the surface, or on the mud. */
  private restY(x: number, z: number): number {
    return Math.max(terrainHeight(x, z) + RADIUS, WATER_Y - FLOAT);
  }

  step(dt: number) {
    const pos = this.player.position;
    const fx = Math.sin(this.player.yaw);
    const fz = Math.cos(this.player.yaw);
    const v = this.player.velocity;
    // The lizard's body seen from above: hips to snout, at the height of its middle.
    const reach = M.bodyHalfLength + M.bodyRadius;
    const hx = pos.x - fx * M.bodyHalfLength;
    const hz = pos.z - fz * M.bodyHalfLength;
    const sx = pos.x + fx * reach;
    const sz = pos.z + fz * reach;
    for (const pod of this.list) {
      if (pod.state === 'toppling') {
        pod.t = Math.min(1, pod.t + dt / TOPPLE_TIME);
        if (pod.t >= 1) {
          pod.state = 'loose';
          pod.c.y = this.restY(pod.c.x, pod.c.z);
        }
        this.dirty = true;
        continue;
      }
      const near = Math.abs(pod.c.x - pos.x) < NEAR && Math.abs(pod.c.z - pos.z) < NEAR;
      if (near) this.shove(pod, hx, hz, sx, sz, pos.y, v);
      if (pod.state !== 'loose') continue;
      // Adrift on the current, or slowing in the water or on the mud.
      const afloat = depthAt(pod.c.x, pod.c.z) > 2 * RADIUS;
      if (afloat) {
        current(pod.c.x, pod.c.z, this.cur);
        const k = 1 - Math.exp(-WATER_DRAG * dt);
        pod.vel.x += (this.cur.x * DRIFT - pod.vel.x) * k;
        pod.vel.z += (this.cur.z * DRIFT - pod.vel.z) * k;
      } else {
        const d = Math.exp(-MUD_DRAG * dt);
        pod.vel.x *= d;
        pod.vel.z *= d;
      }
      pod.spin *= Math.exp(-SPIN_DRAG * dt);
      const speed = Math.hypot(pod.vel.x, pod.vel.z);
      if (speed < 1e-4 && Math.abs(pod.spin) < 1e-3) {
        pod.moving = false;
        continue;
      }
      pod.moving = true;
      const nx = pod.c.x + pod.vel.x * dt;
      const nz = pod.c.z + pod.vel.z * dt;
      const ny = this.restY(nx, nz);
      if (Math.abs(nx) > EDGE || Math.abs(nz) > EDGE || ny - pod.c.y > CLIMB) {
        // Against a bank (or the edge): it stops.
        pod.vel.x = pod.vel.z = 0;
      } else pod.c.set(nx, ny, nz);
      pod.heading += pod.spin * dt;
      this.dirty = true;
    }
  }

  /** The lizard's body (hips h to snout s, its middle at height y, moving at v) meeting a pod: it slides and turns out of the way. */
  private shove(pod: Pod, hx: number, hz: number, sx: number, sz: number, y: number, v: THREE.Vector3) {
    const reach = M.bodyRadius + RADIUS + 0.004;
    if (pod.state === 'stuck') {
      // An upright seedling: its stem, from the mud up.
      if (y < pod.base.y || y > pod.base.y + LENGTH) return;
      const d = pointSegment(pod.base.x, pod.base.z, hx, hz, sx, sz, this.p);
      if (d > reach || Math.hypot(v.x, v.z) < 0.03) return;
      // Knocked over the way the lizard's going: it lands with its middle half its length off.
      const n = Math.hypot(v.x, v.z);
      pod.heading = Math.atan2(v.x, v.z);
      pod.c.set(pod.base.x + (v.x / n) * LENGTH * 0.5, 0, pod.base.z + (v.z / n) * LENGTH * 0.5);
      pod.state = 'toppling';
      pod.t = 0;
      this.shoves++;
      return;
    }
    if (Math.abs(pod.c.y - y) > M.bodyRadius + 0.02) return;
    // Its length, seen from above, against the body's.
    const ax = Math.sin(pod.heading) * LENGTH * 0.5;
    const az = Math.cos(pod.heading) * LENGTH * 0.5;
    const d = segmentSegment(pod.c.x - ax, pod.c.z - az, pod.c.x + ax, pod.c.z + az, hx, hz, sx, sz, this.p);
    if (d >= reach) return;
    // The closest point on the pod (this.p's x and y are its x and z), and on the body (contactBody).
    const px = this.p.x;
    const pz = this.p.y;
    let nx = px - contactBody.x;
    let nz = pz - contactBody.z;
    if (Math.hypot(nx, nz) < 1e-6) {
      nx = v.x;
      nz = v.z;
    }
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    // Out of the body, and carried along as fast as the body comes on.
    const push = reach - d;
    pod.c.x += nx * push;
    pod.c.z += nz * push;
    const along = (v.x * nx + v.z * nz) * CARRY;
    const now = pod.vel.x * nx + pod.vel.z * nz;
    if (along > now) {
      pod.vel.x += nx * (along - now);
      pod.vel.z += nz * (along - now);
      // Met off its middle, it turns.
      const rx = px - pod.c.x;
      const rz = pz - pod.c.z;
      pod.spin += (rz * nx - rx * nz) * (along - now) * SPIN;
      this.shoves++;
    }
    pod.state = 'loose';
    pod.moving = true;
  }

  /** The pods where they lie now. */
  update() {
    if (!this.dirty) return;
    this.dirty = false;
    this.list.forEach((pod, i) => {
      // Lying flat: the model's Y (base to tip) along its heading.
      flatQ(pod.heading, this.q);
      if (pod.state === 'stuck') this.m.compose(pod.base, pod.rot, this.one);
      else if (pod.state === 'toppling') {
        // Falling over about its foot, which comes up out of the mud to lie on it.
        const s = pod.t * pod.t;
        this.q.slerpQuaternions(pod.rot, this.q, s);
        this.p.set(pod.base.x, pod.base.y + (this.restY(pod.c.x, pod.c.z) - pod.base.y) * s, pod.base.z);
        this.m.compose(this.p, this.q, this.one);
      } else {
        this.p.set(0, 1, 0).applyQuaternion(this.q).multiplyScalar(-LENGTH * 0.5).add(pod.c);
        this.m.compose(this.p, this.q, this.one);
      }
      this.mesh.setMatrixAt(i, this.m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Where each one is (tests). */
  get state() {
    return this.list.map((p) => ({ state: p.state, x: p.c.x, y: p.c.y, z: p.c.z, heading: p.heading }));
  }
}

const contactBody = { x: 0, z: 0 };

/** Lying flat with the model's Y along `heading` (from +Z toward +X). */
function flatQ(heading: number, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromUnitVectors(UP, DIR.set(Math.sin(heading), 0, Math.cos(heading)));
}
const UP = new THREE.Vector3(0, 1, 0);
const DIR = new THREE.Vector3();

/** Distance from (x, z) to segment a-b, seen from above. */
function pointSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number, _out: THREE.Vector3): number {
  const ex = bx - ax;
  const ez = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
  return Math.hypot(x - ax - ex * t, z - az - ez * t);
}

/**
 * Closest distance between segments p (p0-p1) and q (q0-q1), seen from above: the closest point on p
 * into out (x, z as out.x, out.y), and the one on q into `contactBody`.
 */
function segmentSegment(p0x: number, p0z: number, p1x: number, p1z: number, q0x: number, q0z: number, q1x: number, q1z: number, out: THREE.Vector3): number {
  const d1x = p1x - p0x;
  const d1z = p1z - p0z;
  const d2x = q1x - q0x;
  const d2z = q1z - q0z;
  const rx = p0x - q0x;
  const rz = p0z - q0z;
  const a = d1x * d1x + d1z * d1z;
  const e = d2x * d2x + d2z * d2z;
  const f = d2x * rx + d2z * rz;
  const c = d1x * rx + d1z * rz;
  const b = d1x * d2x + d1z * d2z;
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
  out.set(p0x + d1x * s, p0z + d1z * s, 0);
  contactBody.x = q0x + d2x * t;
  contactBody.z = q0z + d2z * t;
  return Math.hypot(out.x - contactBody.x, out.y - contactBody.z);
}
