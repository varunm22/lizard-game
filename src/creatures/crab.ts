import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadGltf } from '../render/gltf';
import { toonify } from '../render/toon';
import { rng } from '../world/noise';
import { IGNORE_STEMS } from '../world/terrain';
import { inOcean, shoreX, WATER_Y } from '../world/shore';
import { ROCK_PILES } from '../world/layout';
import type { Algae } from '../world/algae';
import type { PlayerController } from '../player/controller';

/**
 * Sally Lightfoot crabs (assets-src/crab.py) on the lava shore and the rock piles. Each scuttles
 * sideways from spot to spot round its home, stops to graze (at a patch of algae when there's one
 * above the water nearby), now and then shows off with its claws raised, and hops up and down any
 * step it can't walk. When the lizard comes close it runs for it, and if it can't get away it drops
 * flat and waits for the lizard to go. Crabs stay out of the sea.
 *
 * They're drawn, not simulated: no collider, just a kinematic point kept on whatever surface is under
 * it by downward rays, and tilted to the rock under its legs.
 */
export type CrabState = 'idle' | 'walk' | 'graze' | 'display' | 'flee' | 'hop' | 'duck';

/** Steps up to this (m) it walks over; higher ones, up to HOP_MAX, it hops. Higher still is a wall. */
const STEP_UP = 0.005;
const HOP_MAX = 0.08;
/** Drops beyond this (m) it hops down; past DROP_MAX it won't go. */
const STEP_DOWN = 0.008;
const DROP_MAX = 0.12;
/** It lands this far past the edge of the step (m), about half its carapace, if there's room. */
const LAND_PAST = 0.014;
/** How far it looks for the edge of a step it's hopping onto (m). */
const HOP_REACH = 0.05;
/** It won't stand anywhere lower than this above the sea surface (m). */
const DRY = 0.002;
/** It wanders within this of its home (m). */
const WANDER_R = 0.3;
/** Turning speed (rad/s) walking and running. */
const TURN_WALK = 3;
const TURN_RUN = 9;
/** The lizard's snout or feet nearer than this (m) sends it running, at least this far (m). */
const ALARM = 0.2;
const FLEE_DIST = 0.3;
/** Ducked, it gets up once the lizard has been further than this (m) for SAFE_TIME (s). */
const SAFE = 0.15;
const SAFE_TIME = 1.5;
/** The lizard's snout is about this far ahead of its feet (m). */
const SNOUT = 0.08;
/**
 * The lizard's body, as the physics capsule: a segment this far either side of its feet along its
 * facing (m). A crab is pushed out to this far from it, and at most this far above or below it
 * counts as in its way (m).
 */
const BODY_HALF = 0.048;
const BODY_CLEAR = 0.025;
const BODY_LEVEL = 0.04;
/** Two crabs keep at least this far apart (m), about a leg span; nearer, each steps half the overlap aside. */
const CRAB_SPACE = 0.03;
/** Where it feels the rock under its legs, either side and fore and aft (m), to tilt the body. */
const SPAN = { side: 0.012, fore: 0.01 };
/** A foot further down than this (m) is over an edge; it leans only as far as this. */
const MAX_DROP = 0.008;
/** How long idle, grazing (s, from-to). */
const IDLE_SPELL = [1.5, 4] as const;
const GRAZE_SPELL = [4, 10] as const;
/** Running from the lizard, it hops this much quicker. */
const HOP_HURRY = 1.6;
/** Clip blend time (s). */
const CROSSFADE = 0.15;
/** Rays start this far above the highest surface they might find (m). */
const RAY_HEAD = 0.02;

interface Extras {
  gait_speed: number;
  run_speed: number;
  carapace_half_extents: [number, number];
  body_height: number;
  hop_takeoff: number;
  hop_land: number;
}

interface Hop {
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** Which side it leaps to (+1 its left), and what it goes on to do after landing. */
  side: number;
  then: CrabState;
}

/** Where crabs live: two on each rock pile and a few along the lava at either end of the beach. */
function homes(): { x: number; z: number; pile: boolean }[] {
  const out: { x: number; z: number; pile: boolean }[] = [];
  for (const p of ROCK_PILES) {
    const x0 = shoreX(p.z) + p.from;
    const x1 = shoreX(p.z) + p.to;
    out.push({ x: x0 + (x1 - x0) * 0.22, z: p.z + p.width * 0.15, pile: true });
    out.push({ x: x0 + (x1 - x0) * 0.5, z: p.z - p.width * 0.2, pile: true });
  }
  for (const z of [-1.1, -1.7, -3.2, 3.0, 3.7]) out.push({ x: shoreX(z) - 0.1, z, pile: false });
  return out;
}

