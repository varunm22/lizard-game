import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { wrapAngle } from '../math/angles';
import { rng } from '../world/noise';
import { covers, type Obstacle } from '../world/obstacles';
import { WATER_Y } from '../world/shore';
import type { GroundProbe } from '../dunes/ground';
import { HeronBody, type HeronKit } from './heronBody';
import { acrossChannel, depthAt, HERON_HAUNTS, LAGOON_EDGE } from './layout';
import type { Mangrove } from './props';

/**
 * What a heron hunts: the lizard. Positions are world metres.
 */
export interface HeronPrey {
  /** Its feet, the middle of its body. */
  feet(out: THREE.Vector3): THREE.Vector3;
  /** Which way it faces (as the lizard's yaw: 0 is +Z). */
  facing(): number;
  /** Ground or swimming speed (m/s). */
  speed(): number;
  /** Out in the open to be hunted: not caught, not finished, not in the safe point. */
  huntable(): boolean;
  /** Swimming (lying low in the water). */
  swimming(): boolean;
  caught(by: Heron): void;
}

/** Heron tuning: distances in m, speeds in m/s, times in s, angles in radians. */
export const HERON = {
  /** How far it sees, and how wide either side of its bill. */
  sight: 1.5,
  fov: 2.0,
  /** Seconds of seeing the lizard before it starts stalking: sooner if it moves, and the closer it is. */
  notice: 0.5,
  /** Wading: as deep as it goes, how close to a red mangrove's roots, and how far from its spot. */
  wade: 0.065,
  rootClear: 0.06,
  leash: 2.5,
  /** Crouched stalking walk, and walking between spots. */
  stalk: 0.07,
  walk: 0.12,
  turn: 2.2,
  /** Horizontal reach from its shoulders to the lizard that it strikes from, and the most its neck and bill reach. */
  strikeRange: 0.17,
  reach: 0.23,
  /** Drawn back and still before the stab; the stab; a hit within `bite` of the lizard's body. */
  aimTime: 0.35,
  strikeTime: 0.16,
  bite: 0.035,
  /** After a miss, and after a catch. */
  recoverTime: 0.9,
  holdTime: 2.5,
  /** Losing sight this long ends a stalk; then it won't take up the same hunt again for a while. */
  lostTime: 1.4,
  cooldown: 3,
  /** Out of reach and watching, it gives up after this long. */
  standOff: 4,
  /** Standing at a spot this long (random between) before moving to another. */
  stay: [14, 24] as const,
  /** Swimming over water deeper than this, the lizard lies too low for a heron to make out. */
  deep: 0.09,
  /** Within this share of a red mangrove's root reach, it's in the tangle: no heron strikes in there. */
  tangle: 0.85,
};

export type HeronState = 'wait' | 'walk' | 'stalk' | 'aim' | 'strike' | 'recover' | 'hold';
/** Why a heron lost the lizard: it went into the roots, out over deep water, or got away (out of sight or reach). */
export type LostReason = 'tangle' | 'deep' | 'away';

const STEP_TIME = 0.32;
const STRIDE = 0.075;
const STEP_LIFT = 0.025;
/** Heron-space head poses: drawn in at rest, stretched low to stalk, cocked back to aim. */
const POSE = {
  rest: new THREE.Vector3(0, 0.229, 0.112),
  stalk: new THREE.Vector3(0, 0.19, 0.17),
  aim: new THREE.Vector3(0, 0.215, 0.1),
};

