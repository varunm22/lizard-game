import * as THREE from 'three';
import { terrainHeight } from '../world/terrain';
import type { PlayerController } from '../player/controller';
import type { Tortoise } from '../creatures/tortoise';
import { crackCut, crackHalf, crackSide, crackX, overCrack } from './crack';
import type { Snag } from './snag';

/** The tortoise knocks the dead tree over with its mouth within this of the trunk, or its shell this near its foot (m). */
const KNOCK_MOUTH = 0.14;
const KNOCK_SHELL = 0.17;
/** Feet this far below the rim are down in the crack (m); after this long (s) the lizard is back up where it fell from. */
const FALLEN = 0.07;
const CLIMB_OUT = 0.6;
/** It comes back up this far out from the rim, facing away from the crack (m). */
const RIM_OUT = 0.1;
/** The lizard has "seen" the crack once it's been this near the rim (m). */
const SEEN = 0.6;
/** Over on the far side, this far past the rim and on its feet this long (s), it's made it. */
const PAST = 0.06;
const ARRIVE = 0.5;

/** Where the island's objective has got to. */
export type Step = 'start' | 'seen' | 'luring' | 'bridged' | 'home';

/**
 * The island's objective, step by step: get across the crack. It's too wide to jump; a lizard that
 * falls in scrambles back out where it went over. The tortoise reaching for a fig at the dead tree's
 * foot knocks the tree down across the crack, and once the lizard is over on the far side the stage
 * is done. Also says what to try next, for the objective line in the corner.
 */
export class IslandRun {
  /** 'playing' until the lizard is over the crack, then 'home' (the run end screen's state). */
  state: 'playing' | 'home' = 'playing';
  progress: Step = 'start';
  /** Times it has fallen into the crack. */
  falls = 0;
  private seen = false;
  private safe = new THREE.Vector3();
  private down = 0;
  private over = 0;
  private feet = new THREE.Vector3();
  /** Called once as the lizard makes it over. */
  onHome: (() => void) | null = null;

  constructor(
    private player: PlayerController,
    private tortoise: Tortoise,
    private snag: Snag,
  ) {
    player.feetAt(1, this.safe);
  }

  /** What to do, and a hint toward how. */
  get objective(): { text: string; hint: string } {
    const text = 'Cross the lava crack to the west';
    switch (this.progress) {
      case 'start':
        return { text, hint: "It's too wide to jump. There's a dead tree on its edge." };
      case 'seen':
        return { text, hint: 'Something heavy could knock that dead tree over. Tortoises love figs.' };
      case 'luring':
        return { text, hint: 'The tortoise is after that fig. Lead it to the dead tree.' };
      case 'bridged':
        return { text, hint: 'The tree fell across the crack. Walk over on it!' };
      case 'home':
        return { text, hint: 'You made it across.' };
    }
  }

  step(dt: number) {
    const t = this.tortoise;
    // The tortoise reaching for something at the dead tree's foot bumps it, and over it goes.
    if (this.snag.state === 'standing') {
      const foot = this.snag.position;
      const mouth = t.mouth;
      const pos = t.position;
      if (Math.hypot(mouth.x - foot.x, mouth.z - foot.z) < KNOCK_MOUTH || Math.hypot(pos.x - foot.x, pos.z - foot.z) < KNOCK_SHELL) this.snag.knock();
    }
    const feet = this.player.feetAt(1, this.feet);
    const near = Math.abs(feet.x - crackX(feet.z)) < crackHalf(feet.z) + SEEN;
    if (near) this.seen = true;
    // Down in the crack: back out where it went in, after a moment.
    const rim = terrainHeight(feet.x, feet.z) + crackCut(feet.x, feet.z);
    if (overCrack(feet.x, feet.z) && feet.y < rim - FALLEN) {
      this.down += dt;
      if (this.down >= CLIMB_OUT) {
        this.down = 0;
        this.falls++;
        this.seen = true;
        // Up on the rim on the side it went in from, where it fell.
        const side = crackSide(this.safe.x, this.safe.z);
        const x = crackX(feet.z) + side * (crackHalf(feet.z) + RIM_OUT);
        this.player.setFeet(new THREE.Vector3(x, terrainHeight(x, feet.z), feet.z), side > 0 ? Math.PI / 2 : -Math.PI / 2);
      }
    } else {
      this.down = 0;
      // Where to put it back: the last place it stood clear of the rim.
      if (this.player.grounded && !overCrack(feet.x, feet.z)) this.safe.copy(feet);
    }
    // Over on the far side, and standing there: it's done.
    const far = crackSide(feet.x, feet.z) < 0 && !overCrack(feet.x, feet.z, PAST) && this.player.grounded;
    this.over = far ? this.over + dt : 0;
    if (this.state === 'playing' && this.over >= ARRIVE) {
      this.state = 'home';
      this.onHome?.();
    }
    this.progress =
      this.state === 'home'
        ? 'home'
        : this.snag.state !== 'standing'
          ? 'bridged'
          : t.aim?.kind === 'fig' && t.aim.fig.pushed > 0
            ? 'luring'
            : this.seen
              ? 'seen'
              : 'start';
  }

  /** R on the end screen: the stage from the start. */
  restart() {
    if (this.state === 'home') location.reload();
  }
}
