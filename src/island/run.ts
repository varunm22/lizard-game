import * as THREE from 'three';
import { terrainHeight } from '../world/terrain';
import type { PlayerController } from '../player/controller';
import type { Tortoise } from '../creatures/tortoise';
import { crackCut, crackHalf, crackSide, crackX, overCrack } from './crack';
import type { Snag } from './snag';
import type { Figs } from './figs';

/** The tortoise knocks the dead tree over with its mouth within this of the trunk, or its shell this near its foot (m). */
const KNOCK_MOUTH = 0.14;
const KNOCK_SHELL = 0.17;
/** Feet this far below the rim are down in the crack (m). Down there it's "Stuck!" this long (s), out of the player's hands, then climbs out for this long and is back up where it fell from. */
const FALLEN = 0.07;
const STUCK = 2.5;
const CLIMB_OUT = 1.2;
/**
 * The lizard's straight physics body can rest its side or one end on the rim with its middle out
 * over the drop, which a lizard can't: with its feet (middle) this far past the rim (m), it's tipped
 * on in at this speed (m/s), whichever way it's facing, unless it's on the fallen tree.
 */
const TIP_PAST = 0.004;
const TIP_SPEED = 0.4;
/** Feet this near the fallen tree's line are on it (m): its radius and a bit for the lizard's sprawl. */
const BRIDGE_REACH = 0.06;
/** It comes back up this far out from the rim, facing away from the crack (m). */
const RIM_OUT = 0.1;
/** The lizard has "seen" the crack once it's been this near the rim (m). */
const SEEN = 0.6;
/** Over on the far side, this far past the rim and on its feet this long (s), it's made it. */
const PAST = 0.06;
const ARRIVE = 0.5;

/** Where the island's objective has got to. */
export type Step = 'start' | 'seen' | 'landed' | 'luring' | 'bridged' | 'home';

/**
 * The island's objective, step by step: get across the crack. It's too wide to jump; a lizard that
 * falls in slides down into the narrow bottom and is stuck there a while, then climbs back out where
 * it went over. The fig tree on the beach drops its figs into the sea, so the lizard has to swim out
 * and nose one ashore before it can roll it up to the tortoise. The tortoise reaching for a fig at
 * the dead tree's foot knocks the tree down across the crack, and once the lizard is over on the far side the stage
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
  /** Down in the crack: 'stuck' at the bottom, then 'climbing' out; null up on the ground. */
  fallen: 'stuck' | 'climbing' | null = null;
  private over = 0;
  private feet = new THREE.Vector3();
  /** Called once as the lizard makes it over. */
  onHome: (() => void) | null = null;

  constructor(
    private player: PlayerController,
    private tortoise: Tortoise,
    private snag: Snag,
    private figs: Figs,
  ) {
    player.feetAt(1, this.safe);
  }

  /** The big word over the screen while it's down in the crack, as on the dunes ("Freeze!", "Run!"). */
  get banner(): string | null {
    return this.fallen === 'stuck' ? 'Stuck!' : this.fallen === 'climbing' ? 'Climbing back out…' : null;
  }

  /** Down in the crack, stuck and climbing out, the controls do nothing. */
  get held(): boolean {
    return this.fallen !== null;
  }

  /** What to do, and a hint toward how. */
  get objective(): { text: string; hint: string } {
    const text = 'Cross the lava crack to the west';
    switch (this.progress) {
      case 'start':
        return { text, hint: "It's too wide to jump. A burnt, dead tree leans out over it." };
      case 'seen':
        return { text, hint: 'Something heavy could knock that dead tree over. Tortoises love figs, but the fig tree on the beach drops them in the sea.' };
      case 'landed':
        return { text, hint: 'A fig on the sand! Roll it up the beach path to the tortoise.' };
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
    // Over the rim, it tips in.
    const past = crackHalf(feet.z) - Math.abs(feet.x - crackX(feet.z));
    if (!this.fallen && past > TIP_PAST && !this.onBridge(feet)) {
      this.player.shove(Math.sign(crackX(feet.z) - feet.x) * TIP_SPEED * dt, 0, this.snag.obstacle.collider);
    }
    // Down in the crack: wedged at the bottom for a while, then back out where it went in.
    const rim = terrainHeight(feet.x, feet.z) + crackCut(feet.x, feet.z);
    if (this.fallen || (overCrack(feet.x, feet.z) && feet.y < rim - FALLEN)) {
      if (!this.fallen) {
        this.fallen = 'stuck';
        this.down = 0;
        this.falls++;
        this.seen = true;
        // It drops on down the middle, lying along the crack, so it lands in the slot at the bottom
        // between the walls rather than across them, whichever way it went over.
        const slope = (crackX(feet.z + 0.05) - crackX(feet.z - 0.05)) / 0.1;
        const along = Math.atan2(slope, 1);
        const yaw = Math.cos(this.player.yaw - along) >= 0 ? along : along + Math.PI;
        this.player.setFeet(new THREE.Vector3(crackX(feet.z), feet.y, feet.z), yaw);
      }
      this.down += dt;
      if (this.down >= STUCK) this.fallen = 'climbing';
      if (this.down >= STUCK + CLIMB_OUT) {
        this.down = 0;
        this.fallen = null;
        // Up on the rim on the side it went in from, where it fell.
        const side = crackSide(this.safe.x, this.safe.z);
        const x = crackX(feet.z) + side * (crackHalf(feet.z) + RIM_OUT);
        this.player.setFeet(new THREE.Vector3(x, terrainHeight(x, feet.z), feet.z), side > 0 ? Math.PI / 2 : -Math.PI / 2);
      }
    } else if (this.player.grounded && !overCrack(feet.x, feet.z)) {
      // Where to put it back: the last place it stood clear of the rim.
      this.safe.copy(feet);
    }
    // Over on the far side, and standing there: it's done.
    const far = !this.fallen && crackSide(feet.x, feet.z) < 0 && !overCrack(feet.x, feet.z, PAST) && this.player.grounded;
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
            : this.figs.list.some((f) => f.landed && f.state === 'lying')
              ? 'landed'
              : this.seen
                ? 'seen'
              : 'start';
  }

  /** Whether the feet are on the dead tree, down across the crack. */
  private onBridge(feet: THREE.Vector3): boolean {
    if (this.snag.state !== 'fallen') return false;
    const a = this.snag.position;
    const b = this.snag.tip;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((feet.x - a.x) * dx + (feet.z - a.z) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(feet.x - a.x - dx * t, feet.z - a.z - dz * t) < BRIDGE_REACH;
  }

  /** R on the end screen: the stage from the start. */
  restart() {
    if (this.state === 'home') location.reload();
  }
}