class Crab {
  readonly root: THREE.Object3D;
  state: CrabState = 'idle';
  /** Hops taken, for tests. */
  hops = 0;
  readonly pos = new THREE.Vector3();
  yaw: number;
  private prevPos = new THREE.Vector3();
  private rot = new THREE.Quaternion();
  private prevRot = new THREE.Quaternion();
  private stateTime = 0;
  private spellLength = 0;
  private mixer: THREE.AnimationMixer;
  private actions: Record<string, THREE.AnimationAction>;
  private current: THREE.AnimationAction | null = null;
  private target = new THREE.Vector2();
  /** Which way it's going: +1 to its left, -1 to its right. */
  private side = 1;
  private hop: Hop | null = null;
  /** Ducked, how long the lizard has kept its distance (s). */
  private safeFor = 0;
  /** Sent somewhere by a test: it goes there whatever its home, and doesn't wander off on the way. */
  private sent = false;

  constructor(
    source: THREE.Object3D,
    animations: THREE.AnimationClip[],
    private extras: Extras,
    /** Where it lives, its middle on the rock (set when it's first put down). */
    readonly home: { x: number; y: number; z: number; pile: boolean },
    private crabs: Crabs,
    private rand: () => number,
  ) {
    this.root = clone(source);
    this.root.traverse((o) => (o.frustumCulled = false));
    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = Object.fromEntries(animations.map((c) => [c.name, this.mixer.clipAction(c)]));
    for (const name of ['hop_left', 'hop_right', 'duck', 'display']) {
      this.actions[name].setLoop(THREE.LoopOnce, 1);
      this.actions[name].clampWhenFinished = true;
    }
    this.yaw = rand() * Math.PI * 2;
    // Hidden until it's put down on the rock (Crabs.settle).
    this.root.visible = false;
    this.enter('idle');
    // Not all in step with each other.
    this.mixer.update(rand() * 2);
  }

  get clip(): string | undefined {
    return this.current?.getClip().name;
  }

  /** Put it down at (x, z), on the surface below `y`. */
  place(x: number, y: number, z: number) {
    const h = this.crabs.surface(x, z, y) ?? y;
    this.pos.set(x, h, z);
    this.fit();
    this.prevPos.copy(this.pos);
    this.prevRot.copy(this.rot);
    this.hop = null;
  }

  /**
   * Shift it by (dx, dz) along the rock, if that's somewhere it could step: no wall, drop or sea.
   * Mid-hop it's in the air and can't be pushed.
   */
  nudge(dx: number, dz: number) {
    if (this.state === 'hop') return;
    const x = this.pos.x + dx;
    const z = this.pos.z + dz;
    const h = this.crabs.surface(x, z, this.pos.y + HOP_MAX);
    if (h === null || h - this.pos.y > HOP_MAX || this.pos.y - h > DROP_MAX || !this.crabs.dryAt(x, z, h)) return;
    this.pos.set(x, h, z);
  }

  /** Walk to (x, z) (tests). */
  go(x: number, z: number) {
    this.sent = true;
    this.moveTo(x, z, 'walk');
  }

  step(dt: number, lizard: THREE.Vector3[]) {
    this.prevPos.copy(this.pos);
    this.prevRot.copy(this.rot);
    this.stateTime += dt;
    const near = Math.min(...lizard.map((p) => Math.hypot(p.x - this.pos.x, p.z - this.pos.z)));
    if (near < ALARM && !this.sent && this.state !== 'flee' && this.state !== 'hop' && this.state !== 'duck') this.flee(lizard[0]);

    switch (this.state) {
      case 'idle':
        if (this.stateTime >= this.spellLength) this.decide();
        break;
      case 'graze':
        if (this.stateTime >= this.spellLength) this.enter('idle');
        break;
      case 'display':
        if (this.stateTime >= this.duration('display')) this.enter('idle');
        break;
      case 'walk':
      case 'flee':
        this.move(dt);
        break;
      case 'hop':
        this.leap();
        break;
      case 'duck':
        this.safeFor = near > SAFE ? this.safeFor + dt : 0;
        if (this.safeFor >= SAFE_TIME) this.enter('idle');
        break;
    }
    this.fit();
  }