export class Heron {
  readonly body: HeronBody;
  state: HeronState = 'wait';
  /** Middle on the ground (world) and facing. */
  readonly pos = new THREE.Vector3();
  yaw = 0;
  /** The spots it hunts from, which it's at, and where it's walking to. */
  spot = 0;
  readonly goal = new THREE.Vector3();
  timer = 0;
  /** Seconds it has seen the lizard (toward noticing), and since it last saw it. */
  seen = 0;
  unseen = 0;
  /** Seconds before it takes up a hunt again. */
  cool = 0;
  /** Whether it has the lizard in view this step. */
  sees = false;
  /** The point the stab aims for (world) and the head's pose either end of it (heron space). */
  readonly target = new THREE.Vector3();
  readonly headFrom = new THREE.Vector3();
  readonly headTo = new THREE.Vector3();
  /** Head (heron space) and bill direction as the simulation has them; the body copies them to draw. */
  readonly head = POSE.rest.clone();
  readonly bill = new THREE.Vector3(0, -0.25, 1).normalize();
  /** Feet: where each stands (world), where it's stepping from and to, and the step's progress (-1 planted). */
  private feet = [new THREE.Vector3(), new THREE.Vector3()];
  private stepFrom = [new THREE.Vector3(), new THREE.Vector3()];
  private stepTo = [new THREE.Vector3(), new THREE.Vector3()];
  private stepT = [-1, -1];
  private prevPos = new THREE.Vector3();
  private prevYaw = 0;
  private prevHead = new THREE.Vector3();
  private prevFeet = [new THREE.Vector3(), new THREE.Vector3()];
  /** A paused heron stands still (tests). */
  paused = false;
  /** Strikes and catches, for tests. */
  strikes = 0;
  catches = 0;

  constructor(
    readonly index: number,
    kit: HeronKit,
    readonly spots: readonly { x: number; z: number; yaw: number }[],
  ) {
    this.body = new HeronBody(kit);
    this.body.root.name = `heron-${index}`;
  }

  get home() {
    return this.spots[this.spot];
  }

  /** The tip of the bill now (world), worked out from the stance and head without posing the model. */
  billTip(out: THREE.Vector3): THREE.Vector3 {
    this.body.at.copy(this.pos);
    this.body.yaw = this.yaw;
    this.body.place();
    out.copy(this.bill).normalize().multiplyScalar(this.body.billOffset.length()).add(this.head);
    return this.body.toWorld(out, out);
  }

  /** The shoulders (world), roughly: where the neck leaves the body. */
  shoulders(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x + Math.sin(this.yaw) * 0.06, this.pos.y + 0.15, this.pos.z + Math.cos(this.yaw) * 0.06);
  }

  /** Stand at (x, y, z) facing `yaw`, feet under it. */
  stand(x: number, y: number, z: number, yaw: number) {
    this.pos.set(x, y, z);
    this.yaw = yaw;
    for (let i = 0; i < 2; i++) {
      this.body.footHome(i, this.pos, yaw, this.feet[i]);
      this.stepT[i] = -1;
      this.prevFeet[i].copy(this.feet[i]);
    }
    this.prevPos.copy(this.pos);
    this.prevYaw = yaw;
    this.head.copy(POSE.rest);
    this.prevHead.copy(this.head);
  }

  /** Feet: step whichever is furthest from where it should be, one at a time, onto the ground. */
  stepFeet(dt: number, ground: (x: number, z: number, y: number) => number) {
    const home = new THREE.Vector3();
    for (let i = 0; i < 2; i++) {
      if (this.stepT[i] < 0) continue;
      this.stepT[i] = Math.min(1, this.stepT[i] + dt / STEP_TIME);
      const t = this.stepT[i];
      const e = t * t * (3 - 2 * t);
      this.feet[i].lerpVectors(this.stepFrom[i], this.stepTo[i], e);
      this.feet[i].y += Math.sin(Math.PI * t) * STEP_LIFT;
      if (t >= 1) this.stepT[i] = -1;
    }
    if (this.stepT[0] >= 0 || this.stepT[1] >= 0) return;
    let worst = -1;
    let far = 0.02;
    for (let i = 0; i < 2; i++) {
      this.body.footHome(i, this.pos, this.yaw, home);
      const d = Math.hypot(home.x - this.feet[i].x, home.z - this.feet[i].z);
      if (d > far) {
        far = d;
        worst = i;
      }
    }
    if (worst < 0) return;
    const i = worst;
    this.body.footHome(i, this.pos, this.yaw, home);
    // Step past home along the way it's going, so the other foot's next step is as long.
    const mx = this.pos.x - this.prevPos.x;
    const mz = this.pos.z - this.prevPos.z;
    const ml = Math.hypot(mx, mz);
    if (ml > 1e-6) {
      home.x += (mx / ml) * STRIDE * 0.4;
      home.z += (mz / ml) * STRIDE * 0.4;
    }
    home.y = ground(home.x, home.z, this.pos.y);
    this.stepFrom[i].copy(this.feet[i]);
    this.stepTo[i].copy(home);
    this.stepT[i] = 0;
  }

  /** The drawn heron between the last two steps. */
  update(alpha: number) {
    const b = this.body;
    b.at.lerpVectors(this.prevPos, this.pos, alpha);
    b.yaw = this.prevYaw + wrapAngle(this.yaw - this.prevYaw) * alpha;
    b.head.lerpVectors(this.prevHead, this.head, alpha);
    b.bill.copy(this.bill);
    for (let i = 0; i < 2; i++) b.feet[i].lerpVectors(this.prevFeet[i], this.feet[i], alpha);
    const crouched = this.state === 'stalk' || this.state === 'aim' || this.state === 'strike';
    b.crouch += ((crouched ? 0.018 : 0) - b.crouch) * 0.2;
    b.lean += ((this.state === 'strike' ? 0.45 : this.state === 'stalk' || this.state === 'aim' ? 0.28 : 0.05) - b.lean) * 0.25;
    // The body rides as high as the planted feet let it.
    b.at.y = (b.feet[0].y + b.feet[1].y) / 2;
    b.pose();
  }

  /** Remember the pose before a step, to draw between steps. */
  keep() {
    this.prevPos.copy(this.pos);
    this.prevYaw = this.yaw;
    this.prevHead.copy(this.head);
    for (let i = 0; i < 2; i++) this.prevFeet[i].copy(this.feet[i]);
  }

}

