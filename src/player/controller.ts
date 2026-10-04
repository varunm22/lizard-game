import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { InputState } from '../input';
import { MOVEMENT as M, centreAboveFeet } from './movement';
import { WATER_Y, waterDepth } from '../world/shore';
import { IGNORE_STEMS } from '../world/terrain';

/**
 * The player's physics: a capsule lying along the lizard's body on Rapier's kinematic character
 * controller. Steering is
 * tank-style: left/right turns the lizard (in place when standing still), forward/back moves it
 * along its facing with acceleration. Vertical velocity (gravity, jumps) is integrated here. Rapier resolves collisions, slopes, steps and ground snapping.
 * Once the whole body is under water it swims instead: see `stepSwim`.
 */
/** Lays the capsule's long axis (Y) along the lizard's forward axis (+Z). */
const LAY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const UP = new THREE.Vector3(0, 1, 0);

/** A step's downward move larger than this (m) is a fall, not walking down a slope. */
const FREE_FALL_DROP = 0.002;
/** Upward drift (m per step) the controller adds keeping its skin off a slope while sliding down it. */
const GRIP_LIFT = 1e-4;
/**
 * The capsule can rest on one end across a rim (half on a log, the rest over the drop), which a
 * lizard can't: it tips off. With nothing within this far under its centre, but something under one
 * end, it slides toward the overhang at TIP_SPEED until it falls.
 */
const SUPPORT_REACH = 0.015;
const TIP_SPEED = 0.15;
/** Where support is checked, from the centre along the facing (the capsule's straight part ends at ±0.048). */
const SUPPORT_CHECKS = [-0.058, -0.03, 0.03, 0.058];
/**
 * With none of those supported, these closer-spaced checks along the straight part tell balancing
 * on a bump between them (standing) from touching something only with an end cap, like the face of
 * a rock it landed against (not standing).
 */
const RESTING_CHECKS = Array.from({ length: 11 }, (_, i) => -0.05 + i * 0.01);
/**
 * Climbing: walking into something whose top is between CLIMB_MIN and CLIMB_MAX above the feet
 * (the log, the mid rock; autostep handles lower), with room to lie on top, scrambles up onto it.
 * Landing short with only the front of the body on a rim pulls up onto it the same way. The rim is
 * the first top found stepping out from the centre to CLIMB_SCAN.
 */
