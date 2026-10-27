import * as THREE from 'three';
import { FreeRig, type FreeRigKit } from '../render/freeRig';
import { FLOORS, ROOSTS, SKYLIGHTS, type Roost } from './layout';

export type OwlState = 'roost' | 'alert' | 'drop' | 'mantle' | 'grounded' | 'return';

/**
 * What an owl hears of the lizard: how far (m, across the ground from under the skylight) a step is
 * heard. A barn owl finds prey in the dark by sound alone, so running (the patter of feet, a jump's
 * thump, a splash) carries across the whole sunlit floor under the roost, a walk only right under it,
 * and a lizard standing still makes no sound at all.
 */
export const HEARING = { run: 0.9, walk: 0.16, thump: 0.9 };
/** Within this (m, across) of the skylight's middle, on its floor, the owl can drop on the lizard. */
export const REACH = 0.55;
/** Seconds from hearing to leaving the ledge, and on the way down. */
const ALERT_TIME = 0.4;
const DROP_TIME = 0.6;
/** Talons within this (m) of the lizard as they come down: caught. */
const CATCH = 0.065;
/** Seconds on the floor after a miss, flying back up, and deaf after getting back. */
const GROUNDED_TIME = 1.1;
const RETURN_TIME = 0.9;
const DEAF_TIME = 1.2;

/** The lizard as the owls hear and hunt it, each physics step. */
export interface Prey {
  feet: THREE.Vector3;
  /** How far its sound carries this step (m), 0 when silent. */
  loudness: number;
  /** Whether it can be caught now (not already caught, not finished). */
  open: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
const va = new THREE.Vector3();
const vb = new THREE.Vector3();

/**
 * A Galapagos barn owl (assets-src/owl.py) roosting on a ledge high in a skylight's shaft. By day it
 * sits listening, its head turning after every sound below. When it hears the lizard on the floor
 * under the skylight, it leans, drops on the spot it heard (re-aiming while the sound goes on) with
 * its wings raised and its talons swung forward, and either has the lizard or, if the lizard went
 * quiet and slipped aside, stands a moment looking about and flies back up.
 */
export class Owl {
  state: OwlState = 'roost';
  readonly rig: FreeRig;
  /** Where the owl's feet are (world) and which way it faces (as the lizard's yaw). */
  readonly at = new THREE.Vector3();
  yaw: number;
  /** Where the sound came from (world), aimed at on the way down. */
  readonly heard = new THREE.Vector3();
  /** Seconds in the current state. */
  timer = 0;
  private deaf = 0;
  /** The floor of its skylight, its middle, and the roost (feet on the ledge). */
  readonly home = new THREE.Vector3();
  readonly under: { x: number; z: number; y: number };
  private readonly from = new THREE.Vector3();
  private readonly homeYaw: number;
  /** Head turn (radians, left of facing) and tilt (down), eased toward where it's listening. */
  private headYaw = 0;
  private headPitch = 0.2;
  private lookAt: THREE.Vector3 | null = null;
  private time: number;

  constructor(
    kit: FreeRigKit,
    readonly roost: Roost,
  ) {
    this.rig = new FreeRig(kit);
    this.rig.root.name = `owl-${roost.name}`;
    const sky = SKYLIGHTS.find((s) => s.name === roost.name)!;
    this.under = { x: sky.x, z: sky.z, y: FLOORS[1] };
    this.home.set(roost.x, roost.y, roost.z);
    this.homeYaw = Math.atan2(-roost.dx, -roost.dz);
    this.yaw = this.homeYaw;
    this.at.copy(this.home);
    this.time = roost.x * 3;
  }

  /** Whether the lizard's feet are where this owl can drop on them: on the floor under its skylight. */
  inReach(feet: THREE.Vector3) {
    return Math.abs(feet.y - this.under.y) < 0.06 && Math.hypot(feet.x - this.under.x, feet.z - this.under.z) < REACH;
  }

  /** Back to its ledge at once, settled (after a catch, or a restart). */
  callOff() {
    this.state = 'roost';
    this.timer = 0;
    this.deaf = DEAF_TIME;
    this.at.copy(this.home);
    this.yaw = this.homeYaw;
  }

