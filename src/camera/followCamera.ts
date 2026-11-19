import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { wrapAngle } from '../math/angles';
import type { InputState } from '../input';
import { EDGE_WALL_GROUP, IGUANA_GROUP, PLANT_STEM_GROUP, terrainHeight } from '../world/terrain';

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
  /** How fast a `SoftArm` camera rises over a block behind the lizard, or settles back (per second). */
  liftRate: 3,
};
/** Steeper pitches (radians, added) a `SoftArm` camera tries when its arm is cut short. */
const LIFTS = [0, 0.25, 0.5];
/** A `SoftArm` camera only tries rising while its arm is shorter than this share of its distance. */
const LIFT_BELOW = 0.45;

/**
 * An optional wider sweep that leads the hard one, for enclosed stages: the arm eases in to what it
 * allows before the thin sweep would snap it, so lumps on a tube wall ease the camera in and out
 * instead of jerking it. Tuning: sphere radius (m), and ease rates in and out (per second).
 */
export interface SoftArm {
  radius: number;
  inRate: number;
  outRate: number;
}
/** A shake when the lizard is struck: strength (radians), how long it lasts (s) and how fast it shakes (Hz). */
const SHAKE = { strength: 0.035, time: 0.35, rate: 18 };

/**
 * Third-person orbit camera with a spring arm: mouse or right stick orbit, wheel zoom, and a
 * sphere cast from the lizard back to the camera that pulls the camera in before terrain can get
 * between them. Obstacles don't pull it in; `OccluderFade` turns them translucent instead. With a
 * `SoftArm` (the tunnels) a wider sweep leads the thin one so the arm eases along a rough tube. Nor do
 * the other iguanas, which are small enough to see past. It swings back behind the lizard while the lizard is steered, and holds its height through jumps.
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
  private from = new THREE.Vector3();
  private initialised = false;
  private sinceLook = Infinity;
  private sinceSteer = Infinity;
  /** Feet height at the last grounded frame; the camera doesn't rise with jumps above it. */
  private groundY = 0;
  private skip: (c: RAPIER.Collider) => boolean;
  private softProbe: RAPIER.Ball | null;
  /** Extra pitch (radians) the soft arm has eased in to look over a block behind the lizard. */
  lift = 0;
  /** A shake under way: its strength (radians) and how long it has run (s). */
  private shaking = { strength: 0, t: Infinity };

  constructor(
    private camera: THREE.PerspectiveCamera,
    private world: RAPIER.World,
    private ignoreBody: RAPIER.RigidBody,
    /** Collider handles the arm passes through (obstacles, which fade instead). */
    passThrough: Set<number>,
    private soft: SoftArm | null = null,
  ) {
    this.skip = (c) => !passThrough.has(c.handle);
    this.softProbe = soft ? new RAPIER.Ball(soft.radius) : null;
  }

  /** Jolt the view, as when the lizard is struck: a quick shake that dies away. */
  shake(strength = SHAKE.strength) {
    this.shaking = { strength, t: 0 };
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
      const diff = wrapAngle(facingYaw - this.yaw);
      this.yaw += diff * (1 - Math.exp(-CAM.recenterRate * dt));
    }

    // Track the ground the lizard stands on, not its jumps: rising with every hop and then easing
    // back down after landing makes the whole view drift and the jump look floaty.
    if (groundedFeetY !== null) this.groundY = groundedFeetY;
    else if (!this.initialised) this.groundY = feet.y;
    const first = !this.initialised;
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

    if (this.soft && this.softProbe) {
      // Enclosed (the tunnels): a wider sphere leads the thin one. When a block behind the lizard
      // would bring the arm right up to it, the camera rises to look over the block instead, if a
      // steeper arm reaches further. Both the lift and the arm ease, so lumps never jerk the view.
      // Start the wide sphere just clear of the floor under the lizard, barely above the thin one's path.
      const raise = Math.max(0, this.soft.radius - CAM.targetHeight + 0.004);
      let lift = 0;
      let best = -1;
      for (const candidate of LIFTS) {
        this.aim(this.pitch + candidate);
        const reach = this.sweep(this.softProbe, raise);
        // Only rise when the arm is badly cut short, and only for a much longer arm: in a tube the
        // walls cut it a little anyway, and a camera that climbs for that just looks at the floor.
        if (best < 0 || reach > best * 1.6) {
          best = reach;
          lift = candidate;
        }
        if (best > this.distance * LIFT_BELOW) break;
      }
      this.lift = first ? lift : this.lift + (lift - this.lift) * (1 - Math.exp(-CAM.liftRate * dt));
      this.aim(this.pitch + this.lift);
      const lead = this.sweep(this.softProbe, raise);
      const rate = lead < this.arm ? this.soft.inRate : this.soft.outRate;
      this.arm = first ? lead : this.arm + (lead - this.arm) * (1 - Math.exp(-rate * dt));
      // Only the thin sweep cuts the arm short at once: a wall closer than the ease has reached yet.
      this.arm = Math.min(this.arm, this.sweep(this.probe));
    } else {
      this.aim(this.pitch);
      // Sweep a small sphere from the target back along the arm; stop short of the first hit.
      const allowed = this.sweep(this.probe);
      // Pull in instantly, ease back out.
      this.arm = allowed < this.arm ? allowed : this.arm + (allowed - this.arm) * (1 - Math.exp(-CAM.armReturnRate * dt));
    }

    const pos = this.camera.position.copy(this.target).addScaledVector(this.dir, -this.arm);
    pos.y = Math.max(pos.y, terrainHeight(pos.x, pos.z) + CAM.groundClearance);
    this.camera.lookAt(this.target);

    // Shake by turning the view, not moving it, so it can't push the camera into anything.
    if (this.shaking.t < SHAKE.time) {
      const t = this.shaking.t;
      const a = this.shaking.strength * (1 - t / SHAKE.time) ** 2;
      const w = 2 * Math.PI * SHAKE.rate * t;
      this.camera.rotateX(a * Math.sin(w));
      this.camera.rotateY(a * 0.7 * Math.sin(1.37 * w + 1));
      this.shaking.t += dt;
    }
  }

  /** Point `dir` from the camera toward the target, at this pitch. */
  private aim(pitch: number) {
    const cp = Math.cos(pitch);
    this.dir.set(cp * Math.sin(this.yaw), -Math.sin(pitch), cp * Math.cos(this.yaw));
  }

  /**
   * How far back along the arm a sphere swept from the target gets before it hits something. A
   * wide sphere starts `raise` above the target, clear of the floor under the lizard (one already
   * touching something stops dead).
   */
  private sweep(probe: RAPIER.Ball, raise = 0) {
    this.from.copy(this.target).y += raise;
    const hit = this.world.castShape(
      this.from,
      { x: 0, y: 0, z: 0, w: 1 },
      { x: -this.dir.x, y: -this.dir.y, z: -this.dir.z },
      probe,
      0,
      this.distance,
      true,
      undefined,
      // The other iguanas don't pull it in either: one passing behind the lizard would snap the
      // camera right up to the lizard's back and out again.
      (0xffff << 16) | (0xffff & ~EDGE_WALL_GROUP & ~PLANT_STEM_GROUP & ~IGUANA_GROUP),
      undefined,
      this.ignoreBody,
      this.skip,
    );
    return hit ? Math.max(CAM.minArm, hit.time_of_impact) : this.distance;
  }
}
