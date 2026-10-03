import { MOVEMENT as M, centreAboveFeet } from '../player/movement';
import type { PlayerController } from '../player/controller';
import { nearPond, WATER_Y } from './pond';
import type { Water } from './water';

/** Within this of the surface (m), the swimmer's back counts as touching it... */
const SURFACE_TOUCH = 0.0025;
/** ...and it has to sink this far below that again before touching it can ring the water again. */
const SURFACE_REARM = 0.01;
/** Likewise the feet have to come this far back out before going in again counts. */
const ENTRY_REARM = 0.01;
/** Gentle ripples (slow entries, surfacing, wakes) are at least this far apart (s). */
const GENTLE_GAP = 1.5;
/** Moving through the surface faster than this (m/s) leaves a small ripple every WAKE_INTERVAL seconds. */
const WAKE_SPEED = 0.08;
const WAKE_INTERVAL = 2;
/** Falling in faster than this (m/s) is a splash: it always rings, however recent the last ripple. */
const SPLASH_SPEED = 0.4;

/**
 * Turns what the lizard does at the water's surface into ripples: its feet breaking the surface on
 * the way in (a gentle ring wading, a bigger one jumping in, scaled by how fast it was falling), its
 * back reaching the surface from below while swimming, and a small wake while it moves along the
 * surface. Gentle ones are kept sparse, so bobbing at the surface doesn't keep ringing it.
 */
export class Splashes {
  private feetArmed = true;
  private surfaceArmed = false;
  private sinceGentle = Infinity;
  private sinceWake = 0;

  constructor(private water: Water) {}

  /** Call after each physics step of the player. */
  update(player: PlayerController, dt: number) {
    this.sinceGentle += dt;
    this.sinceWake += dt;
    const { x, y, z } = player.position;
    if (!nearPond(x, z)) {
      this.feetArmed = true;
      this.surfaceArmed = false;
      return;
    }
    const feet = y - centreAboveFeet();
    const back = y + M.bodyRadius;
    const gentle = (strength: number) => {
      if (this.sinceGentle < GENTLE_GAP) return;
      this.water.ripple(x, z, strength);
      this.sinceGentle = this.sinceWake = 0;
    };

    if (feet > WATER_Y + ENTRY_REARM) this.feetArmed = true;
    if (back < WATER_Y - SURFACE_REARM) this.surfaceArmed = true;

    if (feet < WATER_Y && this.feetArmed) {
      this.feetArmed = false;
      const fall = Math.max(0, -player.velocity.y);
      if (fall > SPLASH_SPEED) {
        this.water.ripple(x, z, Math.min(1.2, 0.5 + 0.8 * fall));
        // A hard landing sends out a second, fainter ring.
        if (fall > 0.7) this.water.ripple(x, z, 0.6, 0.35);
        this.sinceGentle = this.sinceWake = 0;
      } else gentle(0.5);
    } else if (player.swimming && this.surfaceArmed && back > WATER_Y - SURFACE_TOUCH) {
      this.surfaceArmed = false;
      gentle(0.5);
    }

    // Wading or swimming along the top: the body cuts the surface.
    const cutting = feet < WATER_Y && back > WATER_Y - SURFACE_TOUCH;
    if (cutting && player.horizontalSpeed > WAKE_SPEED && this.sinceWake > WAKE_INTERVAL) gentle(0.35);
  }
}