const CLIMB_MIN = 0.015;
const CLIMB_MAX = 0.075;
/** A front-only perch can pull up onto a top this far below the body's feet height. */
const PERCH_DROP = 0.03;
const CLIMB_SCAN = 0.12;
/** How far past the face the climb carries the centre, so the hind feet end up on top too. */
const CLIMB_OVER = 0.03;
/** How much further onto a domed top the climb may go looking for room to lie down (m). */
const CLIMB_ONTO_DOME = 0.06;
/** How far above a domed top the body may end the climb, to settle down onto it (m). */
const CLIMB_LIFT = 0.016;
/** Climb time: a base plus this much per metre of height. */
const CLIMB_BASE_TIME = 0.2;
const CLIMB_TIME_PER_M = 6;

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

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
  /** Turn input this step, -1 (left) to 1 (right); the visual turns the head into it. */
  turning = 0;
  /** True when the body itself turned this step (only while moving forward or back, or swimming). */
  bodyTurning = false;
  /** Swimming: the whole body went under water and hasn't stood up out of it since. */
  swimming = false;
  /** Swimming pitch (radians, positive raises the snout): Space tilts the lizard up for a moment. */
  swimPitch = 0;
  prevSwimPitch = 0;

  /** The climb in progress. */
  private climb: { from: THREE.Vector3; to: THREE.Vector3; t: number; duration: number; top: number } | null = null;
  /** Forward input last step was mostly stopped by something ahead. */
  private blockedAhead = false;
  private vy = 0;
  private sinceGrounded = Infinity;
  private sinceJumpPressed = Infinity;
  private jumpHeld = false;
  private jumping = false;
  /** Seconds left of the upward tilt Space started while swimming. */
  private tiltTimer = 0;
  /**
   * Swimming velocity the stroke is aiming for (m/s), eased by drag. Kept apart from the velocity
   * achieved: pressed against the sloping bed most of each stroke is absorbed, and easing from
   * what got through would never build up enough speed to glide up and out.
   */
  private swim = new THREE.Vector3();
  private desired = new THREE.Vector3();
  /** Movement handed over by whatever the lizard stands on (the tortoise's shell), applied next step. */
  private carried = { x: 0, y: 0, z: 0, yaw: 0 };
  /** Carried this step: riding something that moves. */
  private riding = false;
  /** Ground speed multiplier from what the lizard is pushing through (vegetation); 1 in the open. */
  speedScale = 1;
  private world: RAPIER.World;
  private rot = new THREE.Quaternion();
  private supportRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
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
    this.prevSwimPitch = this.swimPitch;
    this.landed = this.jumped = false;
    this.applyCarry();
    if (this.climb) {
      this.stepClimb(dt);
      return;
    }
    // Walked or fell in deep enough to be wholly under: swim.
    if (this.swimming || this.submerged() > 0) {
      if (!this.swimming) {
        this.swimming = true;
        this.jumping = false;
        this.tiltTimer = 0;
        this.swim.copy(this.velocity);
        // Snapping down onto the bed would drop a sinking swimmer the last centimetre at once.
        this.kcc.disableSnapToGround();
      }
      this.stepSwim(dt, input);
      return;
    }

    // Turn: right input turns right, which is clockwise seen from above (yaw decreasing). The body
    // only turns while moving forward or back; standing still, left/right just turns the head.
    this.turn(dt, input.move.x, input.move.y !== 0);

    // Horizontal: accelerate toward forward/back input along the facing.
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const forward = input.move.y;
    const speed = (forward < 0 ? M.backSpeed : input.run ? M.runSpeed : M.walkSpeed) * this.speedScale;
    const tx = forward * fx * speed;
    const tz = forward * fz * speed;
    const hasInput = forward !== 0;
    // Balanced on one end of the body over a rim isn't standing: it tips off, unless it climbs.
    // Nothing under the body at all (landed leaning on a steep face by the snout or tail) isn't
    // standing either: gravity takes it, so it slides off the face instead of hanging there.
    const support = this.grounded ? this.overhang(fx, fz) : 0;
    const tip = support ?? 0;
    const standing = this.grounded;
    if (support !== 0) this.grounded = false;
    // Front-only support (landed short) pulls up, unless backing away.
    const perched = tip === -1 && forward >= 0;
    if (((forward > 0 && standing && this.blockedAhead) || perched) && this.startClimb(fx, fz, perched)) {
      this.stepClimb(dt);
      return;
    }
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
    if (tip !== 0 && (vx * fx + vz * fz) * tip < TIP_SPEED) {
      const add = TIP_SPEED * tip - (vx * fx + vz * fz);
      vx += add * fx;
      vz += add * fz;
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
    // (The controller keeps its skin off a sloping face by lifting a few microns while it slides, so
    // a lift that small still counts as creeping down, not climbing.)
    if (this.grounded && wasGrounded && !hasInput) {
      if (this.riding) {
        // Riding something that rises and falls under it, like the tortoise's shell, the controller
        // lifts it back off the surface as it comes up, by up to half a millimetre a step. Keep that
        // lift, but hold on where it stands rather than sliding with it.
        if (Math.hypot(moved.x, moved.z) < M.gripCreep * dt) moved.x = moved.z = 0;
      } else if (moved.y <= GRIP_LIFT && Math.hypot(moved.x, moved.y, moved.z) < M.gripCreep * dt) {
        moved.x = moved.y = moved.z = 0;
      }
    }

    // Sliding down a rounded side (coming off the log) turns the drop into sideways motion, several
    // times walking speed. Never move sideways faster than the speed asked for.
    const sideways = Math.hypot(moved.x, moved.z);
    const allowed = Math.max(Math.hypot(vx, vz), TIP_SPEED) * dt;
    if (sideways > allowed) {
      moved.x *= allowed / sideways;
      moved.z *= allowed / sideways;
    }

    // Blocked going up (a ceiling): stop vertical speed so it doesn't build up. Grazing a rounded
    // side (the underside of a log against the snout) only slows the rise, so that keeps the jump.
    if (this.vy > 0 && moved.y < this.desired.y * 0.25) this.vy = 0;
    this.position.x += moved.x;
    this.position.y += moved.y;
    this.position.z += moved.z;
    this.body.setNextKinematicTranslation(this.position);
    const wanted = this.desired.x * fx + this.desired.z * fz;
    this.blockedAhead = forward > 0 && wanted > 0 && moved.x * fx + moved.z * fz < wanted * 0.3;

    // Keep the velocity actually achieved, so walls absorb momentum instead of storing it.
    this.velocity.set(moved.x / dt, this.vy, moved.z / dt);
    if (this.grounded) this.velocity.y = moved.y / dt;

    if (this.grounded && !wasGrounded && this.airTime > 0.05) this.landed = true;
    this.airTime = this.grounded ? 0 : this.airTime + dt;
  }

  /**
   * Ride along with what the lizard is standing on: move it by (dx, dy, dz) and turn it by `dyaw`
   * at the start of the next step. The ride isn't the lizard's own motion, so it never shows in its
   * velocity (and so its gait): standing still on a walking tortoise, it idles.
   */
  carry(dx: number, dy: number, dz: number, dyaw: number) {
    this.carried.x += dx;
    this.carried.y += dy;
    this.carried.z += dz;
    this.carried.yaw += dyaw;
  }

  private applyCarry() {
    const c = this.carried;
    this.riding = c.x !== 0 || c.y !== 0 || c.z !== 0 || c.yaw !== 0;
    if (!this.riding) return;
    this.position.x += c.x;
    this.position.y += c.y;
    this.position.z += c.z;
    this.yaw += c.yaw;
    this.body.setTranslation(this.position, true);
    this.body.setRotation(this.bodyRotation(this.yaw), true);
    c.x = c.y = c.z = c.yaw = 0;
  }

  /** How far the top of the body is under the water surface (m); negative when any of it is out. */
  private submerged(): number {
    return waterDepth({ x: this.position.x, y: this.position.y + M.bodyRadius, z: this.position.z });
  }

  /**
   * Turn by `input` (-1..1, right +) if `allowed`. The body is long, so a turn that would swing it
   * into a rock or log is refused.
   */
  private turn(dt: number, input: number, allowed: boolean) {
    this.turning = input;
    this.bodyTurning = false;
    if (input !== 0 && allowed) {
      const yaw = Math.atan2(Math.sin(this.yaw - input * M.turnRate * dt), Math.cos(this.yaw - input * M.turnRate * dt));
      const blocked = this.world.intersectionWithShape(
        this.position,
        this.bodyRotation(yaw),
        this.collider.shape,
        undefined,
        IGNORE_STEMS,
        undefined,
        this.body,
        this.turnBlocker,
      );
      if (!blocked) {
        this.yaw = yaw;
        this.bodyTurning = true;
      }
    }
    this.body.setNextKinematicRotation(this.bodyRotation(this.yaw));
  }

  /**
   * Swimming: no gravity or jumps. Forward and back drive the lizard along its facing, left and
   * right turn it even when it isn't moving, and water drag eases every change. Left alone it sinks
   * slowly; Space tilts it snout-up for a second, rising (faster when also swimming forward). The
   * top of the body never breaks the surface, and rocks and the bed still block it. It stops
   * swimming by standing up out of the water on the shore, or by climbing out onto a rock.
   */
  private stepSwim(dt: number, input: InputState) {
    this.turn(dt, input.move.x, true);
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const forward = input.move.y;

    // Climbing only gets it out of the water: onto a top where its back would be out.
    const outOfWater = WATER_Y + M.swimExitMargin - centreAboveFeet() - M.bodyRadius;
    if (forward > 0 && this.blockedAhead && this.startClimb(fx, fz, false, outOfWater)) {
      this.stopSwimming();
      this.stepClimb(dt);
      return;
    }

    const jumpPressed = input.jump && !this.jumpHeld;
    this.jumpHeld = input.jump;
    if (jumpPressed) this.tiltTimer = M.swimTiltTime;
    this.tiltTimer = Math.max(0, this.tiltTimer - dt);
    const tiltGoal = this.tiltTimer > 0 ? M.swimTilt : 0;
    this.swimPitch += (tiltGoal - this.swimPitch) * (1 - Math.exp(-M.swimTiltRate * dt));
    const up = this.swimPitch / M.swimTilt;

    const speed = forward < 0 ? M.swimBackSpeed : input.run ? M.swimFastSpeed : M.swimSpeed;
    const along = forward * speed;
    const horizontal = along * Math.cos(this.swimPitch);
    const rise = -M.sinkSpeed + (M.swimRiseSpeed + M.sinkSpeed) * up + Math.max(0, along) * Math.sin(this.swimPitch);
    const drag = 1 - Math.exp(-M.swimDrag * dt);
    this.swim.x += (horizontal * fx - this.swim.x) * drag;
    this.swim.z += (horizontal * fz - this.swim.z) * drag;
    this.vy += (rise - this.vy) * (1 - Math.exp(-M.swimVerticalDrag * dt));

    this.desired.set(this.swim.x * dt, this.vy * dt, this.swim.z * dt);
    // The back stays just under the surface.
    const ceiling = WATER_Y - M.bodyRadius - this.position.y;
    if (this.desired.y > ceiling) {
      this.desired.y = Math.min(this.desired.y, Math.max(0, ceiling));
      this.vy = Math.min(this.vy, 0);
    }
    this.kcc.computeColliderMovement(this.collider, this.desired);
    const moved = this.kcc.computedMovement();
    // Rapier counts ground a centimetre or two below as grounded; drifting down freely isn't.
    this.grounded = this.kcc.computedGrounded() && this.desired.y <= 0 && moved.y > this.desired.y + 1e-5;
    // Gliding down the bed, the controller can carry the body further than asked. Never move
    // sideways faster than the stroke.
    const sideways = Math.hypot(moved.x, moved.z);
    const allowed = Math.hypot(this.desired.x, this.desired.z);
    if (sideways > allowed) {
      moved.x *= allowed / sideways;
      moved.z *= allowed / sideways;
    }
    if (this.vy > 0 && moved.y < this.desired.y * 0.25) this.vy = 0;
    this.position.x += moved.x;
    this.position.y += moved.y;
    this.position.z += moved.z;
    this.body.setNextKinematicTranslation(this.position);
    const wanted = this.desired.x * fx + this.desired.z * fz;
    this.blockedAhead = forward > 0 && wanted > 0 && moved.x * fx + moved.z * fz < wanted * 0.3;
    this.velocity.set(moved.x / dt, this.vy, moved.z / dt);
    this.airTime = 0;

    // Swum up the shore far enough to stand with its back out of the water: walking again.
    if (this.grounded && this.submerged() < -M.swimExitMargin) this.stopSwimming();
  }

  private stopSwimming() {
    this.swimming = false;
    this.swimPitch = this.tiltTimer = this.vy = 0;
    this.kcc.enableSnapToGround(M.snapToGround);
  }

  /** Climbing in progress: the visual bends the body up over the rim. */
  get climbing(): boolean {
    return this.climb !== null;
  }

  /** Height of the top being climbed onto, while climbing. */
  get climbTop(): number | null {
    return this.climb?.top ?? null;
  }

  /** Start a climb onto what's ahead if it's the right height, no lower than `minTop`, and there's room on top. */
  private startClimb(fx: number, fz: number, perched: boolean, minTop = -Infinity): boolean {
    const feetY = this.position.y - centreAboveFeet();
    const from = feetY + CLIMB_MAX + 0.005;
    const lowest = perched ? feetY - PERCH_DROP : feetY + CLIMB_MIN;
    const topAt = (s: number) => {
      this.supportRay.origin = { x: this.position.x + fx * s, y: from, z: this.position.z + fz * s };
      const hit = this.world.castRay(this.supportRay, from - lowest, true, undefined, IGNORE_STEMS, undefined, this.body);
      // A ray that starts inside something means its top is out of reach.
      return hit && hit.timeOfImpact > 1e-4 ? from - hit.timeOfImpact : null;
    };
    let rim = -1;
    for (let s = 0.02; s <= CLIMB_SCAN && rim < 0; s += 0.01) if (topAt(s) !== null) rim = s;
    if (rim < 0) return false;
    // The body ends up with its hind feet past the rim, lying on the top found there. A domed top
    // (a boulder's crown) has no flat spot right past the rim for the straight body to lie on, so
    // it goes on further up the dome and rests a little higher, over the rise, and settles from there.
    const to = new THREE.Vector3();
    let top: number | null = null;
    search: for (let over = rim + CLIMB_OVER; over <= rim + CLIMB_OVER + CLIMB_ONTO_DOME + 1e-6; over += 0.01) {
      const at = topAt(over);
      if (at === null) break;
      if (at < minTop) continue;
      for (let lift = 0.001; lift <= CLIMB_LIFT + 1e-6; lift += 0.003) {
        to.set(this.position.x + fx * over, at + centreAboveFeet() + lift, this.position.z + fz * over);
        if (!this.world.intersectionWithShape(to, this.bodyRotation(this.yaw), this.collider.shape, undefined, undefined, undefined, this.body)) {
          top = at;
          break search;
        }
      }
    }
    if (top === null) return false;
    const height = Math.abs(top - feetY);
    this.climb = { from: this.position.clone(), to, t: 0, duration: CLIMB_BASE_TIME + CLIMB_TIME_PER_M * height, top };
    this.vy = 0;
    this.jumping = false;
    return true;
  }

  /**
   * Follow the climb path: up and over together, the rise finishing a little early so the body
   * clears the rim. The capsule cuts the corner, but nothing else moves into the space it passes.
   */
  private stepClimb(dt: number) {
    const c = this.climb!;
    c.t = Math.min(1, c.t + dt / c.duration);
    const rise = smooth(c.t / 0.75);
    const over = smooth(c.t);
    this.position.set(
      c.from.x + (c.to.x - c.from.x) * over,
      c.from.y + (c.to.y - c.from.y) * rise,
      c.from.z + (c.to.z - c.from.z) * over,
    );
    this.body.setNextKinematicTranslation(this.position);
    this.velocity.subVectors(this.position, this.prevPosition).divideScalar(dt);
    this.grounded = true;
    this.airTime = 0;
    this.turning = 0;
    this.bodyTurning = false;
    if (c.t >= 1) {
      this.climb = null;
      this.blockedAhead = false;
    }
  }

  /**
   * Which way to slide when balanced on one end: +1 (forward) when only the rear is supported, -1
   * when only the front is, 0 when the centre or both ends are supported, null when nothing under
   * the body is (the capsule is only touching something with an end or a side).
   */
  private overhang(fx: number, fz: number): number | null {
    const reach = M.bodyRadius + M.skin + SUPPORT_REACH;
    const supported = (s: number) => {
      this.supportRay.origin = { x: this.position.x + fx * s, y: this.position.y, z: this.position.z + fz * s };
      return this.world.castRay(this.supportRay, reach, true, undefined, IGNORE_STEMS, undefined, this.body) !== null;
    };
    if (supported(0)) return 0;
    let side = 0;
    let ends = 0;
    for (const s of SUPPORT_CHECKS) {
      if (supported(s)) {
        side += Math.sign(s);
        ends++;
      }
    }
    if (side !== 0) return -Math.sign(side);
    return ends > 0 || RESTING_CHECKS.some(supported) ? 0 : null;
  }

  /** Feet position for rendering, interpolated between the last two steps. */
  feetAt(alpha: number, out: THREE.Vector3): THREE.Vector3 {
    out.lerpVectors(this.prevPosition, this.position, alpha);
    out.y -= centreAboveFeet();
    return out;
  }

  swimPitchAt(alpha: number): number {
    return this.prevSwimPitch + (this.swimPitch - this.prevSwimPitch) * alpha;
  }

  yawAt(alpha: number): number {
    const diff = Math.atan2(Math.sin(this.yaw - this.prevYaw), Math.cos(this.yaw - this.prevYaw));
    return this.prevYaw + diff * alpha;
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /**
   * Something big walked into the lizard: slide it (dx, dz) along the ground, stopping at anything
   * solid except `pusher` itself and plant stems. Returns how far it actually went (m).
   */
  shove(dx: number, dz: number, pusher: RAPIER.Collider): number {
    this.desired.set(dx, 0, dz);
    this.kcc.computeColliderMovement(this.collider, this.desired, undefined, IGNORE_STEMS, (c) => c.handle !== pusher.handle);
    const m = this.kcc.computedMovement();
    this.position.x += m.x;
    this.position.z += m.z;
    this.body.setTranslation(this.position, true);
    return Math.hypot(m.x, m.z);
  }

  /** Teleport (tests and respawn). */
  setFeet(feet: THREE.Vector3, yaw = this.yaw) {
    this.position.copy(feet).y += centreAboveFeet();
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.vy = 0;
    this.climb = null;
    this.blockedAhead = false;
    this.stopSwimming();
    this.prevSwimPitch = 0;
    this.yaw = this.prevYaw = yaw;
    this.body.setTranslation(this.position, true);
    this.body.setRotation(this.bodyRotation(yaw), true);
  }

  private bodyRotation(yaw: number): THREE.Quaternion {
    return this.rot.setFromAxisAngle(UP, yaw).multiply(LAY);
  }
}
