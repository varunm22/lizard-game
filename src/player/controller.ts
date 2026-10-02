import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { InputState } from '../input';
import { MOVEMENT as M, centreAboveFeet } from './movement';

/**
 * The player's physics: a capsule lying along the lizard's body on Rapier's kinematic character
 * controller. Steering is
 * tank-style: left/right turns the lizard (in place when standing still), forward/back moves it
 * along its facing with acceleration. Vertical velocity (gravity, jumps) is integrated here. Rapier resolves collisions, slopes, steps and ground snapping.
 */
/** Lays the capsule's long axis (Y) along the lizard's forward axis (+Z). */
const LAY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const UP = new THREE.Vector3(0, 1, 0);

/** A step's downward move larger than this (m) is a fall, not walking down a slope. */
const FREE_FALL_DROP = 0.002;

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
  /** Turn input this step, -1 (left) to 1 (right); the visual leans the head into it. */
  turning = 0;

  private vy = 0;
  private sinceGrounded = Infinity;
  private sinceJumpPressed = Infinity;
  private jumpHeld = false;
  private jumping = false;
  private desired = new THREE.Vector3();
  private world: RAPIER.World;
  private rot = new THREE.Quaternion();
  /** Turning is checked against everything but the terrain, which the controller lifts the body off. */
  private turnBlocker = (c: RAPIER.Collider) => c.shapeType() !== RAPIER.ShapeType.HeightField;

  constructor(world: RAPIER.World, feet: THREE.Vector3) {
    this.position.copy(feet).y += centreAboveFeet();
    this.prevPosition.copy(this.position);
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.position.x, this.position.y, this.position.z),
    );
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(M.bodyHalfLength, M.bodyRadius), this.body);
    this.world = world;
    this.body.setRotation(this.bodyRotation(this.yaw), true);

    const kcc = world.createCharacterController(M.skin);
    kcc.setUp({ x: 0, y: 1, z: 0 });
    kcc.setMaxSlopeClimbAngle(M.maxSlopeClimb);
    kcc.setMinSlopeSlideAngle(M.minSlopeSlide);
    kcc.enableAutostep(M.stepHeight, M.stepMinWidth, false);
    kcc.enableSnapToGround(M.snapToGround);
    kcc.setSlideEnabled(true);
    this.kcc = kcc;
  }

  /** Advance one fixed step. */
  step(dt: number, input: InputState) {
    this.prevPosition.copy(this.position);
    this.prevYaw = this.yaw;
    this.landed = this.jumped = false;

    // Turn: right input turns right, which is clockwise seen from above (yaw decreasing). The body
    // is long, so a turn that would swing it into a rock or log is refused.
    this.turning = input.move.x;
    if (input.move.x !== 0) {
      const yaw = Math.atan2(Math.sin(this.yaw - input.move.x * M.turnRate * dt), Math.cos(this.yaw - input.move.x * M.turnRate * dt));
      const blocked = this.world.intersectionWithShape(
        this.position,
        this.bodyRotation(yaw),
        this.collider.shape,
        undefined,
        undefined,
        undefined,
        this.body,
        this.turnBlocker,
      );
      if (!blocked) this.yaw = yaw;
    }
    this.body.setNextKinematicRotation(this.bodyRotation(this.yaw));

    // Horizontal: accelerate toward forward/back input along the facing.
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const forward = input.move.y;
    const speed = forward < 0 ? M.backSpeed : input.run ? M.runSpeed : M.walkSpeed;
    const tx = forward * fx * speed;
    const tz = forward * fz * speed;
    const hasInput = forward !== 0;
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
    // It also reports grounded early when falling fast, as soon as the ground is within this step's
    // drop, while the capsule is still centimetres up. Taking that at face value zeroed the fall speed
    // and left the lizard drifting the last few centimetres down at snap speed. Still falling freely
    // (the whole drop was allowed) means not landed yet.
    const fellFreely = this.desired.y < -FREE_FALL_DROP && moved.y <= this.desired.y + 1e-5;
    this.grounded = this.kcc.computedGrounded() && !(this.jumping && this.vy > 0) && !fellFreely;

    // Standing still on a rounded or faceted edge (the rim of a log, the shoulder of a rock), the
    // little push of gravity each step slides the lizard off a fraction of a millimetre at a time.
    // Lizards grip: below a slow creep, hold still. Real slides on steep ground are much faster.
    if (this.grounded && wasGrounded && !hasInput && moved.y <= 0 && Math.hypot(moved.x, moved.y, moved.z) < M.gripCreep * dt) {
      moved.x = moved.y = moved.z = 0;
    }

    // Blocked going up (a ceiling): stop vertical speed so it doesn't build up. Grazing a rounded
    // side (the underside of a log against the snout) only slows the rise, so that keeps the jump.
    if (this.vy > 0 && moved.y < this.desired.y * 0.25) this.vy = 0;
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
  setFeet(feet: THREE.Vector3, yaw = this.yaw) {
    this.position.copy(feet).y += centreAboveFeet();
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.vy = 0;
    this.yaw = this.prevYaw = yaw;
    this.body.setTranslation(this.position, true);
    this.body.setRotation(this.bodyRotation(yaw), true);
  }

  private bodyRotation(yaw: number): THREE.Quaternion {
    return this.rot.setFromAxisAngle(UP, yaw).multiply(LAY);
  }
}
