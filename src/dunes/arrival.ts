import * as THREE from 'three';
import type { InputState } from '../input';
import { wrapAngle } from '../math/angles';
import type { PlayerController } from '../player/controller';
import { LANE_END, LANE_FAR, LANE_X } from './colony';
import { COLONY } from './layout';

/**
 * Walking on at least this long (s) before the screen starts to fade, and until it's on the lane's
 * last stretch but no longer than `WALK_MAX`; then the fade.
 */
export const WALK_IN = 3.0;
const WALK_MAX = 5.0;
export const FADE_OUT = 1.2;
/** The bend round into the lane: a waypoint every `step` (m), turning `turn` (radians) each. */
const BEND = { step: 0.08, turn: 0.45 };

/**
 * Leaving the dunes once the run is won: the hatchling walks on past the adults, bearing round into
 * the open lane beside their heaps and down it toward the island's forest edge, as the screen fades
 * to black; then on to the island. It steers itself, through the same input as the player's, so it
 * walks as the player does, always forward, the camera following behind.
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
    // A smooth bend from the way it's going round to the south, turning the shorter way (from
    // the north, round by the landward side, away from the heaps), then down the lane.
    let yaw = this.player.yaw;
    let px = x;
    let pz = z;
    const left = wrapAngle(Math.PI - yaw);
    const turn = Math.abs(wrapAngle(yaw)) < 0.4 ? -1 : Math.sign(left);
    while (Math.abs(wrapAngle(Math.PI - yaw)) > BEND.turn) {
      yaw += turn * BEND.turn;
      px += Math.sin(yaw) * BEND.step;
      pz += Math.cos(yaw) * BEND.step;
      this.path.push({ x: px, z: pz });
    }
    // Come in from the south, it goes on a little further, short of the cactus beyond the lane's end.
    const end = Math.max(LANE_FAR, Math.min(LANE_END, pz - 0.3));
    // Joining the lane at no more than 45 degrees.
    for (let lz = Math.min(pz - 0.15 - Math.abs(px - LANE_X), 0.3); lz > end; lz -= 0.35) this.path.push({ x: LANE_X, z: lz });
    this.path.push({ x: LANE_X, z: end });
  }

  /**
   * Each frame while walking in, after the follow camera: the camera eases up and back behind the
   * hatchling, swinging round to look down the lane, rising and looking up as it goes, down the lane past the heaps to the trees.
   */
  view(camera: THREE.Camera, feet: THREE.Vector3, yaw: number, dt: number) {
    if (this.t < 0) return;
    // From behind the hatchling round to looking straight down the lane (south), so the view ahead
    // is the trees whichever way it came in.
    const along = yaw + wrapAngle(Math.PI - yaw) * THREE.MathUtils.smoothstep(this.t, 0.3, 2);
    const sx = Math.sin(along);
    const sz = Math.cos(along);
    const up = 0.16 + 0.1 * THREE.MathUtils.smoothstep(this.t, 0, WALK_IN + FADE_OUT);
    this.want.set(feet.x - sx * 0.45, feet.y + up, feet.z - sz * 0.45);
    const lift = 0.09 * THREE.MathUtils.smoothstep(this.t, 0.5, WALK_IN);
    this.look.lerp(this.aim.set(feet.x + sx * 0.5, feet.y + 0.03 + lift, feet.z + sz * 0.5), this.t < dt ? 1 : 1 - Math.exp(-4 * dt));
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
    // On to the next waypoint once it's there, or once it has gone by one close at hand (behind it),
    // rather than circling back to it.
    while (to) {
      const dx = COLONY.x + to.x - this.feet.x;
      const dz = COLONY.z + to.z - this.feet.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.05 && (d > 0.2 || Math.abs(wrapAngle(Math.atan2(dx, dz) - this.player.yaw)) < 1.6)) break;
      to = this.path[++this.next];
    }
    if (!to) return { move: { x: 0, y: 0 }, run: false, jump: false };
    const off = wrapAngle(Math.atan2(COLONY.x + to.x - this.feet.x, COLONY.z + to.z - this.feet.z) - this.player.yaw);
    // Turning right lowers the yaw; slow up for a sharp turn.
    return { move: { x: THREE.MathUtils.clamp(-off * 3, -1, 1), y: Math.abs(off) > 1.2 ? 0.3 : 1 }, run: false, jump: false };
  }
}
