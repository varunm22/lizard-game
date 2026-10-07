import * as THREE from 'three';
import { loadGltf } from '../render/gltf';
import { toonify } from '../render/toon';
import { rng } from '../world/noise';
import { terrainHeight } from '../world/terrain';
import { WATER_Y } from '../world/shore';
import type { Cover } from '../world/cover';
import type { PlayerController } from '../player/controller';
import type { LizardModel } from '../player/lizardModel';
import type { Wounds } from '../player/wounds';

/**
 * A Galapagos hawk (assets-src/hawk.py), the island's predator. It sits on a high rock watching, or
 * soars in wide circles over the island. When it sees the lizard (cover.ts: not under water, in a
 * plant, or behind a rock, log, trunk or tree crown) for a moment it comes for it: it circles low
 * over it, then stoops, throws its talons forward and strikes, climbs away and comes round again.
 * Three strikes and the lizard is down (wounds.ts); the hawk has had its kill and goes back to a
 * perch. Out of its sight for a few seconds, the lizard is forgotten and the hawk goes back to its
 * rounds. It is drawn, not simulated: no collider, flown along steered paths.
 *
 * For now it only hunts the player; crabs and the other iguanas are left alone.
 */
export type HawkState = 'perch' | 'take_off' | 'soar' | 'stalk' | 'stoop' | 'strike' | 'climb' | 'return' | 'land';

/** Where the hawk can sit: a point on top of something high, and the way it faces there. */
export interface Perch {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface Extras {
  strike_time: number;
  land_time: number;
  take_off_time: number;
  /** Talons at the moment of the strike, relative to the origin (glTF axes: +Z forward, Y up). */
  strike_talons: [number, number, number];
  /** The perched feet relative to the origin. */
  perch_feet: [number, number, number];
}

/** Flight speeds (m/s) and how fast it changes velocity (m/s²). */
const GLIDE_SPEED = 0.9;
const STALK_SPEED = 0.75;
const CLIMB_SPEED = 0.9;
const STOOP_SPEED = 1.7;
const ACCEL = 1.4;
const STOOP_ACCEL = 3;
/** Its round over the island: centre, radius and height (m). */
const PATROL = { x: 0.4, z: 0.2, r: 2.0, y: 1.3 };
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
/** A strike lands if the talons come within this of the lizard's body (m, outside its spheres). */
const HIT_REACH = 0.012;
/** The body spheres it aims at and strikes: head, neck, chest, hips, tail base (LizardModel.bodySpheres). */
const TARGET_SPHERES = [1, 2, 3, 4, 5];
const AIM_SPHERE = 3;
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
  /** Whether it could see the lizard at its last look. */
  seesPrey = false;
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
  /** Seconds of sight of the lizard building toward a hunt; seconds out of sight while hunting. */
  private seen = 0;
  private unseen = 0;
  private sightTimer = 0;
  /** Won't look for the lizard again until this runs out (s). */
  private calm = CALM_AT_START;
  private stalkFor = STALK_FIRST;
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

  private constructor(
    gltf: Awaited<ReturnType<typeof loadGltf>>,
    private perches: Perch[],
    private cover: Cover,
    private player: PlayerController,
    private lizard: LizardModel,
    private wounds: Wounds,
  ) {
    if (perches.length === 0) throw new Error('the hawk needs somewhere to perch');
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
    this.perch = perches[0];
    this.spell = this.span(PERCH_SPELL);
    this.sitOn(this.perch);
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.update(1, 0);
  }

  static async load(url: string, scene: THREE.Scene, perches: Perch[], cover: Cover, player: PlayerController, lizard: LizardModel, wounds: Wounds) {
    const hawk = new Hawk(await loadGltf(url), perches, cover, player, lizard, wounds);
    scene.add(hawk.root);
    return hawk;
  }

  get clip(): string | null {
    return this.current;
  }

  get clipNames(): string[] {
    return Object.keys(this.actions);
  }

  /** After the hunt: going for the lizard, or about to. */
  get hunting(): boolean {
    return this.state === 'stalk' || this.state === 'stoop' || this.state === 'strike' || this.state === 'climb' || (this.state === 'take_off' && this.huntNext);
  }

  /** The perch it's on or heading for. */
  get perchIndex(): number {
    return this.perches.indexOf(this.perch);
  }