/**
 * The lagoon's lava herons. Each stands hunched at one of its spots in the shallows, head turning
 * now and then, and moves to another spot every so often. It hunts by eye: the lizard out in the open
 * within sight, its bill toward it and nothing between (roots, trunks, rock and the drift log all
 * hide it), and it starts to stalk, crouched with the neck stretched, slowly, wading no deeper than
 * its legs allow and never into the root tangles or the channel. In reach it draws its neck back,
 * holds still a moment, then stabs: a hit within a few centimetres of the lizard's body is a catch.
 * In among the roots of an old mangrove nothing reaches it; swimming over deep water it lies too low
 * to see; and a lizard that keeps moving outpaces a stalking heron.
 */
export class Herons {
  readonly list: Heron[];
  /** Called as a heron catches the lizard, starts stalking it, and loses it (and why). */
  onCatch: ((h: Heron) => void) | null = null;
  onStalk: ((h: Heron) => void) | null = null;
  onLose: ((h: Heron, why: LostReason) => void) | null = null;
  /** The lizard: set once the run has made it, before the first step. */
  prey!: HeronPrey;
  private rand = rng(83);
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  private f = new THREE.Vector3();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private t = new THREE.Vector3();
  private points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  constructor(
    kit: HeronKit,
    scene: THREE.Scene,
    private world: RAPIER.World,
    private ground: GroundProbe,
    private obstacles: readonly Obstacle[],
    private mangroves: readonly Mangrove[],
    private exclude: RAPIER.RigidBody,
  ) {
    this.list = HERON_HAUNTS.map((spots, i) => new Heron(i, kit, spots));
    for (const h of this.list) {
      scene.add(h.body.root);
      const s = h.home;
      h.stand(s.x, this.groundAt(s.x, s.z), s.z, s.yaw);
      h.timer = this.stay();
      h.update(1);
    }
  }

  private stay() {
    return HERON.stay[0] + (HERON.stay[1] - HERON.stay[0]) * this.rand();
  }

  /** The bed or ground under a heron's feet. */
  groundAt(x: number, z: number, from?: number): number {
    return this.ground.at(x, z, from, 0.08);
  }

  /** Whether a heron could stand at (x, z), within `leash` of (hx, hz). */
  wadeable(x: number, z: number, hx: number, hz: number): boolean {
    if (Math.abs(x) > LAGOON_EDGE || Math.abs(z) > LAGOON_EDGE) return false;
    if (Math.hypot(x - hx, z - hz) > HERON.leash) return false;
    if (depthAt(x, z) > HERON.wade) return false;
    if (acrossChannel(x, z) > -1.15) return false;
    for (const m of this.mangroves) {
      const clear = m.sapling ? 0.05 : m.reach + HERON.rootClear;
      if (Math.hypot(x - m.x, z - m.z) < clear) return false;
    }
    for (const o of this.obstacles) if (o.kind !== 'tree' && o.height > 0.05 && covers(o, x, z, 0.04)) return false;
    return true;
  }

