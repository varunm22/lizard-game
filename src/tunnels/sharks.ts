import * as THREE from 'three';
import { FreeRig, type FreeRigKit } from '../render/freeRig';
import { WATER_Y } from '../world/shore';
import { terrainHeight } from '../world/terrain';

export type SharkState = 'rest' | 'bolt' | 'away' | 'back';

/** Where each pup rests on the bed of the tube's flooded mouth, and the way it lies (yaw). */
const SPOTS = [
  { x: 3.74, z: 3.72, yaw: 2.85 },
  { x: 3.6, z: 4.5, yaw: 0.5 },
];
/** The way out to the open sea and back: down the channel and out of the cove. */
const OUT = [
  { x: 3.72, z: 4.25 },
  { x: 3.55, z: 5.3 },
  { x: 3.7, z: 8.5 },
];
/** A swimmer (or wader) within this (m, across) wakes a resting pup. */
const WAKE = 0.42;
/** Speeds (m/s): bolting, and swimming back in. */
const BOLT_SPEED = 0.85;
const BACK_SPEED = 0.22;
/** Seconds out at sea before coming back. */
const AWAY_TIME = 9;

const UP = new THREE.Vector3(0, 1, 0);
const q = new THREE.Quaternion();
const v = new THREE.Vector3();

/**
 * A whitetip reef shark pup (assets-src/whitetip.py) resting on the bottom of the sea pool in the
 * tube's flooded mouth, as whitetips do by day in caves and under ledges, its tail barely moving as
 * it pumps water over its gills. A swimmer coming over it wakes it: it bolts with a few hard sweeps
 * of the tail down the channel and out to sea, startling but harmless, and some while later comes
 * cruising back and settles on its spot again.
 */
export class Shark {
  state: SharkState = 'rest';
  readonly rig: FreeRig;
  readonly at = new THREE.Vector3();
  yaw: number;
  /** Waypoint it's heading for (index into OUT; back in, counting down), and seconds in this state. */
  private next = 0;
  timer = 0;
  private phase = 0;
  /** How hard the tail is sweeping (0 to 1), eased. */
  private beat = 0;
  private spine: { name: string; z: number; y: number }[];
  private bed: number;

  constructor(
    kit: FreeRigKit,
    readonly spot: { x: number; z: number; yaw: number },
    i: number,
  ) {
    this.rig = new FreeRig(kit);
    this.rig.root.name = `whitetip-${i}`;
    this.bed = terrainHeight(spot.x, spot.z);
    this.at.set(spot.x, this.bed, spot.z);
    this.yaw = spot.yaw;
    this.phase = i * 1.7;
    this.spine = Object.entries(kit.joints)
      .map(([name, p]) => ({ name, z: p.z, y: p.y }))
      .sort((a, b) => b.z - a.z);
  }

  /** One physics step, with the lizard's feet and whether it's in the water; true as it bolts from it. */
  step(dt: number, feet: THREE.Vector3, inWater: boolean): boolean {
    this.timer += dt;
    let woke = false;
    if (this.state === 'rest') {
      if (inWater && Math.hypot(feet.x - this.at.x, feet.z - this.at.z) < WAKE) {
        this.state = 'bolt';
        this.timer = 0;
        // Out by the nearest waypoint further out than it is.
        this.next = OUT.findIndex((p) => p.z > this.at.z + 0.1);
        woke = true;
      }
    } else if (this.state === 'bolt') {
      if (this.swimTo(OUT[this.next], BOLT_SPEED, 7, dt, WATER_Y - 0.1)) {
        if (++this.next >= OUT.length) {
          this.state = 'away';
          this.timer = 0;
        }
      }
    } else if (this.state === 'away') {
      if (this.timer > AWAY_TIME) {
        this.state = 'back';
        this.timer = 0;
        this.next = OUT.length - 1;
      }
    } else if (this.state === 'back') {
      const home = this.next < 0 || OUT[this.next].z < this.spot.z + 0.05;
      const target = home ? this.spot : OUT[this.next];
      if (this.swimTo(target, home ? BACK_SPEED * 0.6 : BACK_SPEED, 2.5, dt, home ? this.bed : WATER_Y - 0.1)) {
        if (home) {
          this.state = 'rest';
          this.timer = 0;
        } else this.next--;
      }
      if (home) {
        // Settling: turned to lie as it was.
        const d = Math.atan2(Math.sin(this.spot.yaw - this.yaw), Math.cos(this.spot.yaw - this.yaw));
        if (Math.hypot(this.spot.x - this.at.x, this.spot.z - this.at.z) < 0.08) this.yaw += d * Math.min(1, dt * 2);
      }
    }
    // The tail: barely moving at rest, hard sweeps bolting, an easy cruise back.
    const want = this.state === 'rest' ? 0.06 : this.state === 'bolt' ? 1 : 0.45;
    this.beat += (want - this.beat) * Math.min(1, dt * 4);
    this.phase += dt * (this.state === 'rest' ? 1.2 : this.state === 'bolt' ? 13 : 6);
    return woke;
  }

  /** Swim toward (x, z) at a depth; true on arrival. */
  private swimTo(p: { x: number; z: number }, speed: number, turn: number, dt: number, y: number) {
    const dx = p.x - this.at.x;
    const dz = p.z - this.at.z;
    const dist = Math.hypot(dx, dz);
    const want = Math.atan2(dx, dz);
    const d = Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw));
    this.yaw += THREE.MathUtils.clamp(d, -turn * dt, turn * dt);
    const step = Math.min(dist, speed * dt * Math.max(0.3, Math.cos(d)));
    this.at.x += Math.sin(this.yaw) * step;
    this.at.z += Math.cos(this.yaw) * step;
    this.at.y += (y - this.at.y) * Math.min(1, dt * 3);
    return dist < 0.06;
  }

  /** Pose the body along a swimming wave (each frame). */
  pose() {
    const rig = this.rig;
    rig.place(this.at, q.setFromAxisAngle(UP, this.yaw));
    const head = this.spine[0].z;
    const length = head - this.spine[this.spine.length - 1].z;
    const lateral = (s: number) => 0.06 * this.beat * Math.pow(s / length, 1.6) * Math.sin(this.phase - 5 * (s / length));
    for (const b of this.spine) {
      const s = head - b.z;
      const x = lateral(s);
      const slope = (lateral(s + 0.01) - x) / 0.01;
      rig.part(b.name, q.setFromAxisAngle(UP, Math.atan(slope)), v.set(x, b.y, b.z));
    }
  }
}

/** The pups in the flooded mouth. */
export class Sharks {
  readonly list: Shark[];
  /** Called as a pup bolts from the lizard. */
  onBolt: ((shark: Shark) => void) | null = null;

  constructor(kit: FreeRigKit, scene: THREE.Scene) {
    this.list = SPOTS.map((s, i) => new Shark(kit, s, i));
    for (const s of this.list) {
      scene.add(s.rig.root);
      s.pose();
    }
  }

  step(dt: number, feet: THREE.Vector3, inWater: boolean) {
    for (const s of this.list) if (s.step(dt, feet, inWater)) this.onBolt?.(s);
  }

  pose() {
    for (const s of this.list) s.pose();
  }
}
