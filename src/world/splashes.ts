import { MOVEMENT as M, centreAboveFeet } from '../player/movement';
import type { PlayerController } from '../player/controller';
import { nearPond, WATER_Y } from './pond';
import type { Water } from './water';

/** Within this of the surface (m), the swimmer's back counts as touching it. */
const SURFACE_TOUCH = 0.0025;
/** Moving through the surface faster than this (m/s) leaves a trail of small ripples... */
const WAKE_SPEED = 0.03;
/** ...one every this many seconds. */
const WAKE_INTERVAL = 0.3;

/**
 * Turns what the lizard does at the water's surface into ripples: its feet breaking the surface on
 * the way in (a gentle ring wading, a big one jumping in, scaled by how fast it was falling), its
 * back reaching the surface from below while swimming, and a small wake while it moves along the
 * surface.
 */
export class Splashes {
  private feetWasUnder = false;
  private backWasUnder = false;
  private sinceWake = 0;

  constructor(private water: Water) {}

  /** Call after each physics step of the player. */
  update(player: PlayerController, dt: number) {
    const { x, y, z } = player.position;
    if (!nearPond(x, z)) {
      this.feetWasUnder = this.backWasUnder = false;
      return;
    }
    const feetUnder = y - centreAboveFeet() < WATER_Y;
    const back = y + M.bodyRadius;
    const backUnder = back < WATER_Y - SURFACE_TOUCH;

    if (feetUnder && !this.feetWasUnder) {
      const fall = Math.max(0, -player.velocity.y);
      this.water.ripple(x, z, Math.min(1.5, 0.3 + 1.2 * fall));
      // A hard landing sends out a second, later ring.
      if (fall > 0.5) this.water.ripple(x, z, 0.7, 0.25);
      this.sinceWake = 0;
    } else if (player.swimming && this.backWasUnder && !backUnder) {
      this.water.ripple(x, z, 0.5);
      this.sinceWake = 0;
    }

    // Wading or swimming along the top: the body cuts the surface.
    this.sinceWake += dt;
    if (feetUnder && !backUnder && player.horizontalSpeed > WAKE_SPEED && this.sinceWake > WAKE_INTERVAL) {
      this.water.ripple(x, z, 0.2);
      this.sinceWake = 0;
    }
    this.feetWasUnder = feetUnder;
    this.backWasUnder = backUnder;
  }
}
