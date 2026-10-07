import * as THREE from 'three';
import { loadGltf } from '../render/gltf';
import { toonify } from '../render/toon';
import { rng } from '../world/noise';
import { terrainHeight } from '../world/terrain';
import { WATER_Y } from '../world/shore';
import { SUN_OFFSET } from '../render/scene';
import type { Cover } from '../world/cover';
import type { Quarry } from './quarry';
import type { Perch, PerchFit } from './perches';

/**
 * A Galapagos hawk (assets-src/hawk.py), the island's predator. It rests on a high rock or a tree
 * (perches.ts), flying off to a far perch if the lizard comes near, or soars in wide circles over the
 * island, watching. When it sees the lizard (cover.ts: not under water, in a
 * plant, or behind a rock, log, trunk or tree crown) for a moment it comes for it: it circles low
 * over it, then stoops, throws its talons forward and strikes, climbs away and comes round again.
 * Three strikes and the lizard is down (wounds.ts); one or two put a smaller animal down. Then it
 * lands on its kill and eats, and goes back to a perch. Out of its sight for a few seconds, prey is
 * forgotten and the hawk goes back to its rounds. It is drawn, not simulated: no collider, flown
 * along steered paths.
 *
 * It hunts the lizard, the other iguanas and the crabs (quarry.ts), but it picks out the small ones
 * less well and mostly can't be bothered with them. Its shadow going over sends them running.
 */
export type HawkState = 'perch' | 'take_off' | 'soar' | 'stalk' | 'stoop' | 'strike' | 'climb' | 'return' | 'land' | 'feed';


interface Extras {
  strike_time: number;
  land_time: number;
  take_off_time: number;
  /** Talons at the moment of the strike, relative to the origin (glTF axes: +Z forward, Y up). */
  strike_talons: [number, number, number];
  /** The perched feet relative to the origin. */
  perch_feet: [number, number, number];
  /** The perched tail from the feet: [back, out to either side, up] (m). */
  perch_tail: [number, number, number][];
}

/** Flight speeds (m/s) and how fast it changes velocity (m/s²). */
const GLIDE_SPEED = 0.9;
const STALK_SPEED = 0.75;
const CLIMB_SPEED = 0.9;
const STOOP_SPEED = 1.7;
const ACCEL = 1.4;
const STOOP_ACCEL = 3;
/** Its round over the island: centre, radius and height (m). */
export const PATROL = { x: 0.4, z: 0.2, r: 2.0, y: 1.3 };
/** Steering aims this far round a circle ahead of where it is (radians). */
const LOOK_AHEAD = 0.5;
/** Never lower than this over the ground or the sea while just flying (m). */
const CLEARANCE = 0.25;
/** It looks for the lizard this often (s), sees it from up to this far away (m, level distance)... */
const SIGHT_EVERY = 0.1;
const SPOT_RANGE = 3.2;
/** ...and goes for it after seeing it for this long (s; the count runs down at half speed out of sight). */
const SPOT_TIME = 1;
/** Hunting, it circles this wide and this high over the lizard (m)... */
const STALK = { r: 0.55, up: 0.75 };
/** ...for at least this long before the first stoop, and between passes climbs away for this long (s). */
const STALK_FIRST = 2.5;
const STALK_AGAIN = 0.8;
const CLIMB_TIME = 1.6;
/** Out of its sight this long (s), the lizard is forgotten, and it won't look again for a while. */
const LOSE_INTEREST = 3;
const CALM_AFTER_LOSING = 8;
const CALM_AFTER_KILL = 20;
/** A strike lands if the talons come within this of the prey's body (m, outside its spheres). */
const HIT_REACH = 0.012;
/** Of a lizard's spheres, the ones it aims at: head, neck, chest, hips, tail base. A crab has one. */
const TARGET_SPHERES = [1, 2, 3, 4, 5];
const AIM_SPHERE = 3;
/** It only sees an animal when more than this share of those spheres is in plain view. */
const SEEN_SHARE = 0.5;
/** Out of its sight this long in the stoop (s), it pulls up rather than dive into cover. */
const STOOP_BLIND = 0.25;
/**
 * Perched, it's resting, not hunting: the lizard coming this near (m, level and up or down) flushes
 * it, and it flies off to the perch furthest from the lizard and won't hunt for a while (s).
 */
const FLUSH = { near: 0.5, below: 0.6 };
const CALM_AFTER_FLUSH = 12;
/** Having passed over something it decided against, it won't weigh that one again for this long (s). */
const IGNORE_TIME = 12;
/** Standing over a kill, it eats for this long before the last of it is gone (s). */
const FEED_TIME = 9;
/** It lands this far back from the kill, facing it (m). */
const FEED_BACK = 0.025;
/**
 * Its shadow sweeping the ground panics what it crosses: only below this height (m), and everything
 * within this far of the shadow bolts.
 */
