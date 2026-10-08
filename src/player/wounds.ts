import type RAPIER from '@dimforge/rapier3d-compat';
import type { PlayerController } from './controller';
import type { LizardModel } from './lizardModel';
import { VITALS, type DownCause, type Vitals } from './vitals';

/** A strike throws the lizard this far sideways (m), over this long (s), fast at first and easing off. */
const JERK = 0.08;
const JERK_TIME = 0.14;
/** Trampled, it's shoved clear over this long (s), eased out the same way. */
const TRAMPLE_TIME = 0.25;
/**
 * Knocked down, it lies there this long (s), the countdown running from the moment it falls: the
 * collapse plays in the first second, and the hawk has time to come down and stand over it, feeding.
 */
export const COUNTDOWN = 5;

/**
 * What the hawk and the tortoise do to the lizard, and what happens when its health runs out. A
 * strike that lands jerks it aside, with a flinch toward the side it was hit on, and takes
 * `VITALS.hawkHit` of its health; trampled by the tortoise, it's shoved clear of its path and loses
 * `VITALS.trampleHit`. At no health, whatever took it (the hawk, the cold, hunger, drowning), it rolls onto its
 * side and lies still while a countdown runs, then comes back at the spawn with its vitals reset.
 */
export class Wounds {
  /** Strikes landed since it last came back at the spawn. */
  hits = 0;
  /** A hawk is after the lizard right now. */
  hunted = false;
  /** What put it down, while it's down. */
  downBy: DownCause | null = null;
  /** Seconds left lying down before coming back, or null while up. */
  private downFor: number | null = null;
  private jerk = { x: 0, z: 0, t: 0, time: JERK_TIME, pusher: null as RAPIER.Collider | null };
  /** Called when a strike lands, with the side of the lizard it came from and the way it's thrown (unit, level). */
  onStrike: ((side: 'left' | 'right', dx: number, dz: number) => void) | null = null;
  /** Called when the tortoise tramples it. */
  onTrample: (() => void) | null = null;

  constructor(
    private player: PlayerController,
    private model: LizardModel,
    private vitals: Vitals,
    private respawn: () => void,
  ) {}

  /** Knocked down: lying on its side, out of the player's control. */
  get down(): boolean {
    return this.downFor !== null;
  }

  /** Whole seconds left on the countdown while it lies there, or null. */
  get countdown(): number | null {
    return this.downFor !== null ? Math.ceil(this.downFor) : null;
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
    this.jerk = { x: lx * side * JERK, z: lz * side * JERK, t: JERK_TIME, time: JERK_TIME, pusher: null };
    this.model.flinch(side > 0 ? 'right' : 'left');
    this.onStrike?.(side > 0 ? 'right' : 'left', lx * side, lz * side);
    this.hits++;
    this.vitals.hurt(VITALS.hawkHit, 'hawk');
    this.knockDown();
    return true;
  }

  /**
   * Trampled by the tortoise (whose shell is `by`): shoved (dx, dz) clear of its path, flinching away
   * from it. Returns false if it was already down.
   */
  trample(dx: number, dz: number, by: RAPIER.Collider): boolean {
    if (this.down) return false;
    const yaw = this.player.yaw;
    const left = dx * Math.cos(yaw) - dz * Math.sin(yaw) >= 0;
    this.jerk = { x: dx, z: dz, t: TRAMPLE_TIME, time: TRAMPLE_TIME, pusher: by };
    this.model.flinch(left ? 'right' : 'left');
    this.onTrample?.();
    this.vitals.hurt(VITALS.trampleHit, 'tortoise');
    this.knockDown();
    return true;
  }

  /** At no health, it goes down. */
  private knockDown() {
    if (this.down || !this.vitals.dead) return;
    this.downFor = COUNTDOWN;
    this.downBy = this.vitals.cause ?? 'hawk';
  }

  /** Advance one fixed step, before the player's own move (and after the vitals'). */
  step(dt: number) {
    if (this.jerk.t > 0) {
      // Eased out: the share of the throw done by time left t is 1 - (t / JERK_TIME)^2.
      const before = this.jerk.t / this.jerk.time;
      const after = Math.max(0, this.jerk.t - dt) / this.jerk.time;
      const share = before * before - after * after;
      this.player.shove(this.jerk.x * share, this.jerk.z * share, this.jerk.pusher ?? this.player.collider);
      this.jerk.t -= dt;
    }
    if (this.downFor !== null) {
      this.downFor -= dt;
      if (this.downFor <= 0) {
        this.downFor = null;
        this.downBy = null;
        this.hits = 0;
        this.jerk.t = 0;
        this.vitals.reset();
        this.respawn();
      }
      return;
    }
    this.knockDown();
  }
}
