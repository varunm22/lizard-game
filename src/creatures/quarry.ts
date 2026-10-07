import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PlayerController } from '../player/controller';
import type { LizardModel } from '../player/lizardModel';
import type { Wounds } from '../player/wounds';
import type { Crabs } from './crab';
import type { Iguanas } from './iguana';
import type { Tortoise } from './tortoise';

/**
 * What the hawk can hunt. The lizard, the other iguanas and the crabs are each built very
 * differently (a controller the player drives, a controller its own code drives, and a crab that
 * isn't simulated at all), so this is the little the hawk needs of them: where to look for them,
 * what it takes to catch one, and what happens when it does.
 */
export interface Quarry {
  kind: 'player' | 'iguana' | 'crab';
  /** Which one of its kind (the player is 0). */
  index: number;
  /** In the world at all: not eaten and gone. A kill that's still lying there counts. */
  readonly available: boolean;
  /** Points on its body the hawk looks for and strikes at (world m), refreshed as it's drawn. */
  readonly spheres: readonly { x: number; y: number; z: number; r: number }[];
  /** Where it stands, for circling over and landing by (out into `v`). */
  feet(v: THREE.Vector3): THREE.Vector3;
  /** How fast it's travelling, to lead the strike. */
  readonly velocity: { x: number; z: number };
  /** Its own body, which never blocks the hawk's view of it. */
  readonly body?: RAPIER.RigidBody;
  /**
   * How well the hawk picks this kind out: it sees them this share of its full range away, and takes
   * this much longer to be sure of one.
   */
  readonly acuity: number;
  /** The chance it bothers, once it has one in its eye: a crab is barely worth the dive. */
  readonly appeal: number;
  /** Out of the hawk's reach where it is (the lizard riding the tortoise): it won't go for it. */
  readonly safe?: boolean;
  /** A strike landed, the blow travelling (dx, dz). False if it was already down. */
  strike(dx: number, dz: number): boolean;
  /** Down: lying there to be eaten. */
  readonly down: boolean;
  /** The hawk has eaten it. */
  eaten(): void;
  /** Something passed overhead at (x, z): take fright. True if it took any notice. */
  scare(x: number, z: number): boolean;
  /** A hawk is after it right now. */
  hunted(on: boolean): void;
}

/** The hawk sees the lizard and the other iguanas this far off; a crab is a much smaller mark. */
const ACUITY = { player: 1, iguana: 0.75, crab: 0.35 };
/** How often it bothers: it always takes the lizard, an iguana about half the time, a crab rarely. */
const APPEAL = { player: 1, iguana: 0.45, crab: 0.07 };
/** A crab's body, as one sphere this big, this far above the rock (m). */
const CRAB = { r: 0.009, up: 0.006 };

/** The player's lizard: the hawk's first choice, and the only one it wears down over three strikes. */
class PlayerQuarry implements Quarry {
  kind = 'player' as const;
  index = 0;
  acuity = ACUITY.player;
  appeal = APPEAL.player;

  constructor(
    private player: PlayerController,
    private model: LizardModel,
    private wounds: Wounds,
    private onTortoise: () => boolean,
  ) {}

  get safe() {
    return this.onTortoise();
  }
  get available() {
    // Always there: knocked down it's a kill to stand over, and it comes back at the spawn.
    return true;
  }
  get spheres() {
    return this.model.bodySpheres;
  }
  feet(v: THREE.Vector3) {
    return this.player.feetAt(1, v);
  }
  get velocity() {
    return this.player.velocity;
  }
  get body() {
    return this.player.body;
  }
  strike(dx: number, dz: number) {
    return this.wounds.strike(dx, dz);
  }
  get down() {
    return this.wounds.down;
  }
  eaten() {
    // The lizard comes back on its own, at the spawn; the hawk just stands over it until it does.
  }
  scare() {
    // The player decides whether to run.
    return false;
  }
  hunted(on: boolean) {
    this.wounds.hunted = on;
  }
}

/** One of the other marine iguanas: a smaller, less likely meal, and two strikes put it down. */
class IguanaQuarry implements Quarry {
  kind = 'iguana' as const;
  acuity = ACUITY.iguana;
  appeal = APPEAL.iguana;

  constructor(
    private herd: Iguanas,
    readonly index: number,
  ) {}

  private get ig() {
    return this.herd.list[this.index];
  }
  get available() {
    // In the sea it's out of reach, and already hidden by the water.
    return !this.ig.gone && !this.ig.body.swimming;
  }
  get spheres() {
    return this.ig.model.bodySpheres;
  }
  feet(v: THREE.Vector3) {
    return this.ig.body.feetAt(1, v);
  }
  get velocity() {
    return this.ig.body.velocity;
  }
  get body() {
    return this.ig.body.body;
  }
  strike(dx: number, dz: number) {
    return this.ig.strike(dx, dz);
  }
  get down() {
    return this.ig.down;
  }
  eaten() {
    this.ig.eaten();
  }
  scare(x: number, z: number) {
    return this.ig.scare(x, z);
  }
  hunted() {}
}

/** A Sally Lightfoot crab: hard to pick out, hardly worth the dive, and caught in one. */
class CrabQuarry implements Quarry {
  kind = 'crab' as const;
  acuity = ACUITY.crab;
  appeal = APPEAL.crab;
  private sphere = { x: 0, y: 0, z: 0, r: CRAB.r };
  readonly velocity = { x: 0, z: 0 };

  constructor(
    private crabs: Crabs,
    readonly index: number,
  ) {}

  private get crab() {
    return this.crabs.list[this.index];
  }
  get available() {
    return !this.crab.gone;
  }
  get spheres() {
    const { x, y, z } = this.crab.pos;
    this.sphere.x = x;
    this.sphere.y = y + CRAB.up;
    this.sphere.z = z;
    return [this.sphere];
  }
  feet(v: THREE.Vector3) {
    return v.copy(this.crab.pos);
  }
  strike() {
    if (this.crab.dead) return false;
    this.crab.kill();
    return true;
  }
  get down() {
    return this.crab.dead;
  }
  eaten() {
    this.crab.eaten();
  }
  scare(x: number, z: number) {
    return this.crab.scare(x, z);
  }
  hunted() {}
}

/** Everything on the island the hawk hunts: the lizard first, then the other iguanas, then the crabs. */
export function quarries(player: PlayerController, lizard: LizardModel, wounds: Wounds, herd: Iguanas, crabs: Crabs, tortoise: Tortoise): Quarry[] {
  return [
    new PlayerQuarry(player, lizard, wounds, () => tortoise.ridden),
    ...herd.list.map((_, i) => new IguanaQuarry(herd, i)),
    ...crabs.list.map((_, i) => new CrabQuarry(crabs, i)),
  ];
}