  /** Draw it between the last two steps. */
  update(alpha: number, frameDt: number) {
    this.root.position.lerpVectors(this.prevPos, this.pos, alpha);
    this.root.quaternion.slerpQuaternions(this.prevRot, this.rot, alpha);
    this.mixer.update(frameDt);
  }

  /** Idle long enough: graze, wander somewhere, or now and then show off. */
  private decide() {
    const r = this.rand();
    if (r < 0.1) return this.enter('display');
    if (r < 0.35) return this.enter('graze');
    // Somewhere new round home, at a bit of algae above the water when there is one.
    const food = this.crabs.food(this.home, WANDER_R).filter(() => this.rand() < 0.5)[0];
    if (food) return this.moveTo(food.x, food.z, 'walk');
    const a = this.rand() * Math.PI * 2;
    const d = WANDER_R * Math.sqrt(this.rand());
    this.moveTo(this.home.x + Math.sin(a) * d, this.home.z + Math.cos(a) * d, 'walk');
  }

  /** Run directly away from the lizard, or the clearest way near that. */
  private flee(from: THREE.Vector3) {
    const away = Math.atan2(this.pos.x - from.x, this.pos.z - from.z);
    for (const turn of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
      const a = away + turn;
      const x = this.pos.x + Math.sin(a) * FLEE_DIST;
      const z = this.pos.z + Math.cos(a) * FLEE_DIST;
      if (this.crabs.dryAt(x, z, this.pos.y + HOP_MAX)) return this.moveTo(x, z, 'flee');
    }
    this.enter('duck');
  }