  /** In a red mangrove's root tangle, where no heron strikes. */
  inTangle(x: number, z: number): boolean {
    return this.mangroves.some((m) => !m.sapling && Math.hypot(x - m.x, z - m.z) < m.reach * HERON.tangle);
  }

  /** The lizard's snout, middle and hips (world), at the height of its back. */
  private preyPoints() {
    this.prey.feet(this.f);
    const yaw = this.prey.facing();
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const y = Math.max(this.f.y + 0.014, this.prey.swimming() ? WATER_Y : -Infinity);
    [0.06, 0, -0.04].forEach((s, i) => this.points[i].set(this.f.x + fx * s, y, this.f.z + fz * s));
    return this.points;
  }

  /** Why the lizard is out of a heron's reach wherever it stands, or null: in the roots, or low over deep water. */
  hidden(): LostReason | null {
    this.prey.feet(this.f);
    if (this.inTangle(this.f.x, this.f.z)) return 'tangle';
    if (this.prey.swimming() && depthAt(this.f.x, this.f.z) > HERON.deep) return 'deep';
    return null;
  }

  /** Whether heron `h` can see the lizard now: in range, before it, in the open and in clear view. */
  sees(h: Heron): boolean {
    if (!this.prey.huntable() || this.hidden()) return false;
    const eye = this.p.set(h.pos.x + Math.sin(h.yaw) * 0.1, h.pos.y + 0.23, h.pos.z + Math.cos(h.yaw) * 0.1);
    const pts = this.preyPoints();
    const dx = pts[1].x - eye.x;
    const dz = pts[1].z - eye.z;
    const d = Math.hypot(dx, dz);
    if (d > HERON.sight) return false;
    const watching = h.state === 'stalk' || h.state === 'aim' || h.state === 'strike';
    if (!watching && Math.abs(wrapAngle(Math.atan2(dx, dz) - h.yaw)) > HERON.fov) return false;
    return pts.some((q) => this.clear(eye, q));
  }

  /** Nothing solid between a and b but the lizard (roots and trunks count). */
  private clear(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return true;
    this.ray.origin = { x: a.x, y: a.y, z: a.z };
    this.ray.dir = { x: dx / len, y: dy / len, z: dz / len };
    return !this.world.castRay(this.ray, len - 0.01, true, undefined, undefined, undefined, this.exclude);
  }

  /** Who is after the lizard: the worst of 'watched' (stalking) and 'chased' (about to strike). */
  get danger(): 'none' | 'watched' | 'chased' {
    let level: 'none' | 'watched' | 'chased' = 'none';
    for (const h of this.list) {
      if (h.state === 'aim' || h.state === 'strike') return 'chased';
      if (h.state === 'stalk') level = 'watched';
    }
    return level;
  }

  /** Every heron back to its first spot, waiting (a fresh run). */
  reset() {
    for (const h of this.list) {
      h.spot = 0;
      h.state = 'wait';
      const s = h.home;
      h.stand(s.x, this.groundAt(s.x, s.z), s.z, s.yaw);
      h.timer = this.stay();
      h.seen = 0;
      h.cool = 0;
    }
  }

  /** Stop hunting the lizard (it's safe, or the run starts over): back to watching. */
  callOff() {
    for (const h of this.list) {
      if (h.state === 'hold') continue;
      if (h.state !== 'wait' && h.state !== 'walk') this.toWait(h);
      h.seen = 0;
      h.cool = HERON.cooldown;
    }
  }

  private toWait(h: Heron) {
    // Back to its spot if it strayed; else stand.
    const s = h.home;
    if (Math.hypot(h.pos.x - s.x, h.pos.z - s.z) > 0.05) {
      h.state = 'walk';
      h.goal.set(s.x, 0, s.z);
    } else {
      h.state = 'wait';
      h.timer = this.stay();
    }
  }