const SHADOW_BELOW = 1.1;
const SHADOW_SCARE = 0.13;
/** Where the stoop aims: the lizard's position this far ahead along its velocity (s). */
const LEAD = 0.2;
/** Leaving the strike: forward and up (m/s). */
const PULL_OUT = { forward: 0.7, up: 0.35 };
/** Sits this long on a perch, and soars this long between perches (s, from-to). */
const PERCH_SPELL = [12, 25] as const;
const SOAR_SPELL = [20, 35] as const;
/** Coming in to land: it heads for a point this far behind the perch and above it, then glides in (m). */
const APPROACH = { back: 0.45, up: 0.15, near: 0.15 };
/** Leaving the perch, after the spring: forward and up (m/s). */
const LAUNCH = { forward: 0.6, up: 0.45 };
/** Banking: radians per (rad/s of turn × m/s), at most MAX_BANK; pitch at most MAX_PITCH in level flight. */
const BANK_GAIN = 0.35;
const MAX_BANK = 0.7;
const MAX_PITCH = 0.5;
const STOOP_PITCH = 0.9;
const TURN_RATE = 6;
/** In flight it turns its heading at most this fast (rad/s), and climbs or sinks at most this fast (m/s). */
const TURN_SPEED = 2.2;
const MAX_RISE = 0.45;
const MAX_SINK = 0.7;
/** It only stoops when the lizard is roughly ahead: within this angle of its heading (radians). */
const STOOP_CONE = 0.9;
/** Quiet at the start, so a player has a little while to look around before the hawk notices (s). */
const CALM_AT_START = 25;
const CROSSFADE = 0.25;
const ONE_SHOT = ['strike', 'land', 'take_off'];
const UP = new THREE.Vector3(0, 1, 0);

export class Hawk {
  readonly root: THREE.Object3D;
  state: HawkState = 'perch';
  /** Off: it never hunts (tests turn it off). */
  enabled = true;
  /** Whether it could see what it's hunting at its last look. */
  seesPrey = false;
  /** What it's hunting, or standing over, right now. */
  quarry: Quarry | null = null;
  /** Prey scared off by its shadow, for tests. */
  scared = 0;
  /** Strikes made, and strikes that landed. */
  strikes = 0;
  hitsLanded = 0;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  private prevPos = new THREE.Vector3();
  private quat = new THREE.Quaternion();
  private prevQuat = new THREE.Quaternion();
  private yaw = 0;
  private pitch = 0;
  private bank = 0;
  private stateTime = 0;
  private spell = 0;
  private perch: Perch;
  /** Seconds its quarry has been out of sight while hunting. */
  private unseen = 0;
  private sightTimer = 0;
  /** Won't look for the lizard again until this runs out (s). */
  private calm = CALM_AT_START;
  /** Flushed from its perch by the lizard here: the next perch it picks is as far from it as can be. */
  private awayFrom: THREE.Vector3 | null = null;
  /** How many times the lizard has flushed it off a perch. */
  flushed = 0;
  private stalkFor = STALK_FIRST;
  /** Per prey: seconds of sight building toward a hunt, and how long it stays passed over. */
  private watch: { seen: number; ignore: number }[];
  /** Coming down to a perch, or onto a kill. */
  private landFor: 'perch' | 'feed' = 'perch';
  /** After taking off, hunt rather than soar. */
  private huntNext = false;
  /** A path being followed (strike, landing, take-off): Hermite from p0, v0 to p1, v1 over `time`. */
  private path: { p0: THREE.Vector3; v0: THREE.Vector3; p1: THREE.Vector3; v1: THREE.Vector3; time: number } | null = null;
  private struck = false;
  private mixer: THREE.AnimationMixer;
  private actions: Record<string, THREE.AnimationAction>;
  private current: string | null = null;
  private extras: Extras;
  private talons: THREE.Vector3;
  private rand = rng(17);
  private eye = new THREE.Vector3();
  private aim = new THREE.Vector3();
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');

  private perches: Perch[] = [];

  private constructor(
    gltf: Awaited<ReturnType<typeof loadGltf>>,
    findPerches: (fit: PerchFit) => Perch[],
    private cover: Cover,
    private prey: Quarry[],
  ) {
    this.watch = prey.map(() => ({ seen: 0, ignore: 0 }));
    this.root = gltf.scene;
    toonify(this.root);
    this.root.traverse((o) => (o.frustumCulled = false));
    const rig = this.root.getObjectByName('Hawk');
    if (!rig) throw new Error('hawk.glb has no Hawk armature');
    this.extras = rig.userData as Extras;
    this.talons = new THREE.Vector3(...this.extras.strike_talons);
    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = Object.fromEntries(gltf.animations.map((c) => [c.name, this.mixer.clipAction(c)]));
    for (const name of ONE_SHOT) {
      this.actions[name].setLoop(THREE.LoopOnce, 1);
      this.actions[name].clampWhenFinished = true;
    }
    // Perched with its feet at the origin, how far do its curled toes reach below them?
    this.pos.set(0, this.perchHeight(), 0);
    this.prevPos.copy(this.pos);
    this.update(1, 0);
    this.perches = findPerches({ sole: -this.lowest().feet, tail: this.extras.perch_tail });
    if (this.perches.length === 0) throw new Error('the hawk needs somewhere to perch');
    this.perch = this.perches[0];
    this.spell = this.span(PERCH_SPELL);
    this.sitOn(this.perch);
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.update(1, 0);
  }

