import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { IGNORE_STEMS } from '../world/terrain';
import { LIZARD_GAIT_SPEED, LIZARD_SWIM_SPEED, type LizardModel } from './lizardModel';
import type { PlayerController } from './controller';
import type { MoveState } from './state';
import { fitSpine, type SpineFit } from './spineFit';
import { LegReach } from './legReach';

/** How fast the side-to-side tilt eases onto a new ground slope (per second, exponential). */
const TILT_RATE = 12;
/** Steepest side-to-side tilt the body follows; beyond it the lizard stays more upright. */
const MAX_TILT = (35 * Math.PI) / 180;
/**
 * The surface is sampled at these points along the body (m from the physics centre, + toward the
 * snout), tail tip to snout. The spine fit interpolates between them.
 */
const SAMPLES = Array.from({ length: 12 }, (_, i) => -0.095 + (i * 0.165) / 11);
/**
 * Rays start this far above the physics feet height. Within the capsule's footprint nothing can sit
 * between there and the body, so whatever a ray hits is under the lizard, not beside it.
 */
const SAMPLE_UP = 0.025;
const SAMPLE_DOWN = 0.1;
/** Climbing, the front of the body reaches this far ahead for the top, so the front feet lead. */
const CLIMB_LOOKAHEAD = 0.025;
/** How fast sampled heights ease to new values (per second): smooths stepping over an edge. */
const SURFACE_RATE = 30;
/**
 * Head turn at full turn input (radians): standing still, left/right only turns the head, so it goes
 * further; on the move the head leads the body's turn. Eases in and out at HEAD_TURN_RATE per second.
 */
const HEAD_LOOK = 0.8;
const HEAD_LEAD = 0.3;
const HEAD_TURN_RATE = 10;
/** How fast the legs start or stop reaching for the ground on landing and take-off (per second). */
const REACH_RATE = 15;
/** Feet look for the surface this far above and below where the pose put them. */
const FOOT_PROBE = 0.012;
const CROSS_FADE: Partial<Record<MoveState, number>> = { jump: 0.08, land: 0.06, fall: 0.15, swim: 0.3 };
/**
 * Swimming, the drawn body is raised this much so it sits centred on the physics capsule (on land
 * the feet hold it lower), and eases there at SWIM_LIFT_RATE per second.
 */
const SWIM_LIFT = 0.01;
const SWIM_LIFT_RATE = 6;
/** Tail beat rate when drifting with no swimming input, relative to the clip. */
const SWIM_IDLE_RATE = 0.4;

const UP = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);

/**
 * Draws the lizard where the physics capsule is: interpolated position and facing, the spine fitted
 * to the surface under it so the feet stand on it and the body bends over rims and up steps, tilted
 * side to side with the ground, and the clip for the current movement state with gait playback
 * scaled to ground speed so the feet don't skate. Never moves the capsule.
 */
export class LizardVisual {
  private normal = UP.clone();
  private targetNormal = new THREE.Vector3();
  private feet = new THREE.Vector3();
  private yawQ = new THREE.Quaternion();
  private rollQ = new THREE.Quaternion();
  private pitchQ = new THREE.Quaternion();
  private local = new THREE.Vector3();
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  /** Surface height at each sample, relative to the physics feet height, eased. */
  private heights = SAMPLES.map(() => 0);
  private hindSlope = 0;
  private sampleUp = SAMPLE_UP;
  private legs: LegReach;
  private reach = 1;
  private swimLift = 0;
  private footRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  /** The spine fit drawn last frame. */
  fit: SpineFit | null = null;

  constructor(
    readonly model: LizardModel,
    private player: PlayerController,
    private world: RAPIER.World,
  ) {
    this.legs = new LegReach(model);
  }

