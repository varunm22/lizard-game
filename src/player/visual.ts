import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { LIZARD_GAIT_SPEED, type LizardModel } from './lizardModel';
import type { PlayerController } from './controller';
import type { MoveState } from './state';

/** How fast the body eases onto a new ground slope (per second, exponential). */
const TILT_RATE = 12;
/** Steepest ground tilt the body follows; beyond it the lizard stays more upright. */
const MAX_TILT = (35 * Math.PI) / 180;
/** Head turn at full turn input (radians), and how fast it eases in and out (per second). */
const HEAD_TURN = 0.5;
const HEAD_TURN_RATE = 10;
const CROSS_FADE: Partial<Record<MoveState, number>> = { jump: 0.08, land: 0.06, fall: 0.15 };

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Draws the lizard where the physics capsule is: interpolated position, eased facing, body tilted
 * to the ground normal, and the clip for the current movement state with gait playback scaled to
 * ground speed so the feet don't skate. Never moves the capsule.
 */
export class LizardVisual {
  private normal = UP.clone();
  private targetNormal = new THREE.Vector3();
  private feet = new THREE.Vector3();
  private tilt = new THREE.Quaternion();
  private yawQ = new THREE.Quaternion();
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(
    readonly model: LizardModel,
    private player: PlayerController,
    private world: RAPIER.World,
  ) {}

  update(state: MoveState, alpha: number, dt: number) {
    const p = this.player;
    p.feetAt(alpha, this.feet);

    // Ground normal under the body; upright in the air.
    this.targetNormal.copy(UP);
    if (p.grounded) {
      this.ray.origin = { x: this.feet.x, y: this.feet.y + 0.03, z: this.feet.z };
      const hit = this.world.castRayAndGetNormal(this.ray, 0.08, true, undefined, undefined, undefined, p.body);
      if (hit) this.targetNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);
      const angle = this.targetNormal.angleTo(UP);
      if (angle > MAX_TILT) this.targetNormal.lerp(UP, 1 - MAX_TILT / angle).normalize();
    }
    this.normal.lerp(this.targetNormal, 1 - Math.exp(-TILT_RATE * dt)).normalize();

    this.tilt.setFromUnitVectors(UP, this.normal);
    this.yawQ.setFromAxisAngle(UP, p.yawAt(alpha));
    this.model.root.position.copy(this.feet);
    this.model.root.quaternion.copy(this.tilt).multiply(this.yawQ);

    this.model.play(state, CROSS_FADE[state] ?? 0.2);
    if (state === 'walk' || state === 'run') {
      this.model.setRate(THREE.MathUtils.clamp(p.horizontalSpeed / LIZARD_GAIT_SPEED[state], 0.3, 5));
    }
    // Lead turns with the head: turning right (positive input) swings the head to the lizard's right.
    const goal = p.turning * HEAD_TURN;
    this.model.headTurn += (goal - this.model.headTurn) * (1 - Math.exp(-HEAD_TURN_RATE * dt));
    this.model.update(dt);
  }
}