  /** Tests: 'hunt' goes for the lizard at once wherever it is, 'off' stops hunting for good, 'on' allows it again. */
  request(action: 'hunt' | 'off' | 'on' | 'perch' | 'soar') {
    if (action === 'off') {
      this.enabled = false;
      if (this.hunting) this.giveUp(0);
    } else if (action === 'on') {
      this.enabled = true;
    } else if (action === 'hunt') {
      this.enabled = true;
      this.calm = 0;
      this.seen = SPOT_TIME;
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
    }
    this.orient(dt);
    this.wounds.hunted = this.hunting;
  }

  /** Draw it between the last two steps. */
  update(alpha: number, dt: number) {
    this.root.position.lerpVectors(this.prevPos, this.pos, alpha);
    this.root.quaternion.slerpQuaternions(this.prevQuat, this.quat, alpha);
    this.pickClip();
    this.mixer.update(dt);
  }

  // ------------------------------------------------------------------ looking

  /** Every SIGHT_EVERY, check whether the lizard is in sight; build up to a hunt, or lose it. */
  private look(dt: number) {
    this.sightTimer -= dt;
    if (this.sightTimer <= 0) {
      this.sightTimer = SIGHT_EVERY;
      this.seesPrey = this.canSee();
    }
    if (this.hunting) {
      this.unseen = this.seesPrey ? 0 : this.unseen + dt;
      if (this.unseen >= LOSE_INTEREST && this.state !== 'strike') this.giveUp(CALM_AFTER_LOSING);
      return;
    }
    const watching = this.state === 'perch' || this.state === 'soar' || this.state === 'return';
    if (!watching || this.calm > 0 || !this.enabled) {
      this.seen = 0;
      return;
    }
    this.seen = this.seesPrey ? this.seen + dt : Math.max(0, this.seen - dt / 2);
    if (this.seen >= SPOT_TIME) this.startHunt();
  }

  private canSee(): boolean {
    if (!this.enabled || this.wounds.down) return false;
    const spheres = this.lizard.bodySpheres;
    const chest = spheres[AIM_SPHERE];
    if (!this.hunting && Math.hypot(chest.x - this.pos.x, chest.z - this.pos.z) > SPOT_RANGE) return false;
    // Its eyes are a little ahead of and above its middle.
    this.eye.set(0, 0.008, 0.026).applyQuaternion(this.quat).add(this.pos);
    return TARGET_SPHERES.some((i) => this.cover.inSight(this.eye, spheres[i], this.player.body));
  }

  private startHunt() {
    this.unseen = 0;
    this.stalkFor = STALK_FIRST;
    if (this.state === 'perch' || this.state === 'land') this.takeOff(true);
    else if (this.state !== 'take_off') this.goTo('stalk');
    else this.huntNext = true;
  }

  /** Stop hunting; won't look again for `calm` seconds. Back to its round, or to a perch after a kill. */
  private giveUp(calm: number) {
    this.calm = calm;
    this.seen = 0;
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
    if (state === 'return') this.perch = this.choosePerch();
    if (state === 'stoop') this.strikes++;
  }