  update(state: MoveState, alpha: number, dt: number) {
    const p = this.player;
    p.feetAt(alpha, this.feet);
    const yaw = p.yawAt(alpha);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const ease = 1 - Math.exp(-SURFACE_RATE * dt);
    // Climbing, look down from above the top so the front feet find it before the body is up.
    const top = p.climbTop;
    this.sampleUp = top === null ? SAMPLE_UP : Math.max(SAMPLE_UP, top - this.feet.y + 0.005);

    // Sample the surface along the body. In the air or the water the body just straightens.
    const standing = p.grounded && !p.swimming;
    this.targetNormal.copy(UP);
    let hindSlope = 0;
    for (let i = 0; i < SAMPLES.length; i++) {
      let h = 0;
      if (standing) {
        const hit = this.cast(this.feet.x + fx * SAMPLES[i], this.feet.z + fz * SAMPLES[i]);
        h = hit === null ? -SAMPLE_DOWN : this.sampleUp - hit.timeOfImpact;
      }
      this.heights[i] += (h - this.heights[i]) * ease;
    }
    if (standing) {
      const centre = this.cast(this.feet.x, this.feet.z);
      if (centre) this.targetNormal.set(centre.normal.x, centre.normal.y, centre.normal.z);
      const hind = this.model.rig.hindFoot.s;
      const hindHit = this.cast(this.feet.x + fx * hind, this.feet.z + fz * hind);
      if (hindHit) {
        // Ground rising toward the snout leans the normal back (against the facing).
        this.local.set(hindHit.normal.x, hindHit.normal.y, hindHit.normal.z);
        hindSlope = Math.atan2(-(this.local.x * fx + this.local.z * fz), this.local.y);
      }
    }
    this.hindSlope += (hindSlope - this.hindSlope) * ease;
    const angle = this.targetNormal.angleTo(UP);
    if (angle > MAX_TILT) this.targetNormal.lerp(UP, 1 - MAX_TILT / angle).normalize();
    this.normal.lerp(this.targetNormal, 1 - Math.exp(-TILT_RATE * dt)).normalize();

    const ahead = top === null ? 0 : CLIMB_LOOKAHEAD;
    const fit = (this.fit = fitSpine(this.model.rig, (s) => this.surfaceAt(s > 0 ? s + ahead : s), this.hindSlope));
    const bend = this.model.bend;
    bend.chest = fit.chest - fit.hips;
    bend.neck = fit.neck - fit.chest;
    bend.head = fit.head - fit.neck;
    bend.tail1 = fit.tail[0] - fit.hips;
    bend.tail2 = fit.tail[1] - fit.tail[0];
    bend.tail3 = fit.tail[2] - fit.tail[1];
    bend.tail4 = fit.tail[3] - fit.tail[2];

    // Side-to-side tilt from the ground normal in the lizard's own frame; pitch from the fit.
    this.yawQ.setFromAxisAngle(UP, yaw);
    this.local.copy(this.normal).applyQuaternion(this.rollQ.copy(this.yawQ).invert());
    this.rollQ.setFromAxisAngle(Z, Math.atan2(-this.local.x, this.local.y));
    this.pitchQ.setFromAxisAngle(X, -fit.hips - p.swimPitchAt(alpha));
    this.swimLift += ((p.swimming ? SWIM_LIFT : 0) - this.swimLift) * (1 - Math.exp(-SWIM_LIFT_RATE * dt));
    this.model.root.position.copy(this.feet).y += fit.rootY + this.swimLift;
    this.model.root.quaternion.copy(this.yawQ).multiply(this.rollQ).multiply(this.pitchQ);

    this.model.play(state, CROSS_FADE[state] ?? 0.2);
    if (state === 'walk' || state === 'run') {
      const speed = p.climbing ? p.velocity.length() : p.horizontalSpeed;
      this.model.setRate(THREE.MathUtils.clamp(speed / LIZARD_GAIT_SPEED[state], 0.3, 5));
    } else if (state === 'swim') {
      // Beat the tail with the swimming speed, and briskly while rising, which the tail drives.
      const effort = Math.max(p.horizontalSpeed / LIZARD_SWIM_SPEED, p.velocity.y > 0 ? 1 : 0);
      this.model.setRate(THREE.MathUtils.clamp(effort, SWIM_IDLE_RATE, 2));
    }
    // Lead turns with the head: turning right (positive input) swings the head to the lizard's right.
    const goal = p.turning * (p.bodyTurning ? HEAD_LEAD : HEAD_LOOK);
    this.model.headTurn += (goal - this.model.headTurn) * (1 - Math.exp(-HEAD_TURN_RATE * dt));
    this.model.update(dt);
    this.reach += ((standing ? 1 : 0) - this.reach) * (1 - Math.exp(-REACH_RATE * dt));
    this.legs.apply((x, y, z) => this.footGround(x, y, z), this.reach);
  }

  /** The surface just under a foot, or null if it's out of the leg's reach. */
  private footGround(x: number, y: number, z: number): number | null {
    this.footRay.origin = { x, y: y + FOOT_PROBE, z };
    const hit = this.world.castRay(this.footRay, 2 * FOOT_PROBE, true, undefined, IGNORE_STEMS, undefined, this.player.body);
    return hit && hit.timeOfImpact > 0 ? y + FOOT_PROBE - hit.timeOfImpact : null;
  }

  private cast(x: number, z: number) {
    this.ray.origin = { x, y: this.feet.y + this.sampleUp, z };
    return this.world.castRayAndGetNormal(this.ray, this.sampleUp + SAMPLE_DOWN, true, undefined, IGNORE_STEMS, undefined, this.player.body);
  }

  /** Eased surface height at `s` along the body, linear between samples. */
  private surfaceAt(s: number): number {
    const t = THREE.MathUtils.clamp((s - SAMPLES[0]) / (SAMPLES[1] - SAMPLES[0]), 0, SAMPLES.length - 1);
    const i = Math.min(Math.floor(t), SAMPLES.length - 2);
    return this.heights[i] + (this.heights[i + 1] - this.heights[i]) * (t - i);
  }
}