  /** One physics step; returns true when its talons close on the lizard. */
  step(dt: number, prey: Prey): boolean {
    this.timer += dt;
    this.time += dt;
    this.deaf = Math.max(0, this.deaf - dt);
    const across = Math.hypot(prey.feet.x - this.under.x, prey.feet.z - this.under.z);
    const audible = prey.open && across < prey.loudness && Math.abs(prey.feet.y - this.under.y) < 0.3;
    // It hears the lizard (turning its head to it) whenever it's audible, and drops if it's in reach.
    if (audible) this.lookAt = this.heard.copy(prey.feet);
    switch (this.state) {
      case 'roost':
        if (audible && this.deaf <= 0 && this.inReach(prey.feet)) this.enter('alert');
        break;
      case 'alert':
        if (this.timer >= ALERT_TIME) {
          this.from.copy(this.at);
          this.enter('drop');
        }
        break;
      case 'drop': {
        // Re-aim at the sound while it goes on; the floor under it.
        const t = Math.min(1, this.timer / DROP_TIME);
        this.flightPoint(this.from, this.heard, t, this.at);
        this.yaw = Math.atan2(this.heard.x - this.from.x, this.heard.z - this.from.z);
        if (t >= 1) {
          this.at.set(this.heard.x, this.under.y, this.heard.z);
          if (prey.open && Math.hypot(prey.feet.x - this.heard.x, prey.feet.z - this.heard.z) < CATCH && Math.abs(prey.feet.y - this.under.y) < 0.06) {
            this.enter('mantle');
            return true;
          }
          this.enter('grounded');
        }
        break;
      }
      case 'grounded':
        if (this.timer >= GROUNDED_TIME) {
          this.from.copy(this.at);
          this.enter('return');
        }
        break;
      case 'return': {
        const t = Math.min(1, this.timer / RETURN_TIME);
        this.flightPoint(this.from, this.home, t, this.at);
        this.yaw = Math.atan2(this.home.x - this.from.x, this.home.z - this.from.z);
        if (t >= 1) this.callOff();
        break;
      }
      case 'mantle':
        break;
    }
    return false;
  }

  /** Let go after a catch: back up to the ledge. */
  release() {
    if (this.state !== 'mantle') return;
    this.from.copy(this.at);
    this.enter('return');
  }

  private enter(state: OwlState) {
    this.state = state;
    this.timer = 0;
  }

  /** Along the flight between a and b at t (0 to 1): a drop that falls steeply then levels to land. */
  private flightPoint(a: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3) {
    const e = t * t * (3 - 2 * t);
    out.lerpVectors(a, b, e);
    // Down first and across after, so it drops out of the shaft and glides in.
    out.y = a.y + (b.y - a.y) * Math.sin((t * Math.PI) / 2) + 0.04 * Math.sin(t * Math.PI);
    return out;
  }