  /** Turn toward `yaw` at the heron's rate. */
  private turnTo(h: Heron, yaw: number, dt: number) {
    const d = wrapAngle(yaw - h.yaw);
    h.yaw = wrapAngle(h.yaw + Math.max(-HERON.turn * dt, Math.min(HERON.turn * dt, d)));
    return Math.abs(d);
  }

  /** Walk toward (x, z) at `speed` if the way is wadeable; returns whether it moved. */
  private walkTo(h: Heron, x: number, z: number, speed: number, dt: number) {
    const dx = x - h.pos.x;
    const dz = z - h.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) return false;
    const off = this.turnTo(h, Math.atan2(dx, dz), dt);
    if (off > 0.6) return true;
    const step = Math.min(d, speed * dt);
    const nx = h.pos.x + Math.sin(h.yaw) * step;
    const nz = h.pos.z + Math.cos(h.yaw) * step;
    const s = h.home;
    if (!this.wadeable(nx, nz, s.x, s.z)) return false;
    h.pos.set(nx, this.groundAt(nx, nz, h.pos.y), nz);
    return true;
  }

  /** Head (heron space) easing toward `to`, the bill toward the lizard or ahead and a little down. */
  private headTo(h: Heron, to: THREE.Vector3, rate: number, dt: number, look: boolean) {
    h.head.lerp(to, 1 - Math.exp(-rate * dt));
    if (look) {
      h.body.at.copy(h.pos);
      h.body.yaw = h.yaw;
      h.body.place();
      const head = h.body.toWorld(h.head, this.s);
      const target = this.preyPoints()[0];
      const dir = this.t.subVectors(target, head).normalize();
      // Into heron space (rotation only).
      const c = Math.cos(-h.yaw);
      const sn = Math.sin(-h.yaw);
      const x = dir.x * c + dir.z * sn;
      const z = -dir.x * sn + dir.z * c;
      h.bill.lerp(this.s.set(x, dir.y, z), 1 - Math.exp(-10 * dt)).normalize();
    } else {
      const sway = Math.sin(h.timer * 0.7 + h.index * 2) * 0.5;
      h.bill.lerp(this.s.set(Math.sin(sway), -0.3, Math.cos(sway)), 1 - Math.exp(-2 * dt)).normalize();
    }
  }

  /** One physics step for every heron. */
  step(dt: number) {
    for (const h of this.list) {
      if (h.paused) continue;
      h.keep();
      this.stepOne(h, dt);
      h.stepFeet(dt, (x, z, y) => this.groundAt(x, z, y));
    }
  }

  private lose(h: Heron, why: LostReason) {
    h.cool = HERON.cooldown;
    h.seen = 0;
    this.toWait(h);
    this.onLose?.(h, why);
  }

  private stepOne(h: Heron, dt: number) {
    if (h.cool > 0) h.cool -= dt;
    const sees = this.sees(h);
    h.sees = sees;
    this.prey.feet(this.f);
    const shoulders = h.shoulders(this.p);
    const toPrey = Math.hypot(this.f.x - shoulders.x, this.f.z - shoulders.z);
    switch (h.state) {
      case 'wait':
      case 'walk': {
        if (h.state === 'wait') {
          this.headTo(h, POSE.rest, 3, dt, false);
          h.timer -= dt;
          if (h.timer <= 0) {
            h.spot = (h.spot + 1) % h.spots.length;
            h.state = 'walk';
            h.goal.set(h.home.x, 0, h.home.z);
          }
        } else {
          this.headTo(h, POSE.rest, 3, dt, false);
          const moved = this.walkTo(h, h.goal.x, h.goal.z, HERON.walk, dt);
          if (!moved || Math.hypot(h.goal.x - h.pos.x, h.goal.z - h.pos.z) < 0.02) {
            if (!moved) {
              // Stuck: hop straight to its spot's ground (never happens on the laid-out spots).
              h.pos.set(h.goal.x, this.groundAt(h.goal.x, h.goal.z), h.goal.z);
            }
            h.state = 'wait';
            h.timer = this.stay();
          }
        }
        if (sees && h.cool <= 0) {
          const quick = (this.prey.speed() > 0.04 ? 2.5 : 1) * (toPrey < 0.6 ? 2 : 1);
          h.seen += dt * quick;
          if (h.seen >= HERON.notice) {
            h.state = 'stalk';
            h.timer = 0;
            h.unseen = 0;
            this.onStalk?.(h);
          }
        } else h.seen = Math.max(0, h.seen - dt);
        break;
      }
      case 'stalk': {
        const why = this.hidden();
        if (why) return this.lose(h, why);
        if (!this.prey.huntable()) return this.toWait(h);
        h.unseen = sees ? 0 : h.unseen + dt;
        if (h.unseen > HERON.lostTime) return this.lose(h, 'away');
        this.headTo(h, POSE.stalk, 4, dt, true);
        if (toPrey < HERON.strikeRange) {
          this.turnTo(h, Math.atan2(this.f.x - h.pos.x, this.f.z - h.pos.z), dt);
          h.state = 'aim';
          h.timer = HERON.aimTime;
          break;
        }
        const moved = this.walkTo(h, this.f.x, this.f.z, HERON.stalk, dt);
        h.timer = moved ? 0 : h.timer + dt;
        if (h.timer > HERON.standOff) return this.lose(h, 'away');
        break;
      }
      case 'aim': {
        const why = this.hidden();
        if (why) return this.lose(h, why);
        this.headTo(h, POSE.aim, 8, dt, true);
        this.turnTo(h, Math.atan2(this.f.x - h.pos.x, this.f.z - h.pos.z), dt);
        h.timer -= dt;
        if (h.timer <= 0) {
          if (toPrey > HERON.reach || !sees) {
            h.state = 'stalk';
            break;
          }
          // Stab at where the lizard's middle will be a moment on.
          h.state = 'strike';
          h.timer = 0;
          h.strikes++;
          const pts = this.preyPoints();
          const sp = this.prey.speed();
          const yaw = this.prey.facing();
          h.target.copy(pts[1]);
          h.target.x += Math.sin(yaw) * sp * HERON.strikeTime * 0.6;
          h.target.z += Math.cos(yaw) * sp * HERON.strikeTime * 0.6;
          h.headFrom.copy(h.head);
          // The head goes where the bill's tip lands on the target, as far as the neck reaches.
          h.body.at.copy(h.pos);
          h.body.yaw = h.yaw;
          h.body.place();
          const local = h.body.toLocal(h.target, this.s);
          const sh = this.t.copy(h.body.rest.neck_0);
          const dir = local.clone().sub(sh).normalize();
          const billLen = h.body.billOffset.length();
          const head = local.clone().addScaledVector(dir, -billLen);
          const neck = head.clone().sub(sh);
          if (neck.length() > 0.15) head.copy(sh).addScaledVector(neck.normalize(), 0.15);
          h.headTo.copy(head);
          h.bill.copy(dir);
        }
        break;
      }
      case 'strike': {
        h.timer += dt;
        const t = Math.min(1, h.timer / HERON.strikeTime);
        h.head.lerpVectors(h.headFrom, h.headTo, 1 - (1 - t) * (1 - t));
        const tip = h.billTip(this.s);
        if (this.prey.huntable() && !this.hidden() && this.preyPoints().some((q) => q.distanceTo(tip) < HERON.bite)) {
          h.state = 'hold';
          h.timer = HERON.holdTime;
          h.catches++;
          this.prey.caught(h);
          this.onCatch?.(h);
          break;
        }
        if (t >= 1) {
          h.state = 'recover';
          h.timer = HERON.recoverTime;
        }
        break;
      }
      case 'recover':
      case 'hold': {
        this.headTo(h, h.state === 'hold' ? POSE.rest : POSE.stalk, 3, dt, false);
        h.timer -= dt;
        if (h.timer <= 0) {
          if (h.state === 'recover' && sees) {
            h.state = 'stalk';
            h.unseen = 0;
          } else this.toWait(h);
        }
        break;
      }
    }
  }

  /** Each frame: the drawn herons. */
  update(alpha: number) {
    for (const h of this.list) h.update(alpha);
  }
}
