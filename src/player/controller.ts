import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { InputState } from '../input';
import { MOVEMENT as M, centreAboveFeet } from './movement';

/**
 * The player's physics: an upright capsule on Rapier's kinematic character controller. Horizontal
 * velocity comes from camera-relative input with acceleration; vertical velocity (gravity, jumps)
 * is integrated here. Rapier resolves collisions, slopes, steps and ground snapping.
 */
export class PlayerController {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private kcc: RAPIER.KinematicCharacterController;

  /** Capsule centre now and one physics step ago, for render interpolation. */
  readonly position = new THREE.Vector3();
  readonly prevPosition = new THREE.Vector3();
  /** Velocity actually achieved last step (after collisions), m/s. */
  readonly velocity = new THREE.Vector3();
  /** Direction the lizard faces, as a yaw about +Y where 0 faces +Z. */
  yaw = 0;
  prevYaw = 0;
  grounded = false;
  /** True for exactly one step: the step the character touched down. */
  landed = false;
  /** True for exactly one step: the step a jump started. */
  jumped = false;
  /** Seconds since leaving the ground (0 while grounded). */
  airTime = 0;

  private vy = 0;
  private sinceGrounded = Infinity;
  private sinceJumpPressed = Infinity;
  private jumpHeld = false;
  private jumping = false;
  private desired = new THREE.Vector3();

  constructor(world: RAPIER.World, feet: THREE.Vector3) {
    this.position.copy(feet).y += centreAboveFeet();
    this.prevPosition.copy(this.position);
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.position.x, this.position.y, this.position.z),
    );
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(M.capsuleHalfHeight, M.capsuleRadius), this.body);

    const kcc = world.createCharacterController(M.skin);
    kcc.setUp({ x: 0, y: 1, z: 0 });
    kcc.setMaxSlopeClimbAngle(M.maxSlopeClimb);
    kcc.setMinSlopeSlideAngle(M.minSlopeSlide);
    kcc.enableAutostep(M.stepHeight, M.stepMinWidth, false);
    kcc.enableSnapToGround(M.snapToGround);
    kcc.setSlideEnabled(true);
    this.kcc = kcc;
  }

  /** Advance one fixed step. `cameraYaw` is the yaw the camera looks along, so input is camera-relative. */
  step(dt: number, input: InputState, cameraYaw: number) {
    this.prevPosition.copy(this.position);
    this.prevYaw = this.yaw;
    this.landed = this.jumped = false;

    // Horizontal: accelerate toward the stick direction in camera space.
    const fx = Math.sin(cameraYaw);
    const fz = Math.cos(cameraYaw);
    const speed = input.run ? M.runSpeed : M.walkSpeed;
    const tx = (input.move.y * fx - input.move.x * fz) * speed;
    const tz = (input.move.y * fz + input.move.x * fx) * speed;
    const hasInput = input.move.x !== 0 || input.move.y !== 0;
    const accel = !this.grounded ? M.airAccel : hasInput ? M.groundAccel : M.groundDecel;
    let vx = this.velocity.x;
    let vz = this.velocity.z;
    const dvx = tx - vx;
    const dvz = tz - vz;
    const dv = Math.hypot(dvx, dvz);
    const maxDv = accel * dt;
    if (dv <= maxDv) {
      vx = tx;
      vz = tz;
    } else {
      vx += (dvx / dv) * maxDv;
      vz += (dvz / dv) * maxDv;
    }

    // Turn toward where we're asked to go (or moving), at a capped rate.
    if (hasInput || Math.hypot(vx, vz) > 0.02) {
      const want = hasInput ? Math.atan2(tx, tz) : Math.atan2(vx, vz);
      const diff = Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw));
      this.yaw += THREE.MathUtils.clamp(diff, -M.turnRate * dt, M.turnRate * dt);
    }

    // Vertical: buffered, coyote-timed jumps and asymmetric gravity.
    const jumpPressed = input.jump && !this.jumpHeld;
    this.jumpHeld = input.jump;
    this.sinceJumpPressed = jumpPressed ? 0 : this.sinceJumpPressed + dt;
    this.sinceGrounded = this.grounded ? 0 : this.sinceGrounded + dt;

    if (this.grounded && this.vy <= 0) {
      this.vy = 0;
      this.jumping = false;
    }
    if (this.sinceJumpPressed <= M.jumpBuffer && this.sinceGrounded <= M.coyoteTime && !this.jumping) {
      this.vy = Math.sqrt(2 * M.gravity * M.jumpHeight);
      this.jumping = this.jumped = true;
      this.sinceJumpPressed = this.sinceGrounded = Infinity;
    }
    let g = M.gravity;
    if (this.vy < 0) g *= M.fallGravityScale;
    else if (this.jumping && !input.jump) g *= M.jumpCutGravityScale;
    // Integrate gravity at mid-step so the jump apex lands on jumpHeight regardless of dt.
    const vy0 = this.vy;
    this.vy = Math.max(this.vy - g * dt, -M.maxFallSpeed);

    this.desired.set(vx * dt, ((vy0 + this.vy) / 2) * dt, vz * dt);
    this.kcc.computeColliderMovement(this.collider, this.desired);
    const moved = this.kcc.computedMovement();
    const wasGrounded = this.grounded;
    // Rapier still reports grounded on the step a jump leaves the floor; rising from a jump is airborne.
    this.grounded = this.kcc.computedGrounded() && !(this.jumping && this.vy > 0);

    // Blocked going up (a ceiling) or landed: stop vertical speed so it doesn't build up.
    if (this.vy > 0 && moved.y < this.desired.y - 1e-5) this.vy = 0;
    this.position.x += moved.x;
    this.position.y += moved.y;
    this.position.z += moved.z;
    this.body.setNextKinematicTranslation(this.position);

    // Keep the velocity actually achieved, so walls absorb momentum instead of storing it.
    this.velocity.set(moved.x / dt, this.vy, moved.z / dt);
    if (this.grounded) this.velocity.y = moved.y / dt;

    if (this.grounded && !wasGrounded && this.airTime > 0.05) this.landed = true;
    this.airTime = this.grounded ? 0 : this.airTime + dt;
  }

  /** Feet position for rendering, interpolated between the last two steps. */
  feetAt(alpha: number, out: THREE.Vector3): THREE.Vector3 {
    out.lerpVectors(this.prevPosition, this.position, alpha);
    out.y -= centreAboveFeet();
    return out;
  }

  yawAt(alpha: number): number {
    const diff = Math.atan2(Math.sin(this.yaw - this.prevYaw), Math.cos(this.yaw - this.prevYaw));
    return this.prevYaw + diff * alpha;
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Teleport (tests and respawn). */
  setFeet(feet: THREE.Vector3) {
    this.position.copy(feet).y += centreAboveFeet();
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.vy = 0;
    this.body.setTranslation(this.position, true);
  }
}
