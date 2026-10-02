/**
 * Every movement tuning number in one place (metres, seconds, radians). Starting values from the
 * plan; the feel pass tunes them live and writes the chosen ones back here.
 */
export const MOVEMENT = {
  walkSpeed: 0.25,
  runSpeed: 0.6,
  /** Backing up is slower and never runs. */
  backSpeed: 0.15,
  /** Speeding up on the ground (m/s²). */
  groundAccel: 3,
  /** Slowing down on the ground with no input (m/s²); higher than accel so stops feel planted. */
  groundDecel: 6,
  /** Steering in the air (m/s²). */
  airAccel: 1.2,
  /** Standing still, slower drift than this (m/s) is cancelled so the lizard grips edges. */
  gripCreep: 0.05,
  /** Turning speed at full left/right input. */
  turnRate: (200 * Math.PI) / 180,

  jumpHeight: 0.08,
  gravity: 9.81,
  /** Gravity multiplier while falling, for a snappier arc. */
  fallGravityScale: 1.6,
  /** Gravity multiplier while still rising after jump is released: short taps give short hops. */
  jumpCutGravityScale: 3,
  maxFallSpeed: 3,
  /** Jump still allowed this long after walking off an edge. */
  coyoteTime: 0.1,
  /** A jump pressed this long before landing still fires on touchdown. */
  jumpBuffer: 0.1,

  /**
   * The body collider is a capsule lying along the lizard, snout to hips (the thin tail tip is left
   * out), so the head can't push into rocks and logs and the body rests across them like the real
   * thing. It turns with the lizard.
   */
  bodyRadius: 0.012,
  bodyHalfLength: 0.048,
  /**
   * Gap the controller keeps between the capsule and everything else. Rapier's controller snags on
   * heightfield triangle edges at lizard scale when this is small: with the original upright
   * capsule, a stress run of 2000 random 80-step runs stalled 16/300 times at 2 mm, 8/2000 at 6 mm
   * and 0/2000 at 8 mm. The lying body capsule ran 77 random walks and runs at 8 mm with no snags.
   */
  skin: 0.008,
  maxSlopeClimb: (45 * Math.PI) / 180,
  minSlopeSlide: (50 * Math.PI) / 180,
  stepHeight: 0.02,
  stepMinWidth: 0.01,
  snapToGround: 0.01,
};

/** Height of the capsule centre above the feet, including the skin gap. */
export const centreAboveFeet = () => MOVEMENT.bodyRadius + MOVEMENT.skin;