  static async load(url: string, scene: THREE.Scene, findPerches: (fit: PerchFit) => Perch[], cover: Cover, prey: Quarry[]) {
    const hawk = new Hawk(await loadGltf(url), findPerches, cover, prey);
    scene.add(hawk.root);
    return hawk;
  }

  get clip(): string | null {
    return this.current;
  }

  get clipNames(): string[] {
    return Object.keys(this.actions);
  }

  /** After the hunt: going for its quarry, or about to. */
  get hunting(): boolean {
    return this.state === 'stalk' || this.state === 'stoop' || this.state === 'strike' || this.state === 'climb' || (this.state === 'take_off' && this.huntNext);
  }

  /** Standing on a kill, eating it. */
  get feeding(): boolean {
    return this.state === 'feed';
  }

  /**
   * The lowest drawn point of its toes and of its tail (world y), from the skinned mesh as it's posed
   * now: to check that a perched hawk stands on its feet.
   */
  lowest(): { feet: number; tail: number } {
    this.root.updateMatrixWorld(true);
    const out = { feet: Infinity, tail: Infinity };
    const v = new THREE.Vector3();
    this.root.traverse((o) => {
      if (!(o instanceof THREE.SkinnedMesh)) return;
      const bones = o.skeleton.bones;
      const index = o.geometry.getAttribute('skinIndex');
      const weight = o.geometry.getAttribute('skinWeight');
      for (let i = 0; i < index.count; i++) {
        let best = 0;
        for (let k = 1; k < 4; k++) if (weight.getComponent(i, k) > weight.getComponent(i, best)) best = k;
        const name = bones[index.getComponent(i, best)].name;
        const part = /^(toes|hallux|shank)/.test(name) ? 'feet' : name === 'tail' ? 'tail' : null;
        if (!part) continue;
        o.getVertexPosition(i, v);
        o.localToWorld(v);
        out[part] = Math.min(out[part], v.y);
      }
    });
    return out;
  }

  /** Put it straight onto perch `i`, sitting (tests). */
  sitAt(i: number) {
    this.perch = this.perches[i];
    this.goTo('perch');
    this.sitOn(this.perch);
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
  }

  /** Where it can perch. */
  get perchSpots(): readonly Perch[] {
    return this.perches;
  }

  /** The perch it's on or heading for. */
  get perchIndex(): number {
    return this.perches.indexOf(this.perch);
  }

  /**
   * Tests: 'hunt' goes for the lizard at once wherever it is, 'hunt_iguana' and 'hunt_crab' for the
   * nearest of those, 'off' stops hunting for good, 'on' allows it again.
   */
  request(action: 'hunt' | 'hunt_iguana' | 'hunt_crab' | 'off' | 'on' | 'perch' | 'soar') {
    if (action === 'off') {
      this.enabled = false;
      this.quarry = null;
      if (this.hunting) this.giveUp(0);
    } else if (action === 'on') {
      this.enabled = true;
    } else if (action === 'hunt' || action === 'hunt_iguana' || action === 'hunt_crab') {
      const kind = action === 'hunt' ? 'player' : action === 'hunt_iguana' ? 'iguana' : 'crab';
      const pick = this.prey.filter((p) => p.kind === kind && p.available).sort((a, b) => this.flatTo(a) - this.flatTo(b))[0];
      if (!pick) return;
      this.enabled = true;
      this.calm = 0;
      this.quarry = pick;
      this.startHunt();
    } else if (action === 'perch') {
      if (this.state !== 'perch' && this.state !== 'land') this.goTo('return');
    } else if (this.state === 'perch') {
      this.takeOff(false);
    }
  }

  /** Advance one fixed step. */
  step(dt: number) {
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.stateTime += dt;
    this.calm = Math.max(0, this.calm - dt);
    this.look(dt);
    switch (this.state) {
      case 'perch':
        this.stepPerch();
        break;
      case 'take_off':
        this.stepTakeOff(dt);
        break;
      case 'soar':
        this.stepSoar(dt);
        break;
      case 'stalk':
        this.stepStalk(dt);
        break;
      case 'stoop':
        this.stepStoop(dt);
        break;
      case 'strike':
        this.stepStrike(dt);
        break;
      case 'climb':
        this.stepClimb(dt);
        break;
      case 'return':
        this.stepReturn(dt);
        break;
      case 'land':
        this.stepLand();
        break;
      case 'feed':
        this.stepFeed(dt);
        break;
    }
    this.orient(dt);
    this.castShadow();
    for (const p of this.prey) p.hunted(this.hunting && p === this.quarry);
  }