  /** Pose the owl for its state (each frame). */
  pose(dt: number) {
    const rig = this.rig;
    const J = rig.joints;
    const s = this.state;
    const flying = s === 'drop' || s === 'return';
    const t = this.timer;
    // Head: toward the last sound, turning far as an owl does; otherwise slow looks round.
    let wantYaw = 0.5 * Math.sin(this.time * 0.4) + 0.3 * Math.sin(this.time * 1.1);
    let wantPitch = 0.25;
    if (this.lookAt && (s === 'roost' || s === 'alert' || s === 'grounded')) {
      const dx = this.lookAt.x - this.at.x;
      const dz = this.lookAt.z - this.at.z;
      let rel = Math.atan2(dx, dz) - this.yaw;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      wantYaw = THREE.MathUtils.clamp(rel, -2.4, 2.4);
      wantPitch = THREE.MathUtils.clamp(Math.atan2(this.at.y + 0.22 - this.lookAt.y, Math.hypot(dx, dz)) * 0.8, -0.3, 1.0);
    }
    if (flying || s === 'mantle') {
      wantYaw = 0;
      wantPitch = s === 'mantle' ? 0.7 : 0.35;
    }
    const k = 1 - Math.exp(-dt * (s === 'alert' ? 30 : 8));
    this.headYaw += (wantYaw - this.headYaw) * k;
    this.headPitch += (wantPitch - this.headPitch) * k;
    // The body's pitch (nose down positive) and how the wings and legs are held.
    let pitch = 0;
    let wing = 0;
    let sweep = 0;
    let hand = 0;
    let legs = 0;
    let crouch = 0;
    if (s === 'alert') {
      // Leaning out over the edge, head low, ready.
      pitch = 0.45 * Math.min(1, t / 0.15);
      crouch = 0.02;
    } else if (s === 'drop') {
      const u = Math.min(1, t / DROP_TIME);
      // Wings up in a V as it falls, then spread and the body flared back, talons thrown forward.
      pitch = THREE.MathUtils.lerp(0.9, -0.7, THREE.MathUtils.smoothstep(u, 0.45, 0.95));
      wing = THREE.MathUtils.lerp(1.0, 0.25, THREE.MathUtils.smoothstep(u, 0.4, 0.85));
      hand = -0.3;
      legs = -1.1 * THREE.MathUtils.smoothstep(u, 0.5, 0.9);
    } else if (s === 'return') {
      pitch = -0.15;
      wing = 0.15 + 0.75 * Math.sin(t * Math.PI * 2 * 4.5);
      hand = -0.2 + 0.25 * Math.sin(t * Math.PI * 2 * 4.5 - 0.6);
      legs = 0.4;
    } else if (s === 'mantle') {
      // Over its catch, wings spread low round it.
      pitch = 0.55;
      wing = -0.35;
      sweep = 0.25;
      hand = -0.5;
      crouch = 0.04;
    }
    const pivot = J.body;
    qa.setFromAxisAngle(UP, this.yaw);
    qb.setFromAxisAngle(X, pitch);
    const rot = qa.clone().multiply(qb);
    // The body turns about its middle: put the creature so that point stays over its feet.
    va.copy(pivot).applyQuaternion(qb).sub(pivot).negate().applyQuaternion(qa);
    vb.copy(this.at).add(va);
    vb.y -= crouch;
    rig.place(vb, rot);
    const id = new THREE.Quaternion();
    rig.part('body', id);
    rig.part('tail', qa.setFromAxisAngle(X, flying ? -0.25 : 0));
    const head = new THREE.Quaternion().setFromAxisAngle(UP, this.headYaw).multiply(qb.setFromAxisAngle(X, this.headPitch - pitch * 0.6));
    rig.part('head', head);
    for (const [side, sgn] of [
      ['_L', 1],
      ['_R', -1],
    ] as const) {
      rig.part(`leg${side}`, qa.setFromAxisAngle(X, legs));
      const spread = flying || s === 'mantle';
      rig.part(`fold${side}`, id, undefined, spread ? 0.001 : 1);
      if (!spread) {
        rig.part(`wing${side}`, id, undefined, 0.001);
        rig.part(`hand${side}`, id, J[`wing${side}`], 0.001);
        continue;
      }
      // The arm raised (about the body's long axis) and swept back; the hand bent at the wrist.
      const arm = new THREE.Quaternion().setFromAxisAngle(Z, wing * sgn).multiply(qa.setFromAxisAngle(UP, -sweep * sgn));
      rig.part(`wing${side}`, arm);
      const wrist = vb.copy(J[`hand${side}`]).sub(J[`wing${side}`]).applyQuaternion(arm).add(J[`wing${side}`]);
      const bend = arm.clone().multiply(qa.setFromAxisAngle(Z, hand * sgn));
      rig.part(`hand${side}`, bend, wrist);
    }
  }
}

/** The tunnels' owls: one on each roost (`ROOSTS`, from assets-src/tunnels.py). */
export class Owls {
  readonly list: Owl[];
  /** Called as an owl hears the lizard and is about to drop, and as one catches it. */
  onHeard: ((owl: Owl) => void) | null = null;
  onCatch: ((owl: Owl) => void) | null = null;

  constructor(kit: FreeRigKit, scene: THREE.Scene) {
    this.list = ROOSTS.map((r) => new Owl(kit, r));
    for (const o of this.list) {
      scene.add(o.rig.root);
      o.pose(0);
    }
  }

  step(dt: number, prey: Prey) {
    for (const o of this.list) {
      const was = o.state;
      if (o.step(dt, prey)) this.onCatch?.(o);
      if (was === 'roost' && o.state === 'alert') this.onHeard?.(o);
    }
  }

  pose(dt: number) {
    for (const o of this.list) o.pose(dt);
  }

  /** Every owl back on its ledge. */
  callOff() {
    for (const o of this.list) o.callOff();
  }
}
