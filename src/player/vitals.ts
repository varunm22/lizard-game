import type { Climate } from './climate';

/** What brought the lizard down. */
export type DownCause = 'hawk' | 'tortoise' | 'cold' | 'hunger' | 'air';

/**
 * Every vitals tuning number in one place. All four bars run 0 to 1, rates are per second.
 */
export const VITALS = {
  /** A hawk strike takes this much health: two leave it at a fifth, the third puts it down. */
  hawkHit: 0.4,
  /** Trampled by the tortoise, it loses half its health (and is shoved out of the way). */
  trampleHit: 0.5,
  /** On its feet again at the spawn, it starts with these. */
  start: { health: 1, warmth: 0.7, fullness: 0.7, air: 1 },

  /** Health mends at up to this rate (a full bar in 100 s), scaled by how fed and how warm it is. */
  regen: 0.01,
  /** No mending at or below these; full rate at or above the second. */
  regenFed: [0.15, 0.6],
  regenWarm: [0.3, 0.7],
  /** Below this warmth it's freezing, and loses health, faster the colder (at most `coldHurt` at 0). */
  freezing: 0.15,
  coldHurt: 0.012,
  /** Starving (no food left), health goes at this rate. */
  starveHurt: 0.004,
  /** Out of air, health goes at this rate: drowned 12 s after the last breath runs out. */
  drownHurt: 0.08,

  /**
   * Warmth. In the sun on land: a little while moving, `bask` lying still, times what it lies on
   * and the company it keeps. Out of the sun, or in the water, it cools.
   */
  sunMoving: 0.003,
  bask: 0.008,
  shade: 0.003,
  swimming: 0.009,
  diving: 0.014,
  /** Below this warmth it slows down, to `slowest` of its speed when stone cold. */
  slowBelow: 0.5,
  slowest: 0.55,

  /** Fullness empties over 8 minutes idling; running and swimming burn it faster. */
  hunger: 1 / 480,
  runHunger: 1.5,
  swimHunger: 2,
  /** One mouthful of algae (a sixth of a patch). */
  mouthful: 0.06,

  /** Air lasts 25 s under water and comes back in 2 s at the surface. */
  airUse: 1 / 25,
  airBack: 0.5,
};

/** What the lizard is doing, for the step. */
export interface Activity {
  /** Lying still (no input, barely moving). */
  still: boolean;
  running: boolean;
  swimming: boolean;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ramp = (v: number, [a, b]: number[]) => clamp01((v - a) / (b - a));

/**
 * The lizard's health, warmth, fullness and air. Warmth comes from the sun and goes in the shade and
 * the sea; food from algae, burnt over time; air from the surface. Health mends slowly while fed and
 * warm, and drains instead while freezing, starving or out of air; the hawk's strikes take a big
 * share at once. At no health it's down (wounds.ts knocks it over and brings it back).
 */
export class Vitals {
  health = VITALS.start.health;
  warmth = VITALS.start.warmth;
  fullness = VITALS.start.fullness;
  air = VITALS.start.air;
  /** Rates of change last step (per second), for the bars' arrows. */
  readonly rate = { health: 0, warmth: 0 };
  /** Whatever last took health: what put it down if it's at none. */
  cause: DownCause | null = null;
  /** Bars held where they are (tests): strikes still land, nothing drifts. */
  frozen = false;

  /** Ground and swimming speed multiplier from the cold: 1 when warm enough. */
  get speedScale(): number {
    const t = clamp01(this.warmth / VITALS.slowBelow);
    const s = t * t * (3 - 2 * t);
    return VITALS.slowest + (1 - VITALS.slowest) * s;
  }

  get dead(): boolean {
    return this.health <= 0;
  }

  hurt(amount: number, cause: DownCause) {
    this.health = clamp01(this.health - amount);
    this.cause = cause;
  }

  eat(amount = VITALS.mouthful) {
    this.fullness = clamp01(this.fullness + amount);
  }

  reset() {
    Object.assign(this, VITALS.start);
    this.cause = null;
    this.rate.health = this.rate.warmth = 0;
  }

  step(dt: number, c: Climate, a: Activity) {
    if (this.frozen || this.dead) {
      this.rate.health = this.rate.warmth = 0;
      return;
    }
    const V = VITALS;
    let warm: number;
    if (a.swimming || c.wet) warm = -(c.underwater ? V.diving : V.swimming);
    else {
      const sunGain = a.still ? V.bask * c.surface * c.companyScale : V.sunMoving;
      warm = c.sun * sunGain - (1 - c.sun) * V.shade;
    }
    const warmth = this.warmth;
    this.warmth = clamp01(warmth + warm * dt);
    this.rate.warmth = (this.warmth - warmth) / dt;

    const burn = V.hunger * (a.swimming ? V.swimHunger : a.running ? V.runHunger : 1);
    this.fullness = clamp01(this.fullness - burn * dt);

    this.air = clamp01(this.air + (c.underwater ? -V.airUse : V.airBack) * dt);

    let hurt = 0;
    let cause: DownCause | null = null;
    const take = (rate: number, why: DownCause) => {
      if (rate <= 0) return;
      // The worst of what's hurting it gets the blame.
      if (rate > hurt) cause = why;
      hurt += rate;
    };
    take(this.air <= 0 ? V.drownHurt : 0, 'air');
    take(this.warmth < V.freezing ? V.coldHurt * (1 - this.warmth / V.freezing) : 0, 'cold');
    take(this.fullness <= 0 ? V.starveHurt : 0, 'hunger');
    const health = hurt > 0 ? -hurt : V.regen * ramp(this.fullness, V.regenFed) * ramp(this.warmth, V.regenWarm);
    const before = this.health;
    this.health = clamp01(before + health * dt);
    this.rate.health = (this.health - before) / dt;
    if (cause) this.cause = cause;
  }
}