  /**
   * Its shadow sweeping the ground: anything it passes close to bolts. Only when it's low enough for
   * the shadow to be sharp, and never while it's on the ground itself.
   */
  private castShadow() {
    if (this.state === 'perch' || this.state === 'feed') return;
    const ground = Math.max(terrainHeight(this.pos.x, this.pos.z), WATER_Y);
    const up = this.pos.y - ground;
    if (up > SHADOW_BELOW) return;
    const t = up / SUN_OFFSET.y;
    const x = this.pos.x - SUN_OFFSET.x * t;
    const z = this.pos.z - SUN_OFFSET.z * t;
    for (const p of this.prey) {
      if (!p.available) continue;
      const f = p.feet(this.v);
      if (Math.hypot(f.x - x, f.z - z) < SHADOW_SCARE && p.scare(x, z)) this.scared++;
    }
  }

  /** Draw it between the last two steps. */
  update(alpha: number, dt: number) {
    this.root.position.lerpVectors(this.prevPos, this.pos, alpha);
    this.root.quaternion.slerpQuaternions(this.prevQuat, this.quat, alpha);
    this.pickClip();
    this.mixer.update(dt);
  }

  // ------------------------------------------------------------------ looking

  /** Every SIGHT_EVERY, look the island over: keep its quarry in sight, or pick something out. */
  private look(dt: number) {
    this.sightTimer -= dt;
    const now = this.sightTimer <= 0;
    if (now) this.sightTimer = SIGHT_EVERY;
    if (this.hunting || this.state === 'feed') {
      const q = this.quarry;
      if (now) this.seesPrey = !!q && this.canSee(q);
      if (this.state === 'feed') return;
      // Out of reach (the lizard got onto the tortoise): it pulls out at once, even mid-dive.
      if (!q || !q.available || q.safe) return this.giveUp(CALM_AFTER_LOSING);
      this.unseen = this.seesPrey ? 0 : this.unseen + dt;
      if (this.unseen >= LOSE_INTEREST && this.state !== 'strike') this.giveUp(CALM_AFTER_LOSING);
      return;
    }
    // Coming down onto a kill, it has what it wants and looks at nothing else.
    // Perched it's resting, not hunting; on the wing it looks about.
    const watching = this.state === 'soar' || (this.state === 'return' && this.landFor === 'perch');
    if (!watching || this.calm > 0 || !this.enabled) {
      for (const w of this.watch) w.seen = 0;
      this.seesPrey = false;
      return;
    }
    if (!now) return;
    this.seesPrey = false;
    for (const [i, p] of this.prey.entries()) {
      const w = this.watch[i];
      w.ignore = Math.max(0, w.ignore - SIGHT_EVERY);
      const visible = p.available && !p.down && this.canSee(p);
      this.seesPrey = this.seesPrey || visible;
      // The smaller the animal, the longer the hawk takes to be sure of what it's looking at.
      w.seen = visible ? w.seen + SIGHT_EVERY * p.acuity : Math.max(0, w.seen - SIGHT_EVERY / 2);
      if (w.seen < SPOT_TIME || w.ignore > 0) continue;
      w.seen = 0;
      // Worth the dive? Always for the lizard, often for an iguana, now and then for a crab.
      if (this.rand() < p.appeal) {
        this.quarry = p;
        this.startHunt();
        return;
      }
      w.ignore = IGNORE_TIME;
    }
  }

  private canSee(p: Quarry): boolean {
    if (!this.enabled || !p.available || p.safe) return false;
    if (p.down) return true;
    const spheres = p.spheres;
    const mid = spheres[Math.min(AIM_SPHERE, spheres.length - 1)];
    if (!this.hunting && Math.hypot(mid.x - this.pos.x, mid.z - this.pos.z) > SPOT_RANGE * p.acuity) return false;
    // Its eyes are a little ahead of and above its middle.
    this.eye.set(0, 0.008, 0.026).applyQuaternion(this.quat).add(this.pos);
    return this.inView(p, this.eye).sees;
  }

  /**
   * How much of `p` is in plain view from `eye`: a head or a tail poking out of cover isn't enough,
   * the hawk has to see most of the body.
   */
  inView(p: Quarry, eye: THREE.Vector3) {
    const spheres = this.aimSpheres(p);
    let seen = 0;
    for (const s of spheres) if (this.cover.inSight(eye, s, p.body)) seen++;
    return { seen, of: spheres.length, sees: seen > spheres.length * SEEN_SHARE };
  }

  /** The spheres of `p` the hawk watches and strikes at. */
  private aimSpheres(p: Quarry): readonly { x: number; y: number; z: number; r: number }[] {
    const spheres = p.spheres;
    return spheres.length > TARGET_SPHERES.length ? TARGET_SPHERES.map((i) => spheres[i]) : spheres;
  }

