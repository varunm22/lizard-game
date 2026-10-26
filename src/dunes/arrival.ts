import * as THREE from 'three';
import type { InputState } from '../input';
import { wrapAngle } from '../math/angles';
import type { PlayerController } from '../player/controller';
import { COLONY_LANE } from './colony';
import { COLONY } from './layout';

/**
 * Walking in among the adults at least this long (s) before the screen starts to fade, and until it's
 * on the lane's last stretch (come in round the heaps) but no longer than `WALK_MAX`; then the fade.
 */
export const WALK_IN = 2.4;
const WALK_MAX = 4.5;
export const FADE_OUT = 1.0;
/** Come in more than `wedge` (radians) off the lane's line, round past the heaps, it goes round at `r` (m) till it's within that, a waypoint every `step` radians. */
const AROUND = { wedge: 1.0, r: 0.74, step: 0.3 };

/**
 * Leaving the dunes once the run is won: the hatchling walks on in among the adults, up the open
 * lane between their heaps toward the water, as the screen fades to black; then on to the next
 * stage. It steers itself, through the same input as the player's, so it walks as the player does.
 */
export class Arrival {
  /** Seconds since it began, or -1 before it has; and when the fade began, or -1. */
  t = -1;
  private fadeFrom = -1;
  /** Done: the screen is black and the next stage has been asked for. */
  done = false;
  private then: (() => void) | null = null;
  /** Where it walks (m off the colony's middle), and which of those it's walking to. */
  private path: { x: number; z: number }[] = [];
  private next = 0;
  private feet = new THREE.Vector3();
  private want = new THREE.Vector3();
  private aim = new THREE.Vector3();
  private look = new THREE.Vector3();

  constructor(private player: PlayerController) {}

  get walking() {
    return this.t >= 0;
  }

  /** How far the screen has faded to black (0 to 1). */
  get fade() {
    return this.fadeFrom < 0 ? 0 : Math.min(1, (this.t - this.fadeFrom) / FADE_OUT);
  }

  /** Begin, calling `then` once the screen is black. */
  start(then: () => void) {
    if (this.t >= 0) return;
    this.t = 0;
    this.then = then;
    this.player.feetAt(1, this.feet);
    const x = this.feet.x - COLONY.x;
    const z = this.feet.z - COLONY.z;
    this.path = [];
    this.next = 0;
    // Come in from the north or south, it first steps out clear of the adults and goes round to the
    // lane's mouth.
    const from = Math.atan2(z, x);
    const round = wrapAngle(Math.PI - from);
    if (Math.abs(round) > AROUND.wedge) {
      this.path.push({ x: Math.cos(from) * AROUND.r, z: Math.sin(from) * AROUND.r });
      const left = round - Math.sign(round) * AROUND.wedge;
      const steps = Math.ceil(Math.abs(left) / AROUND.step);
      for (let i = 1; i <= steps; i++) {
        const a = from + (left * i) / steps;
        this.path.push({ x: Math.cos(a) * AROUND.r, z: Math.sin(a) * AROUND.r });
      }
    }
    // Up the lane, from its mouth unless it's already in it.
    const inLane = Math.abs(z) < 0.1 && x > COLONY_LANE[0].x;
    this.path.push(...COLONY_LANE.slice(inLane ? 1 : 0));
  }

  /**
   * Each frame while walking in, after the follow camera: the camera eases up and back behind the
   * hatchling, rising to look on over the heaps toward the sea.
   */
  view(camera: THREE.Camera, feet: THREE.Vector3, yaw: number, dt: number) {
    if (this.t < 0) return;
    const sx = Math.sin(yaw);
    const sz = Math.cos(yaw);
    const up = 0.16 + 0.14 * THREE.MathUtils.smoothstep(this.t, 0, WALK_IN + FADE_OUT);
    this.want.set(feet.x - sx * 0.45, feet.y + up, feet.z - sz * 0.45);
    this.look.lerp(this.aim.set(feet.x + sx * 0.5, feet.y + 0.03, feet.z + sz * 0.5), this.t < dt ? 1 : 1 - Math.exp(-4 * dt));
    camera.position.lerp(this.want, 1 - Math.exp(-2.5 * dt));
    camera.lookAt(this.look);
  }

  /** Each physics step: the input walking it in, or null when it isn't. */
  step(dt: number): Partial<InputState> | null {
    if (this.t < 0) return null;
    this.t += dt;
    if (this.fadeFrom < 0 && this.t >= WALK_IN && (this.next >= this.path.length - 1 || this.t >= WALK_MAX)) this.fadeFrom = this.t;
    if (!this.done && this.fade >= 1) {
      this.done = true;
      this.then?.();
    }
    this.player.feetAt(1, this.feet);
    let to = this.path[this.next];
    while (to && Math.hypot(COLONY.x + to.x - this.feet.x, COLONY.z + to.z - this.feet.z) < 0.05) to = this.path[++this.next];
    if (!to) return { move: { x: 0, y: 0 }, run: false, jump: false };
    const off = wrapAngle(Math.atan2(COLONY.x + to.x - this.feet.x, COLONY.z + to.z - this.feet.z) - this.player.yaw);
    // Turning right lowers the yaw; slow up for a sharp turn.
    return { move: { x: THREE.MathUtils.clamp(-off * 3, -1, 1), y: Math.abs(off) > 1.2 ? 0.3 : 1 }, run: false, jump: false };
  }
}
