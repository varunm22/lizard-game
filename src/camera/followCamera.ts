import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { InputState } from '../input';
import { EDGE_WALL_GROUP, PLANT_STEM_GROUP, terrainHeight } from '../world/terrain';

const CAM = {
  /** Look-at point above the lizard's feet (m). */
  targetHeight: 0.03,
  distance: 0.38,
  minDistance: 0.15,
  maxDistance: 1.2,
  pitch: 0.28,
  minPitch: -0.15,
  maxPitch: 1.25,
  /** Radius of the sphere swept along the arm, so the near plane never grazes a surface. */
  probeRadius: 0.012,
  /** Closest the arm can be pulled in (m). */
  minArm: 0.05,
  /** How fast the arm grows back after an obstacle clears (per second, exponential). */
  armReturnRate: 4,
  /** How fast the look-at point catches up vertically (per second); horizontal is locked on. */
  verticalFollowRate: 10,
  /** Catch-up rate when the lizard drops below the height it left the ground at (per second). */
  fallFollowRate: 20,
  /** How fast the camera swings back behind the lizard while it is steered (per second). */
  recenterRate: 4,
  /** Recentring carries on this long after steering stops, so the camera settles behind (s). */
  recenterLinger: 1,
  /** Manual orbit holds the camera where it was put for this long before recentring resumes (s). */
  recenterDelay: 1.5,
  /** Never closer than this to the ground directly under the camera. */
  groundClearance: 0.012,
};

/**
 * Third-person orbit camera with a spring arm: mouse or right stick orbit, wheel zoom, and a
 * sphere cast from the lizard back to the camera that pulls the camera in before terrain can get
 * between them. Obstacles don't pull it in; `OccluderFade` turns them translucent instead. It swings
 * back behind the lizard while the lizard is steered, and holds its height through jumps.
 */
export class FollowCamera {
  /** Yaw the camera looks along (0 looks toward +Z). Movement input is relative to this. */
  yaw = 0;
  pitch = CAM.pitch;
  distance = CAM.distance;
  /** Current arm length after collision pull-in. */
  arm = CAM.distance;
  readonly target = new THREE.Vector3();
  private probe = new RAPIER.Ball(CAM.probeRadius);
  private dir = new THREE.Vector3();
  private initialised = false;
  private sinceLook = Infinity;
  private sinceSteer = Infinity;
  /** Feet height at the last grounded frame; the camera doesn't rise with jumps above it. */
  private groundY = 0;
  private skip: (c: RAPIER.Collider) => boolean;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private world: RAPIER.World,
    private ignoreBody: RAPIER.RigidBody,
    /** Collider handles the arm passes through (obstacles, which fade instead). */
    passThrough: Set<number>,
  ) {
    this.skip = (c) => !passThrough.has(c.handle);
  }

  applyInput(input: InputState) {
    if (input.look.yaw || input.look.pitch) this.sinceLook = 0;
    this.yaw -= input.look.yaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch - input.look.pitch, CAM.minPitch, CAM.maxPitch);
    this.distance = THREE.MathUtils.clamp(this.distance * Math.pow(1.12, input.zoom), CAM.minDistance, CAM.maxDistance);
  }

  /**
   * `facingYaw` is where the lizard faces; `steering` is true while it is being turned or moved, which
   * swings the camera back behind it unless the player orbited recently.
   */
  /**
   * `feet` is the interpolated position drawn this frame; `groundedFeetY` is the feet height from the
   * latest physics step when that step was on the ground, else null. (The interpolated position can
   * still be partway down from the air on the step that lands, which would lift the camera.)
   */
  update(feet: THREE.Vector3, groundedFeetY: number | null, facingYaw: number, steering: boolean, dt: number) {
    this.sinceLook += dt;
    this.sinceSteer = steering ? 0 : this.sinceSteer + dt;
    if (this.sinceSteer < CAM.recenterLinger && this.sinceLook > CAM.recenterDelay) {
      const diff = Math.atan2(Math.sin(facingYaw - this.yaw), Math.cos(facingYaw - this.yaw));
      this.yaw += diff * (1 - Math.exp(-CAM.recenterRate * dt));
    }

    // Track the ground the lizard stands on, not its jumps: rising with every hop and then easing
    // back down after landing makes the whole view drift and the jump look floaty.
    if (groundedFeetY !== null) this.groundY = groundedFeetY;
    else if (!this.initialised) this.groundY = feet.y;
    const falling = feet.y < this.groundY;
    const goalY = Math.min(feet.y, this.groundY) + CAM.targetHeight;
    if (!this.initialised) {
      this.target.set(feet.x, goalY, feet.z);
      this.initialised = true;
    } else {
      this.target.x = feet.x;
      this.target.z = feet.z;
      const rate = falling ? CAM.fallFollowRate : CAM.verticalFollowRate;
      this.target.y += (goalY - this.target.y) * (1 - Math.exp(-rate * dt));
    }

    // Direction from the camera toward the target.
    const cp = Math.cos(this.pitch);
    this.dir.set(cp * Math.sin(this.yaw), -Math.sin(this.pitch), cp * Math.cos(this.yaw));

    // Sweep a small sphere from the target back along the arm; stop short of the first hit.
    let allowed = this.distance;
    const hit = this.world.castShape(
      this.target,
      { x: 0, y: 0, z: 0, w: 1 },
      { x: -this.dir.x, y: -this.dir.y, z: -this.dir.z },
      this.probe,
      0,
      this.distance,
      true,
      undefined,
      (0xffff << 16) | (0xffff & ~EDGE_WALL_GROUP & ~PLANT_STEM_GROUP),
      undefined,
      this.ignoreBody,
      this.skip,
    );
    if (hit) allowed = Math.max(CAM.minArm, hit.time_of_impact);
    // Pull in instantly, ease back out.
    this.arm = allowed < this.arm ? allowed : this.arm + (allowed - this.arm) * (1 - Math.exp(-CAM.armReturnRate * dt));

    const pos = this.camera.position.copy(this.target).addScaledVector(this.dir, -this.arm);
    pos.y = Math.max(pos.y, terrainHeight(pos.x, pos.z) + CAM.groundClearance);
    this.camera.lookAt(this.target);
  }
}