  private stepPerch() {
    this.sitOn(this.perch);
    this.vel.set(0, 0, 0);
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
      } else this.goTo('soar');
    }
  }

  private stepSoar(dt: number) {
    const a = Math.atan2(this.pos.z - PATROL.z, this.pos.x - PATROL.x) + LOOK_AHEAD;
    this.v.set(PATROL.x + Math.cos(a) * PATROL.r, PATROL.y, PATROL.z + Math.sin(a) * PATROL.r);
    this.steer(this.v, GLIDE_SPEED, ACCEL, dt);
    if (this.stateTime >= this.spell) this.goTo('return');
  }

  /** Circle over the lizard; stoop once it has circled long enough and can see it. */
  private stepStalk(dt: number) {
    const c = this.preyFeet(this.aim);
    const a = Math.atan2(this.pos.z - c.z, this.pos.x - c.x) + LOOK_AHEAD;
    this.v.set(c.x + Math.cos(a) * STALK.r, c.y + STALK.up, c.z + Math.sin(a) * STALK.r);
    this.steer(this.v, STALK_SPEED, ACCEL, dt);
    if (this.wounds.down) {
      this.giveUp(CALM_AFTER_KILL);
      return;
    }
    const close = Math.abs(this.pos.y - (c.y + STALK.up)) < 0.25 && Math.hypot(this.pos.x - c.x, this.pos.z - c.z) < STALK.r * 1.6;
    const off = Math.atan2(c.x - this.pos.x, c.z - this.pos.z) - Math.atan2(this.vel.x, this.vel.z);
    const ahead = Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) < STOOP_CONE;
    if (this.stateTime >= this.stalkFor && this.seesPrey && close && ahead && this.enabled) this.goTo('stoop');
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
    if (this.stateTime > 4) this.goTo('climb');
  }

  /**
   * Where the hawk's middle must be at the strike for its talons to meet the lizard's chest (out
   * `origin`), facing from where it is now; the lizard is led a little along its velocity. The
   * level direction it'll be facing comes back in `dir`.
   */
  private strikeOrigin(origin: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 {
    const chest = this.lizard.bodySpheres[AIM_SPHERE];
    const pv = this.player.velocity;
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
      this.goTo('climb');
    }
  }

  /** The talons meet whatever is there: did they catch the lizard's body? */
  private contact() {
    this.struck = true;
    const t = this.v.copy(this.talons).applyQuaternion(this.quat).add(this.pos);
    const hit = TARGET_SPHERES.some((i) => {
      const s = this.lizard.bodySpheres[i];
      return Math.hypot(s.x - t.x, s.y - t.y, s.z - t.z) < s.r + HIT_REACH;
    });
    if (hit && this.wounds.strike(this.path!.v1.x, this.path!.v1.z)) this.hitsLanded++;
  }

  private stepClimb(dt: number) {
    const c = this.preyFeet(this.aim);
    // On along its line, rising back to the height it circles at.
    this.v.copy(this.vel).setY(0);
    if (this.v.lengthSq() < 1e-6) this.forward(this.v);
    this.v.normalize().multiplyScalar(1).add(this.pos).setY(c.y + STALK.up + 0.15);
    this.steer(this.v, CLIMB_SPEED, ACCEL, dt);
    if (this.stateTime >= CLIMB_TIME) {
      if (this.wounds.down) {
        this.giveUp(CALM_AFTER_KILL);
        return;
      }
      this.goTo('stalk');
      this.stalkFor = STALK_AGAIN;
    }
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
      this.goTo('perch');
      this.spell = this.span(PERCH_SPELL);
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
    const sitting = s === 'perch' || (s === 'land' && this.stateTime > this.path!.time) || (s === 'take_off' && this.stateTime < this.extras.take_off_time);
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
    } else if (s === 'land' && this.actions.land.time >= this.actions.land.getClip().duration - 1e-3) this.play('perch');
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

  /** The lizard's feet, out. */
  private preyFeet(out: THREE.Vector3): THREE.Vector3 {
    return this.player.feetAt(1, out);
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
    // Somewhere other than where it just was, when it can.
    const others = this.perches.filter((p) => p !== this.perch);
    const pool = others.length ? others : this.perches;
    return pool[Math.floor(this.rand() * pool.length)];
  }

  private span([a, b]: readonly [number, number]): number {
    return a + (b - a) * this.rand();
  }
}

/**
 * Perches: the tops of the tallest rocks out of the forest (the rock piles' crests among them), at
 * least a metre apart, the hawk facing inland over the island from each.
 */
export function findPerches(obstacles: { kind: string; position: THREE.Vector3; height: number }[], forest: (x: number, z: number) => number, count = 4): Perch[] {
  const found: Perch[] = [];
  const tops = obstacles
    .filter((o) => o.kind === 'rock' && o.height > 0.06 && forest(o.position.x, o.position.z) < 0.3)
    .map((o) => ({ x: o.position.x, z: o.position.z, y: terrainHeight(o.position.x, o.position.z) + o.height }))
    .sort((a, b) => b.y - a.y);
  for (const t of tops) {
    if (found.length >= count) break;
    if (found.some((p) => Math.hypot(p.x - t.x, p.z - t.z) < 1)) continue;
    found.push({ ...t, yaw: Math.atan2(PATROL.x - t.x, PATROL.z - t.z) });
  }
  return found;
}