  /** Level distance to a quarry. */
  private flatTo(p: Quarry): number {
    const f = p.feet(this.v2);
    return Math.hypot(f.x - this.pos.x, f.z - this.pos.z);
  }

  private startHunt() {
    if (!this.quarry) return;
    this.unseen = 0;
    this.stalkFor = STALK_FIRST;
    if (this.state === 'perch' || this.state === 'land') this.takeOff(true);
    else if (this.state !== 'take_off') this.goTo('stalk');
    else this.huntNext = true;
  }

  /** Stop hunting; won't look again for `calm` seconds. Back to its round, or to a perch after a kill. */
  private giveUp(calm: number) {
    this.calm = calm;
    this.quarry = null;
    for (const w of this.watch) w.seen = 0;
    this.huntNext = false;
    if (this.state === 'take_off') return;
    this.goTo(calm >= CALM_AFTER_KILL ? 'return' : 'soar');
  }

  // ------------------------------------------------------------------ states

  private goTo(state: HawkState) {
    this.state = state;
    this.stateTime = 0;
    this.path = null;
    if (state === 'soar') this.spell = this.span(SOAR_SPELL);
    if (state === 'return') {
      this.landFor = 'perch';
      this.perch = this.choosePerch();
    }
    if (state === 'stoop') this.strikes++;
  }

  private stepPerch() {
    this.sitOn(this.perch);
    this.vel.set(0, 0, 0);
    const lizard = this.prey.find((p) => p.kind === 'player');
    if (this.enabled && lizard && !lizard.down) {
      const f = lizard.feet(this.v);
      const p = this.perch;
      if (Math.hypot(f.x - p.x, f.z - p.z) < FLUSH.near && p.y - f.y < FLUSH.below) {
        this.flushed++;
        this.awayFrom = f.clone();
        this.calm = Math.max(this.calm, CALM_AFTER_FLUSH);
        this.takeOff(false);
        return;
      }
    }
    if (this.stateTime >= this.spell) this.takeOff(false);
  }

  private takeOff(hunt: boolean) {
    this.huntNext = hunt;
    this.goTo('take_off');
    this.restart('take_off');
    const f = this.forward(this.v);
    this.path = {
      p0: this.pos.clone(),
      v0: new THREE.Vector3(),
      p1: this.pos.clone().addScaledVector(f, 0.12).add(new THREE.Vector3(0, 0.12, 0)),
      v1: f.clone().multiplyScalar(LAUNCH.forward).add(new THREE.Vector3(0, LAUNCH.up, 0)),
      time: 0.35,
    };
  }

  private stepTakeOff(dt: number) {
    const t = this.stateTime - this.extras.take_off_time;
    if (t < 0) return;
    if (t <= this.path!.time) {
      this.follow(t);
      return;
    }
    // Then flap on up and away.
    this.steer(this.v.copy(this.pos).addScaledVector(this.forward(this.v2), 1).setY(this.pos.y + 0.5), CLIMB_SPEED, ACCEL, dt);
    if (this.actions.take_off.time >= this.actions.take_off.getClip().duration - 1e-3) {
      if (this.huntNext) {
        this.huntNext = false;
        this.goTo('stalk');
      } else this.goTo(this.awayFrom ? 'return' : 'soar');
    }
  }

  private stepSoar(dt: number) {
    const a = Math.atan2(this.pos.z - PATROL.z, this.pos.x - PATROL.x) + LOOK_AHEAD;
    this.v.set(PATROL.x + Math.cos(a) * PATROL.r, PATROL.y, PATROL.z + Math.sin(a) * PATROL.r);
    this.steer(this.v, GLIDE_SPEED, ACCEL, dt);
    if (this.stateTime >= this.spell) this.goTo('return');
  }

