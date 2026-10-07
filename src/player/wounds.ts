import type { PlayerController } from './controller';
import type { LizardModel } from './lizardModel';

/** Strikes it takes to knock the lizard down. */
export const MAX_HITS = 3;
/** A strike throws the lizard this far sideways (m), over this long (s), fast at first and easing off. */
const JERK = 0.08;
const JERK_TIME = 0.14;
/** Knocked down, it collapses for this long, then lies still while a countdown runs (s). */
const COLLAPSE_TIME = 1.0;
export const COUNTDOWN = 3;
/** With nothing hunting it, one hit heals every this many seconds. */
const HEAL_EVERY = 1;

/**
 * What the hawk does to the lizard. A strike that lands jerks it aside, with a flinch toward the side
 * it was hit on, and counts a hit; the third knocks it down: it rolls onto its side and lies still
 * while a countdown runs, then comes back at the spawn with no hits. Hits heal quickly once nothing
 * is hunting it (the hawk sets `hunted`).
 */
export class Wounds {
  hits = 0;
  /** A hawk is after the lizard right now. */
  hunted = false;
  /** Seconds left lying down before coming back, or null while up. */
  private downFor: number | null = null;
  private jerk = { x: 0, z: 0, t: 0 };
  private healing = 0;
  /** Called when a strike lands, with the side of the lizard it came from and the way it's thrown (unit, level). */
  onStrike: ((side: 'left' | 'right', dx: number, dz: number) => void) | null = null;

  constructor(
    private player: PlayerController,
    private model: LizardModel,
    private respawn: () => void,
  ) {}

  /** Knocked down: lying on its side, out of the player's control. */
  get down(): boolean {
    return this.downFor !== null;
  }

  /** Whole seconds left on the countdown while it lies there, or null. */
  get countdown(): number | null {
    return this.downFor !== null && this.downFor <= COUNTDOWN ? Math.ceil(this.downFor) : null;
  }

  /**
   * Struck by something travelling along (dx, dz): thrown to whichever side of the lizard that
   * points, flinching toward the side it came from. Returns false if it was already down.
   */
  strike(dx: number, dz: number): boolean {
    if (this.down) return false;
    const yaw = this.player.yaw;
    // The lizard's left, with +Z forward at yaw 0.
    const lx = Math.cos(yaw);
    const lz = -Math.sin(yaw);
    const side = dx * lx + dz * lz >= 0 ? 1 : -1;
    this.jerk = { x: lx * side * JERK, z: lz * side * JERK, t: JERK_TIME };
    this.model.flinch(side > 0 ? 'right' : 'left');
    this.onStrike?.(side > 0 ? 'right' : 'left', lx * side, lz * side);
    this.healing = 0;
    if (++this.hits >= MAX_HITS) this.downFor = COLLAPSE_TIME + COUNTDOWN;
    return true;
  }

  /** Advance one fixed step, before the player's own move. */
  step(dt: number) {
    if (this.jerk.t > 0) {
      // Eased out: the share of the throw done by time left t is 1 - (t / JERK_TIME)^2.
      const before = this.jerk.t / JERK_TIME;
      const after = Math.max(0, this.jerk.t - dt) / JERK_TIME;
      const share = before * before - after * after;
      this.player.shove(this.jerk.x * share, this.jerk.z * share, this.player.collider);
      this.jerk.t -= dt;
    }
    if (this.downFor !== null) {
      this.downFor -= dt;
      if (this.downFor <= 0) {
        this.downFor = null;
        this.hits = 0;
        this.jerk.t = 0;
        this.respawn();
      }
      return;
    }
    if (this.hunted || this.hits === 0) {
      this.healing = 0;
      return;
    }
    this.healing += dt;
    if (this.healing >= HEAL_EVERY) {
      this.healing = 0;
      this.hits--;
    }
  }
}
