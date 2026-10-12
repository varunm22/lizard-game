import * as THREE from 'three';
import type { PlayerController } from '../player/controller';
import { burrowDepth } from './layout';
import type { Bushes } from './bushes';
import type { Prey, Racer } from './racers';

/** Down a burrow at least this far (0 at the rim, 1 at the bottom of the pit) is out of sight. */
const IN_BURROW = 0.4;

/**
 * A hatchling's body as a racer sees it: the lizard's or one of the others'. Its sight points are
 * the snout, the middle of the back and the hips, at the height of a hatchling's back.
 */
export class BodyPrey implements Prey {
  private points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private f = new THREE.Vector3();

  constructor(
    readonly id: string,
    private body: PlayerController,
    private bushes: Bushes,
    private free: () => boolean,
    private onCaught: (by: Racer) => void,
  ) {}

  feet(out: THREE.Vector3) {
    return this.body.feetAt(1, out);
  }

  sightPoints() {
    this.body.feetAt(1, this.f);
    const fx = Math.sin(this.body.yaw);
    const fz = Math.cos(this.body.yaw);
    [0.06, 0, -0.04].forEach((s, i) => this.points[i].set(this.f.x + fx * s, this.f.y + 0.014, this.f.z + fz * s));
    return this.points;
  }

  speed() {
    return this.body.horizontalSpeed;
  }

  inCover() {
    this.body.feetAt(1, this.f);
    return coverAt(this.bushes, this.f.x, this.f.z);
  }

  huntable() {
    return this.free();
  }

  caught(by: Racer) {
    this.onCaught(by);
  }
}

/** Whether (x, z) is down a burrow or under a saltbush. */
export function coverAt(bushes: Bushes, x: number, z: number): boolean {
  return burrowDepth(x, z) > IN_BURROW || bushes.over(x, z) !== null;
}