  /** Circle over its quarry, then swing in over it and stoop. */
  private stepStalk(dt: number) {
    const c = this.preyFeet(this.aim);
    if (this.quarry!.down) {
      this.goDown();
      return;
    }
    // Once it has circled long enough it stops circling and comes in over the top, lining up the dive.
    const ready = this.stateTime >= this.stalkFor && this.seesPrey && this.enabled;
    if (ready) {
      this.v.set(c.x, c.y + STALK.up, c.z);
    } else {
      const a = Math.atan2(this.pos.z - c.z, this.pos.x - c.x) + LOOK_AHEAD;
      this.v.set(c.x + Math.cos(a) * STALK.r, c.y + STALK.up, c.z + Math.sin(a) * STALK.r);
    }
    this.steer(this.v, STALK_SPEED, ACCEL, dt);
    const close = Math.abs(this.pos.y - (c.y + STALK.up)) < 0.25 && Math.hypot(this.pos.x - c.x, this.pos.z - c.z) < STALK.r * 1.6;
    const off = Math.atan2(c.x - this.pos.x, c.z - this.pos.z) - Math.atan2(this.vel.x, this.vel.z);
    const ahead = Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) < STOOP_CONE;
    if (ready && close && ahead) this.goTo('stoop');
  }

  /** Dive at the lizard; when the strike's timing is reached, commit to it. */
  private stepStoop(dt: number) {
    const target = this.strikeOrigin(this.aim, this.v2);
    const dist = this.pos.distanceTo(target);
    const speed = this.vel.length();
    if (dist <= Math.max(speed, 0.4) * this.extras.strike_time) {
      this.startStrike(target);
      return;
    }
    this.dive(target, STOOP_SPEED, STOOP_ACCEL, dt);
    if (this.stateTime > 4 || this.unseen > STOOP_BLIND) this.goTo('climb');
  }

  /**
   * Where the hawk's middle must be at the strike for its talons to meet the lizard's chest (out
   * `origin`), facing from where it is now; the lizard is led a little along its velocity. The
   * level direction it'll be facing comes back in `dir`.
   */
  private strikeOrigin(origin: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 {
    const spheres = this.aimSpheres(this.quarry!);
    const chest = spheres[Math.min(2, spheres.length - 1)];
    const pv = this.quarry!.velocity;
    origin.set(chest.x + pv.x * LEAD, chest.y, chest.z + pv.z * LEAD);
    dir.set(origin.x - this.pos.x, 0, origin.z - this.pos.z);
    if (dir.lengthSq() < 1e-8) this.forward(dir);
    dir.normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    return origin.sub(this.v.copy(this.talons).applyAxisAngle(UP, yaw));
  }

  private startStrike(origin: THREE.Vector3) {
    this.goTo('strike');
    this.restart('strike');
    this.struck = false;
    const dir = this.v.set(origin.x - this.pos.x, 0, origin.z - this.pos.z).normalize();
    this.path = {
      p0: this.pos.clone(),
      v0: this.vel.clone(),
      p1: origin.clone(),
      v1: dir.clone().multiplyScalar(PULL_OUT.forward).add(new THREE.Vector3(0, PULL_OUT.up * 0.3, 0)),
      time: this.extras.strike_time,
    };
  }

  private stepStrike(dt: number) {
    const path = this.path!;
    if (this.stateTime < path.time) {
      this.follow(this.stateTime);
    } else if (!this.struck) {
      // The moment of the strike: exactly where the path ends.
      this.follow(path.time);
      this.contact();
    } else {
      // Pull out: forward and up, beating away.
      this.v.copy(path.v1).setY(0).normalize().multiplyScalar(PULL_OUT.forward).setY(PULL_OUT.up);
      this.vel.lerp(this.v, 1 - Math.exp(-4 * dt));
      this.pos.addScaledVector(this.vel, dt);
      this.keepUp(0.04);
    }
    if (this.actions.strike.time >= this.actions.strike.getClip().duration - 1e-3) {
      // That one finished it: turn straight round and come down on it rather than climbing away.
      if (this.quarry!.down) this.goDown();
      else this.goTo('climb');
    }
  }

  /** The talons meet whatever is there: did they catch it? */
  private contact() {
    this.struck = true;
    const t = this.v.copy(this.talons).applyQuaternion(this.quat).add(this.pos);
    // Gone mostly into cover at the last moment, the talons close on rock.
    const open = this.quarry!.down || this.canSee(this.quarry!);
    const hit = open && this.aimSpheres(this.quarry!).some((s) => Math.hypot(s.x - t.x, s.y - t.y, s.z - t.z) < s.r + HIT_REACH);
    if (hit && this.quarry!.strike(this.path!.v1.x, this.path!.v1.z)) this.hitsLanded++;
  }

  private stepClimb(dt: number) {
    const c = this.preyFeet(this.aim);
    // On along its line, rising back to the height it circles at.
    this.v.copy(this.vel).setY(0);
    if (this.v.lengthSq() < 1e-6) this.forward(this.v);
    this.v.normalize().multiplyScalar(1).add(this.pos).setY(c.y + STALK.up + 0.15);
    this.steer(this.v, CLIMB_SPEED, ACCEL, dt);
    if (this.stateTime >= CLIMB_TIME) {
      if (this.quarry!.down) {
        this.goDown();
        return;
      }
      this.goTo('stalk');
      this.stalkFor = STALK_AGAIN;
    }
  }

  /** Its quarry is down: come round and land on it to eat. */
  private goDown() {
    const f = this.preyFeet(this.v2);
    // A little back from it, facing it, so the feeding clip reaches down onto the body.
    const yaw = Math.atan2(f.x - this.pos.x, f.z - this.pos.z);
    this.goTo('return');
    this.landFor = 'feed';
    this.perch = { x: f.x - Math.sin(yaw) * FEED_BACK, y: f.y, z: f.z - Math.cos(yaw) * FEED_BACK, yaw, on: 'kill' };
  }

  /** Standing over the kill, eating: until it's gone, or until the lizard comes back at the spawn. */
  private stepFeed(dt: number) {
    this.sitOn(this.perch);
    this.vel.set(0, 0, 0);
    const q = this.quarry;
    if (!q) return this.doneFeeding();
    if (q.kind === 'player') {
      // It stands over the lizard until the lizard is back on its feet, then leaves.
      if (!q.down) return this.doneFeeding();
    } else if (this.stateTime >= FEED_TIME) {
      q.eaten();
      return this.doneFeeding();
    }
    void dt;
  }

  private doneFeeding() {
    this.quarry = null;
    for (const w of this.watch) w.seen = 0;
    this.calm = CALM_AFTER_KILL;
    this.takeOff(false);
  }

  private stepReturn(dt: number) {
    const p = this.perch;
    const back = this.v2.set(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    const approach = this.v.set(p.x + back.x * APPROACH.back, p.y + this.perchHeight() + APPROACH.up, p.z + back.z * APPROACH.back);
    if (this.pos.distanceTo(approach) < APPROACH.near) {
      this.startLanding();
      return;
    }
    // Far off, keep up at its cruising height; close in, come down to the approach.
    const far = Math.hypot(approach.x - this.pos.x, approach.z - this.pos.z);
    if (far > 1.2) approach.y = Math.max(approach.y, PATROL.y * 0.8);
    this.steer(approach, far > 0.6 ? GLIDE_SPEED : STALK_SPEED, ACCEL, dt, far > 0.6);
  }

  private startLanding() {
    this.goTo('land');
    this.restart('land');
    const p = this.perch;
    const to = new THREE.Vector3(p.x, p.y + this.perchHeight(), p.z);
    this.path = { p0: this.pos.clone(), v0: this.vel.clone(), p1: to, v1: new THREE.Vector3(), time: this.extras.land_time };
  }

  private stepLand() {
    if (this.stateTime <= this.path!.time) {
      this.follow(this.stateTime);
      return;
    }
    this.sitOn(this.perch);
    this.vel.set(0, 0, 0);
    if (this.actions.land.time >= this.actions.land.getClip().duration - 1e-3) {
      if (this.landFor === 'feed') {
        const spot = this.perch;
        this.goTo('feed');
        this.perch = spot;
        return;
      }
      this.goTo('perch');
      this.spell = this.span(PERCH_SPELL);
      this.awayFrom = null;
    }
  }

  // ------------------------------------------------------------------ flying

  /**
   * Fly toward `target` the way a bird does: turning its heading at most TURN_SPEED rad/s (never
   * stopping to back up), easing its level speed toward `speed` and its climb or descent toward
   * what the height difference asks, by at most `accel` m/s².
   */
  private steer(target: THREE.Vector3, speed: number, accel: number, dt: number, keepUp = true) {
    const dx = target.x - this.pos.x;
    const dz = target.z - this.pos.z;
    let level = Math.hypot(this.vel.x, this.vel.z);
    let heading = level > 1e-4 ? Math.atan2(this.vel.x, this.vel.z) : this.yaw;
    if (Math.hypot(dx, dz) > 1e-4) {
      const turn = Math.atan2(Math.sin(Math.atan2(dx, dz) - heading), Math.cos(Math.atan2(dx, dz) - heading));
      heading += THREE.MathUtils.clamp(turn, -TURN_SPEED * dt, TURN_SPEED * dt);
    }
    const dv = accel * dt;
    level += THREE.MathUtils.clamp(speed - level, -dv, dv);
    const vy = THREE.MathUtils.clamp((target.y - this.pos.y) * 2.5, -MAX_SINK, MAX_RISE);
    this.vel.set(Math.sin(heading) * level, this.vel.y + THREE.MathUtils.clamp(vy - this.vel.y, -dv, dv), Math.cos(heading) * level);
    this.pos.addScaledVector(this.vel, dt);
    if (keepUp) this.keepUp(CLEARANCE);
  }

  /** Dive straight at `target`, speeding up to `speed`. */
  private dive(target: THREE.Vector3, speed: number, accel: number, dt: number) {
    const want = this.v2.copy(target).sub(this.pos);
    const d = want.length();
    if (d > 1e-5) want.multiplyScalar(speed / d);
    const dv = want.sub(this.vel);
    const max = accel * dt;
    if (dv.length() > max) dv.setLength(max);
    this.vel.add(dv);
    this.pos.addScaledVector(this.vel, dt);
  }

  /** Stay at least `margin` over the ground and the sea. */
  private keepUp(margin: number) {
    const floor = Math.max(terrainHeight(this.pos.x, this.pos.z), WATER_Y) + margin;
    if (this.pos.y < floor) {
      this.pos.y += (floor - this.pos.y) * 0.2;
      this.vel.y = Math.max(this.vel.y, 0);
    }
  }

  /** Hermite path position and velocity at time t. */
  private follow(t: number) {
    const { p0, v0, p1, v1, time } = this.path!;
    const s = Math.min(1, t / time);
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    this.pos.set(0, 0, 0).addScaledVector(p0, h00).addScaledVector(v0, h10 * time).addScaledVector(p1, h01).addScaledVector(v1, h11 * time);
    const d00 = 6 * s2 - 6 * s;
    const d10 = 3 * s2 - 4 * s + 1;
    const d01 = -6 * s2 + 6 * s;
    const d11 = 3 * s2 - 2 * s;
    this.vel.set(0, 0, 0).addScaledVector(p0, d00 / time).addScaledVector(v0, d10).addScaledVector(p1, d01 / time).addScaledVector(v1, d11);
  }

  /** Face along the flight: yaw with the level velocity, pitch with the climb or dive, bank into turns. */
  private orient(dt: number) {
    const s = this.state;
    const sitting =
      s === 'perch' || s === 'feed' || (s === 'land' && this.stateTime > this.path!.time) || (s === 'take_off' && this.stateTime < this.extras.take_off_time);
    let yaw = this.yaw;
    let pitch = 0;
    const level = Math.hypot(this.vel.x, this.vel.z);
    if (sitting) {
      yaw = this.perch.yaw;
    } else if (level > 0.05) {
      yaw = Math.atan2(this.vel.x, this.vel.z);
      // The clips themselves pitch the body in the strike, landing and take-off.
      if (s !== 'strike' && s !== 'land' && s !== 'take_off') {
        const max = s === 'stoop' ? STOOP_PITCH : MAX_PITCH;
        pitch = THREE.MathUtils.clamp(Math.atan2(-this.vel.y, level), -max, max);
      }
    }
    const turn = Math.atan2(Math.sin(yaw - this.yaw), Math.cos(yaw - this.yaw));
    const rate = dt > 0 ? turn / dt : 0;
    const ease = 1 - Math.exp(-TURN_RATE * dt);
    this.yaw += turn * (sitting ? 1 : ease);
    this.pitch += (pitch - this.pitch) * ease;
    const bank = sitting || s === 'land' ? 0 : THREE.MathUtils.clamp(-rate * ease * level * BANK_GAIN, -MAX_BANK, MAX_BANK);
    this.bank += (bank - this.bank) * ease;
    this.quat.setFromEuler(this.e.set(this.pitch, this.yaw, this.bank, 'YXZ'));
  }

  // ------------------------------------------------------------------ clips

  private pickClip() {
    const s = this.state;
    if (s === 'perch') this.play('perch');
    else if (s === 'stoop') this.play('stoop', 0.15);
    else if (s === 'soar' || s === 'stalk' || s === 'climb' || s === 'return') {
      // Beat the wings climbing or slow, glide otherwise.
      const flap = this.vel.y > 0.12 || this.vel.length() < 0.55 || s === 'climb';
      if (flap) this.play('flap');
      else if (this.current !== 'flap' || this.actions.flap.time < 0.05) this.play('glide', 0.4);
    } else if (s === 'feed') this.play('feed', 0.3);
    else if (s === 'land' && this.actions.land.time >= this.actions.land.getClip().duration - 1e-3) this.play('perch');
  }

  private play(name: string, fade = CROSSFADE) {
    if (this.current === name) return;
    const next = this.actions[name];
    next.reset().play();
    const prev = this.current ? this.actions[this.current] : null;
    if (prev) next.crossFadeFrom(prev, fade, false);
    this.current = name;
  }

  /** Start a one-shot clip from its beginning, even if it was the last one played. */
  private restart(name: string) {
    if (this.current === name) this.current = null;
    this.play(name, 0.12);
  }

  // ------------------------------------------------------------------ helpers

  /** Its quarry's feet, out. */
  private preyFeet(out: THREE.Vector3): THREE.Vector3 {
    return this.quarry!.feet(out);
  }

  private sitOn(p: Perch) {
    this.pos.set(p.x, p.y + this.perchHeight(), p.z);
    this.yaw = p.yaw;
    this.pitch = this.bank = 0;
    this.quat.setFromAxisAngle(UP, p.yaw);
  }

  /** How high its middle sits over its feet when perched. */
  private perchHeight(): number {
    return -this.extras.perch_feet[1];
  }

  private forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  private choosePerch(): Perch {
    // Put off its perch by the lizard: as far from it as it can get.
    const from = this.awayFrom;
    if (from) return this.perches.reduce((a, b) => (Math.hypot(b.x - from.x, b.z - from.z) > Math.hypot(a.x - from.x, a.z - from.z) ? b : a));
    // Somewhere other than where it just was, when it can.
    const others = this.perches.filter((p) => p !== this.perch);
    const pool = others.length ? others : this.perches;
    return pool[Math.floor(this.rand() * pool.length)];
  }

  private span([a, b]: readonly [number, number]): number {
    return a + (b - a) * this.rand();
  }
}