  private moveTo(x: number, z: number, state: 'walk' | 'flee') {
    this.target.set(x, z);
    // Sideways, whichever side is nearer facing the way it's going.
    const left = { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) };
    this.side = (x - this.pos.x) * left.x + (z - this.pos.z) * left.z >= 0 ? 1 : -1;
    this.enter(state);
  }

  /** One step sideways toward the target: walk on, hop a step, or give up at a wall or the sea. */
  private move(dt: number) {
    const run = this.state === 'flee';
    const dx = this.target.x - this.pos.x;
    const dz = this.target.y - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.01) {
      this.sent = false;
      return this.enter(this.state === 'walk' && this.rand() < 0.6 ? 'graze' : 'idle');
    }
    // Turn so its side faces the target. Its left is (cos yaw, -sin yaw).
    const want = Math.atan2(-dz * this.side, dx * this.side);
    let turn = want - this.yaw;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    const rate = (run ? TURN_RUN : TURN_WALK) * dt;
    this.yaw += Math.max(-rate, Math.min(rate, turn));
    this.play(`${run ? 'run' : 'walk'}_${this.side > 0 ? 'left' : 'right'}`);

    const speed = run ? this.extras.run_speed : this.extras.gait_speed;
    const d = Math.min(speed * dt, dist);
    const ux = Math.cos(this.yaw) * this.side;
    const uz = -Math.sin(this.yaw) * this.side;
    const nx = this.pos.x + ux * d;
    const nz = this.pos.z + uz * d;
    const h = this.crabs.surface(nx, nz, this.pos.y + HOP_MAX);
    const rise = h === null ? -Infinity : h - this.pos.y;
    if (h === null || rise > HOP_MAX || rise < -DROP_MAX || h < WATER_Y + DRY) return this.blocked();
    if (rise > STEP_UP || rise < -STEP_DOWN) return this.startHop(ux, uz, rise > 0);
    this.pos.set(nx, h, nz);
  }

  /** Can't go on: if it's running from the lizard it drops flat, otherwise it thinks again. */
  private blocked() {
    this.sent = false;
    this.enter(this.state === 'flee' ? 'duck' : 'idle');
  }

  /** Hop onto (or off) the step just ahead: land a little past its edge if there's room. */
  private startHop(ux: number, uz: number, up: boolean) {
    const top = this.pos.y + HOP_MAX;
    let edge: THREE.Vector3 | null = null;
    for (let s = 0.004; s <= HOP_REACH; s += 0.004) {
      const x = this.pos.x + ux * s;
      const z = this.pos.z + uz * s;
      const h = this.crabs.surface(x, z, top);
      if (h === null) break;
      const rise = h - this.pos.y;
      if (up ? rise > STEP_UP : rise < -STEP_DOWN) {
        edge = new THREE.Vector3(x, h, z);
        break;
      }
    }
    if (!edge || edge.y < WATER_Y + DRY) return this.blocked();
    const past = this.crabs.surface(edge.x + ux * LAND_PAST, edge.z + uz * LAND_PAST, top);
    const to = past !== null && Math.abs(past - edge.y) < STEP_UP && past >= WATER_Y + DRY
      ? new THREE.Vector3(edge.x + ux * LAND_PAST, past, edge.z + uz * LAND_PAST)
      : edge;
    this.hop = { from: this.pos.clone(), to, side: this.side, then: this.state };
    this.hops++;
    this.enter('hop');
  }

  /** Follow the leap: crouched until take-off, through the air, then the landing in place. */
  private leap() {
    const hop = this.hop!;
    const pace = hop.then === 'flee' ? HOP_HURRY : 1;
    const t0 = this.extras.hop_takeoff / pace;
    const t1 = this.extras.hop_land / pace;
    const t = Math.min(1, Math.max(0, (this.stateTime - t0) / (t1 - t0)));
    const rise = hop.to.y - hop.from.y;
    // Going up it rises before it moves across, going down it clears the edge first, so it doesn't
    // cut through the corner of the step.
    const across = rise > 0 ? t * t : Math.sin((t * Math.PI) / 2);
    const upward = rise > 0 ? Math.sin((t * Math.PI) / 2) : t * t;
    this.pos.lerpVectors(hop.from, hop.to, across);
    this.pos.y = hop.from.y + rise * upward + 0.008 * 4 * t * (1 - t);
    if (this.stateTime >= this.duration(this.clip!) / pace) {
      this.pos.copy(hop.to);
      this.hop = null;
      // Carry on where it was going (it turns and picks a side again).
      this.moveTo(this.target.x, this.target.y, hop.then === 'flee' ? 'flee' : 'walk');
    }
  }

  /** Stand on the rock: centre on the surface, tilted to where its legs are, facing `yaw`. */
  private fit() {
    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const left = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    if (this.state !== 'hop') {
      const h = (f: number, s: number) => {
        const y = this.crabs.surface(this.pos.x + forward.x * f + left.x * s, this.pos.z + forward.z * f + left.z * s, this.pos.y + STEP_UP);
        // Nothing there, or the foot of a step higher than it'd stand on: take it as level.
        if (y === null || y > this.pos.y + STEP_UP) return 0;
        return Math.max(-MAX_DROP, y - this.pos.y);
      };
      const lean = (a: number, b: number, span: number) => Math.atan2(Math.max(-span, Math.min(span, a - b)), 2 * span);
      const pitch = lean(h(SPAN.fore, 0), h(-SPAN.fore, 0), SPAN.fore);
      const roll = lean(h(0, SPAN.side), h(0, -SPAN.side), SPAN.side);
      forward.y = Math.tan(pitch);
      left.y = Math.tan(roll);
      forward.normalize();
      left.normalize();
    }
    const up = new THREE.Vector3().crossVectors(forward, left).normalize();
    left.crossVectors(up, forward);
    this.rot.setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, up, forward));
  }

  private enter(state: CrabState) {
    this.state = state;
    this.stateTime = 0;
    if (state === 'idle') this.spellLength = this.spell(IDLE_SPELL);
    if (state === 'graze') this.spellLength = this.spell(GRAZE_SPELL);
    if (state === 'duck') this.safeFor = 0;
    if (state === 'hop') {
      this.play(this.hop!.side > 0 ? 'hop_left' : 'hop_right');
      this.current!.timeScale = this.hop!.then === 'flee' ? HOP_HURRY : 1;
    } else if (state !== 'walk' && state !== 'flee') this.play(state);
  }

  private spell([a, b]: readonly [number, number]) {
    return a + (b - a) * this.rand();
  }

  private duration(clip: string) {
    return this.actions[clip].getClip().duration;
  }

  private play(name: string) {
    const next = this.actions[name];
    if (next === this.current) {
      // Hops in a row each start from the crouch.
      if (this.current.loop === THREE.LoopOnce) next.reset().play();
      return;
    }
    next.reset().setEffectiveWeight(1).fadeIn(CROSSFADE).play();
    this.current?.fadeOut(CROSSFADE);
    this.current = next;
  }
}

export class Crabs {
  readonly list: Crab[] = [];
  readonly clips: string[];
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private lizard = [new THREE.Vector3(), new THREE.Vector3()];
  private settled = false;

