import * as THREE from 'three';
import type { InputState } from '../input';
import { wrapAngle } from '../math/angles';
import type { PlayerController } from '../player/controller';
import { BASIN } from './basin';

/** Walking on at least this long (s), until it's up at the wall but no longer than `WALK_MAX`; then the screen fades for `FADE_OUT`. */
const WALK_IN = 3.0;
const WALK_MAX = 5.0;
const FADE_OUT = 1.2;
/** Where it walks to: up the bank to the island's west edge, where the lagoon opens out below (m). */
const TOP = { x: -3.55, z: BASIN.z };
/** West, the way out (yaw; 0 faces +Z). */
const WEST = -Math.PI / 2;

/**
 * Leaving the island once it's over the crack (C on the end screen), as the dunes do: the lizard
 * walks on west up the forest bank to its top, where the mangrove lagoon (the next stage) opens
 * out below (`lagoonView.ts`), the camera swinging round behind it and rising to look out over the
 * water as the screen fades to black; then on to the lagoon. It steers itself through the same input
 * as the player's.
 */
export class WalkOut {
  /** Seconds since it began, or -1 before it has; and when the fade began, or -1. */
  t = -1;
  private fadeFrom = -1;
  /** Done: the screen is black and the next stage has been asked for. */
  done = false;
  private then: (() => void) | null = null;
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
  }

  /** Each frame while walking out, after the follow camera: it eases round behind the lizard, looking west, and up, looking out and down over the lagoon. */
  view(camera: THREE.Camera, feet: THREE.Vector3, yaw: number, dt: number) {
    if (this.t < 0) return;
    const along = yaw + wrapAngle(WEST - yaw) * THREE.MathUtils.smoothstep(this.t, 0.3, 2);
    const sx = Math.sin(along);
    const sz = Math.cos(along);
    const up = 0.16 + 0.14 * THREE.MathUtils.smoothstep(this.t, 0, WALK_IN + FADE_OUT);
    this.want.set(feet.x - sx * 0.45, feet.y + up, feet.z - sz * 0.45);
    // Ahead, further out and lower as it reaches the top, over the water.
    const out = 0.5 + 0.9 * THREE.MathUtils.smoothstep(this.t, 0.5, WALK_IN);
    this.aim.set(feet.x + sx * out, feet.y + 0.03 - 0.12 * THREE.MathUtils.smoothstep(this.t, 0.5, WALK_IN), feet.z + sz * out);
    this.look.lerp(this.aim, this.t < dt ? 1 : 1 - Math.exp(-4 * dt));
    camera.position.lerp(this.want, 1 - Math.exp(-2.5 * dt));
    camera.lookAt(this.look);
  }

  /** Each physics step: the input walking it out, or null when it isn't. */
  step(dt: number): Partial<InputState> | null {
    if (this.t < 0) return null;
    this.t += dt;
    this.player.feetAt(1, this.feet);
    const there = Math.hypot(TOP.x - this.feet.x, TOP.z - this.feet.z) < 0.12 || this.feet.x < TOP.x + 0.05;
    if (this.fadeFrom < 0 && this.t >= WALK_IN && (there || this.t >= WALK_MAX)) this.fadeFrom = this.t;
    if (!this.done && this.fade >= 1) {
      this.done = true;
      this.then?.();
    }
    if (there) return { move: { x: 0, y: 0 }, run: false, jump: false };
    // Toward the top, but mostly west: it doesn't cut back across the slope to the middle.
    const goal = Math.atan2(TOP.x - this.feet.x, (TOP.z - this.feet.z) * 0.5);
    const off = wrapAngle(goal - this.player.yaw);
    // Turning right lowers the yaw; slow up for a sharp turn.
    return { move: { x: THREE.MathUtils.clamp(-off * 3, -1, 1), y: Math.abs(off) > 1.2 ? 0.3 : 1 }, run: false, jump: false };
  }
}