  private constructor(
    gltf: Awaited<ReturnType<typeof loadGltf>>,
    scene: THREE.Scene,
    private world: RAPIER.World,
    private algae: Algae,
    private player: PlayerController,
  ) {
    const source = gltf.scene;
    toonify(source);
    const rig = source.getObjectByName('Crab');
    if (!rig) throw new Error('crab.glb has no Crab armature');
    const extras = rig.userData as Extras;
    this.clips = gltf.animations.map((c) => c.name);
    const rand = rng(17);
    for (const h of homes()) {
      const crab = new Crab(source, gltf.animations, extras, { ...h, y: 0 }, this, rand);
      scene.add(crab.root);
      this.list.push(crab);
    }
  }

  static async load(url: string, scene: THREE.Scene, world: RAPIER.World, algae: Algae, player: PlayerController) {
    return new Crabs(await loadGltf(url), scene, world, algae, player);
  }

  /** Height of the surface under (x, z) at or below `below` (plus a little), or null. Ignores the lizard. */
  surface(x: number, z: number, below: number): number | null {
    const from = below + RAY_HEAD;
    this.ray.origin = { x, y: from, z };
    const hit = this.world.castRay(this.ray, from + 1, true, undefined, IGNORE_STEMS, undefined, this.player.body);
    return hit ? from - hit.timeOfImpact : null;
  }

  /** There's rock (or ground) above the sea at (x, z) below `below`. */
  dryAt(x: number, z: number, below: number) {
    const h = this.surface(x, z, below);
    return h !== null && (!inOcean(x, z) || h >= WATER_Y + DRY);
  }

  /** Algae within r of a home that a crab can reach without getting wet. */
  food(home: { x: number; y: number; z: number }, r: number) {
    return this.algae.near(home.x, home.y, home.z, r).filter((p) => p.y >= WATER_Y + DRY);
  }

  /**
   * Put each crab down at its home, stepped back up the shore until it's on dry rock. Done on the
   * first step the physics world can answer rays (after it has stepped once).
   */
  private settle() {
    for (const c of this.list) {
      const h = c.home;
      const x0 = h.x;
      while (!this.dryAt(h.x, h.z, 1) && h.x > x0 - 0.5) h.x -= 0.02;
      h.y = this.surface(h.x, h.z, 1) ?? 0;
      c.place(h.x, h.y, h.z);
      c.root.visible = true;
    }
    this.settled = true;
  }

  step(dt: number) {
    if (!this.settled) {
      if (this.surface(0, 0, 1) === null) return;
      this.settle();
    }
    const [feet, snout] = this.lizard;
    this.player.feetAt(1, feet);
    snout.set(feet.x + Math.sin(this.player.yaw) * SNOUT, feet.y, feet.z + Math.cos(this.player.yaw) * SNOUT);
    for (const c of this.list) c.step(dt, this.lizard);
    this.clearLizard(feet);
    this.spaceOut();
  }

  /** A crab under the lizard's body (one it walked over while the crab was ducked, say) is pushed out from under it. */
  private clearLizard(feet: THREE.Vector3) {
    const fx = Math.sin(this.player.yaw);
    const fz = Math.cos(this.player.yaw);
    for (const c of this.list) {
      if (Math.abs(c.pos.y - feet.y) > BODY_LEVEL) continue;
      // Nearest point on the body's spine, then straight out from it.
      const along = Math.max(-BODY_HALF, Math.min(BODY_HALF, (c.pos.x - feet.x) * fx + (c.pos.z - feet.z) * fz));
      const ox = c.pos.x - (feet.x + fx * along);
      const oz = c.pos.z - (feet.z + fz * along);
      const d = Math.hypot(ox, oz);
      if (d >= BODY_CLEAR) continue;
      // Dead under the spine: out to the side.
      const [ux, uz] = d > 1e-6 ? [ox / d, oz / d] : [fz, -fx];
      c.nudge(ux * (BODY_CLEAR - d), uz * (BODY_CLEAR - d));
    }
  }

  /** Crabs that have walked into each other each step half the overlap apart. */
  private spaceOut() {
    for (let i = 0; i < this.list.length; i++) {
      for (let j = i + 1; j < this.list.length; j++) {
        const a = this.list[i];
        const b = this.list[j];
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d = Math.hypot(dx, dz);
        if (d >= CRAB_SPACE || Math.abs(b.pos.y - a.pos.y) > BODY_LEVEL) continue;
        const [ux, uz] = d > 1e-6 ? [dx / d, dz / d] : [1, 0];
        const half = (CRAB_SPACE - d) / 2;
        a.nudge(-ux * half, -uz * half);
        b.nudge(ux * half, uz * half);
      }
    }
  }

  update(alpha: number, frameDt: number) {
    for (const c of this.list) c.update(alpha, frameDt);
  }
}
