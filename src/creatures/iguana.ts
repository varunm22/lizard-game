import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { IguanaNavigation, KICK_GAP, LINE_UP, type BaskSpot } from './iguanaNavigation';
import { wrapAngle } from '../math/angles';
import type { InputState } from '../input';
import { PlayerController } from '../player/controller';
import { MovementStateMachine, movementFacts } from '../player/state';
import { LizardModel } from '../player/lizardModel';
import { LizardVisual } from '../player/visual';
import { covers, type Obstacle } from '../world/obstacles';
import { lavaCover, ROCK_PILES } from '../world/layout';
import { rng } from '../world/noise';
import { shoreX, WATER_Y } from '../world/shore';
import { IGNORE_BODIES, IGUANA_GROUP, PLANT_STEM_GROUP, terrainHeight } from '../world/terrain';
import type { Algae, AlgaePatch } from '../world/algae';
import type { Plants } from '../world/plants';
import { Splashes } from '../world/splashes';
import type { Water } from '../world/water';
import { SaltSpray } from './saltSpray';
export type { BaskSpot } from './iguanaNavigation';

/**
 * Other marine iguanas living on the lava shore, going about their day: they bask on the black lava
 * broadside to the sun, sneezing salt now and then; when hungry, one walks down into the sea, swims
 * out and dives to an algae patch to graze, maybe moves on to another one or two, then swims back,
 * climbs out and basks again, sneezing more often after a meal. They take no notice of the lizard
 * yet. Each is the player's own lizard: the same physics body and controller, driven by its own
 * input from the code below instead of the keyboard, the same movement states, model and clips, and
 * the same fitting to the ground, tinted a little differently. Bodies are solid (to the lizard and to
 * each other), in IGUANA_GROUP so the crabs' surface rays look past them.
 */
export type IguanaActivity = 'bask' | 'shuffle' | 'to_food' | 'graze' | 'to_land' | 'bolt' | 'freeze' | 'dead';

/** Where each lives (z of its stretch of lava shore) and its skin tint (multiplies the texture). */
const HOMES = [
  { z: -1.0, tint: [1.14, 0.9, 0.82] },
  { z: -1.6, tint: [0.92, 1.04, 0.9] },
  { z: 2.88, tint: [0.8, 0.8, 0.84] },
] as const;
/** Basking spots are this far up from the waterline (m, from-to), and within this of home along the shore. */
const BASK_UP = [0.1, 0.32] as const;
const BASK_RANGE = 0.2;
/** It keeps this far (m) off the rock piles' sides, leaving them to the crabs. */
const PILE_BERTH = 0.06;
/** It basks only where the ground is at least this much bare black lava (`lavaCover`), never on sand. */
const BLACK_LAVA = 0.85;
/** It tries this many patches before giving up on a meal. */
const FOOD_TRIES = 3;
/** A basking spot keeps the body this clear of rocks and logs (m), from its centre this far each way. */
const BASK_CLEAR = 0.02;
const BODY_REACH = 0.08;
/** Basking lasts this long (s, from-to), and it feeds again this long after a meal. */
const BASK_TIME = [18, 40] as const;
const HUNGER = [80, 140] as const;
/** Algae it dives for: within this of home along the shore, this far out to sea at most, no deeper than this (m). */
const FOOD_RANGE = 0.45;
const FOOD_OUT = 0.75;
const MAX_DIVE = 0.2;
/** Starts a bite every so often (s, from-to; a bite takes 0.6 s); this many bites eat a patch, and it goes on to at most this many. */
const BITE_GAP = [0.8, 1.4] as const;
const BITES_PER_PATCH = 6;
const MAX_PATCHES = 3;
/** It only goes for patches grown at least this far in. */
const RIPE = 0.8;
/** The next patch is one within this of the last (m). */
const NEXT_PATCH = 0.25;
/** Sneezes this often (s, from-to) basking, and more often for a while after a meal. */
const SNEEZE_GAP = [9, 22] as const;
const SNEEZE_GAP_FED = [3, 7] as const;
const FED_SNEEZING = 30;
/** A sneeze: the snout rises, jerks down as the spray comes out, and settles (s, radians). */
const SNEEZE_TIME = 0.75;
const SNEEZE_WINDUP = 0.36;
const SNEEZE_BLOW = 0.42;
const SNEEZE_UP = 0.24;
const SNEEZE_DOWN = -0.14;
/** Then it noses in until its drawn snout touches the fronds: within this of a point this far above the holdfast (m). */
const TOUCH = 0.012;
const FROND = 0.006;
/** It gives up on a patch it can't get its snout into for this long (s). */
const NOSE_IN = 8;
/** Settling to bask, it creeps round at this share of walking pace until broadside to the sun (radians off). */
const CREEP = 0.12;
const SETTLE_TIME = 3;
const BROADSIDE_SLACK = 0.25;
/**
 * Looking for somewhere to bask, it lies down beside another iguana basking within this (m), the
 * lizard included, side by side and the same way round, for the warmth: this far apart, centre to
 * centre (two 12 mm bodies with a few mm between). It walks this close to the spot before settling.
 */
const JOIN_RANGE = 0.8;
const BESIDE = 0.052;
/** The line in is clear of rocks this far (m) either side: half a body's width, its controller's skin and a little. */
const LANE = 0.03;
/** Pushed by the lizard walking into it, it gives way at this speed (m/s), slower than the lizard walks. */
const PUSH_SPEED = 0.06;
/** Where the sun is (as in render/scene.ts): basking, the body lies across its rays. */
const SUN_YAW = Math.atan2(2.5, 1.7);

/** Strikes from the hawk it takes before it goes down. */
export const IGUANA_LIVES = 2;
/** Scared by a shadow going over, it bolts this far (m) and then holds still this long (s). */
const BOLT = 0.35;
const BOLT_TIME = 2.5;
const FREEZE = [3, 6] as const;
/** Scared again while bolting or frozen, it only bolts afresh after this long (s). */
const BOLT_AGAIN = 1.2;
/** Eaten, another comes up its shore after this long (s, from-to). */
const COME_BACK = [45, 80] as const;

const offPiles = (z: number) => ROCK_PILES.every((p) => Math.abs(z - p.z) > p.width + PILE_BERTH);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

class Iguana {
  readonly body: PlayerController;
  readonly states = new MovementStateMachine();
  readonly visual: LizardVisual;
  activity: IguanaActivity = 'bask';
  /** Strikes the hawk has landed on it; at IGUANA_LIVES it goes down. */
  hits = 0;
  /** Eaten: it isn't in the world, and comes back on its shore after a while. */
  gone = false;
  /** Counts, for tests. */
  sneezes = 0;
  bites = 0;
  meals = 0;
  private navigation: IguanaNavigation;
  private timer: number;
  private hunger: number;
  private sinceMeal = Infinity;
  private patches = 0;
  private foodTries = 0;
  private nextSneeze: number;
  private nextBite = 0;
  /** Time into the sneeze under way, or -1. */
  private sneezeT = -1;
  /** The patch its jaws just closed on, eaten on its next step. */
  private chomp: AlgaePatch | null = null;
  private sprayDue = false;
  private settle = 0;
  /** Settling in, the way to lie: beside a mate, parallel to it; null, across the sun's rays. */
  private settleYaw: number | null = null;
  private beside: PlayerController | null = null;
  private feet = new THREE.Vector3();
  private splashes: Splashes;
  private input: InputState = { move: { x: 0, y: 0 }, run: false, jump: false, look: { yaw: 0, pitch: 0 }, zoom: 0 };
  private v = new THREE.Vector3();
  private dir = new THREE.Vector3();
  /** Where it's bolting to, while it bolts. */
  private bolting: { x: number; z: number } | null = null;
  private sinceScare = Infinity;
  private backIn = 0;

  constructor(
    readonly model: LizardModel,
    world: RAPIER.World,
    readonly home: { x: number; z: number },
    yaw: number,
    private herd: Iguanas,
    private rand: () => number,
    hunger: number,
    water: Water,
  ) {
    this.body = new PlayerController(world, new THREE.Vector3(home.x, terrainHeight(home.x, home.z), home.z), (IGUANA_GROUP << 16) | 0xffff);
    this.body.setFeet(this.body.feetAt(1, this.feet), yaw);
    this.body.stillGroups = IGNORE_BODIES;
    // Brushing past another lizard it slides along it; it never clambers over one.
    this.body.climbGroups = IGNORE_BODIES & ~PLANT_STEM_GROUP;
    this.navigation = new IguanaNavigation(this.body, this.feet, this.input, {
      others: () => this.herd.others(this),
      open: (x, z) => this.herd.open(x, z),
      growing: (patch) => this.herd.growing(patch),
      baskSpot: () => this.herd.baskSpot(this, this.rand),
      goalChanged: () => { this.beside = null; },
    });
    this.visual = new LizardVisual(model, this.body, world);
    this.splashes = new Splashes(water);
    this.timer = this.between(BASK_TIME);
    this.hunger = hunger;
    this.nextSneeze = this.between(SNEEZE_GAP) * 0.5;
  }

  private between(r: readonly [number, number]) {
    return r[0] + (r[1] - r[0]) * this.rand();
  }

  /** The algae patch it's going to or grazing, if any. */
  get meal(): AlgaePatch | null {
    return this.activity === 'to_food' || this.activity === 'graze' ? (this.navigation.goal?.food ?? null) : null;
  }

  /** Who it's going to lie beside, or is lying beside: the lizard's or another iguana's body, or null. */
  get mate(): PlayerController | null {
    return this.navigation.goal?.mate?.body ?? this.beside;
  }

  get sneezing() {
    return this.sneezeT >= 0;
  }

  /** Knocked down by the hawk: lying on its side, to be eaten. */
  get down(): boolean {
    return this.activity === 'dead';
  }

  /** Struck by the hawk, the blow travelling (dx, dz); false if it was already down or gone. */
  strike(dx: number, dz: number): boolean {
    if (this.down || this.gone) return false;
    // Flinch toward the side the blow points along, as the player does.
    const lx = Math.cos(this.body.yaw);
    const lz = -Math.sin(this.body.yaw);
    const side = dx * lx + dz * lz >= 0 ? 1 : -1;
    this.model.flinch(side > 0 ? 'right' : 'left');
    if (++this.hits >= IGUANA_LIVES) {
      this.activity = 'dead';
      this.navigation.goal = null;
      this.bolting = null;
    } else {
      this.scare(this.feet.x - dx, this.feet.z - dz, true);
    }
    return true;
  }

  /**
   * Something passed over: bolt away from (x, z), then hold still. `now` bolts even if it just did.
   * False when it takes no notice (already down, in the sea, or still getting over the last fright).
   */
  scare(x: number, z: number, now = false): boolean {
    if (this.down || this.gone || this.body.swimming) return false;
    if (!now && this.sinceScare < BOLT_AGAIN) return false;
    this.sinceScare = 0;
    const a = Math.atan2(this.feet.x - x, this.feet.z - z);
    this.activity = 'bolt';
    this.navigation.goal = null;
    this.beside = null;
    this.settle = 0;
    this.timer = BOLT_TIME;
    this.bolting = { x: this.feet.x + Math.sin(a) * BOLT, z: this.feet.z + Math.cos(a) * BOLT };
    return true;
  }

  /** Eaten: out of the world until it comes back on its shore. */
  eaten() {
    if (this.gone) return;
    this.gone = true;
    this.hits = 0;
    this.activity = 'bask';
    this.navigation.goal = null;
    this.model.root.visible = false;
    // Out of everything's way while it's away.
    this.body.setFeet(new THREE.Vector3(this.home.x, -20, this.home.z), this.body.yaw);
    this.backIn = this.between(COME_BACK);
  }

  /** Back on its home shore, whole again. */
  private comeBack() {
    this.gone = false;
    this.hits = 0;
    this.model.root.visible = true;
    this.place(this.home.x, this.home.z, SUN_YAW + Math.PI / 2, this.between(BASK_TIME));
  }

  /** Go and feed now. */
  feed() {
    this.hunger = 0;
    this.timer = 0;
    this.patches = this.foodTries = 0;
    if (this.activity !== 'bask') this.startFeeding();
  }

  /** Basking, get up now and look for somewhere else to bask. */
  moveOn() {
    if (this.activity === 'bask') this.timer = 0;
    this.hunger = Math.max(this.hunger, 1);
  }

  /** Put it down at (x, z) facing `yaw`, basking there for `stay` seconds (tests). */
  place(x: number, z: number, yaw: number, stay = 60) {
    this.body.setFeet(new THREE.Vector3(x, terrainHeight(x, z), z), yaw);
    this.activity = 'bask';
    this.navigation.goal = null;
    this.navigation.pass = null;
    this.beside = null;
    this.settle = 0;
    this.timer = stay;
  }

  /** Sneeze now (if on land). */
  sneeze() {
    this.nextSneeze = 0;
  }

  step(dt: number, plants: Plants) {
    if (this.gone) {
      if ((this.backIn -= dt) <= 0) this.comeBack();
      return;
    }
    const b = this.body;
    b.feetAt(1, this.feet);
    this.sinceScare += dt;
    this.input.move.x = this.input.move.y = 0;
    this.input.jump = false;
    this.think(dt);
    this.navigation.giveWay();
    b.speedScale = plants.speedScale(this.feet.x, this.feet.z, Math.sin(b.yaw), Math.cos(b.yaw));
    b.step(dt, this.input);
    this.states.update(movementFacts(b), dt);
    this.splashes.update(b, dt);
    this.animate(dt);
  }

  private think(dt: number) {
    if (this.activity === 'dead') return;
    if (this.activity === 'bolt') {
      // Straight away from what startled it, until it's far enough or out of time.
      const b = this.bolting!;
      this.timer -= dt;
      const left = Math.hypot(b.x - this.feet.x, b.z - this.feet.z);
      if (this.timer <= 0 || left < 0.03 || this.body.swimming) {
        this.activity = 'freeze';
        this.timer = this.between(FREEZE);
        return;
      }
      this.navigation.steer(b, 1);
      return;
    }
    if (this.activity === 'freeze') {
      // Pressed flat and still, the way they wait a hawk out.
      if ((this.timer -= dt) <= 0) this.startBasking();
      return;
    }
    if (this.activity !== 'to_food' && this.activity !== 'graze') this.hunger -= dt;
    this.sinceMeal += dt;
    switch (this.activity) {
      case 'bask':
        // Washed into the sea, or knocked in: head back out.
        if (this.body.swimming) return this.headForLand();
        this.bask(dt);
        return;
      case 'shuffle':
      case 'to_land': {
        const r = this.navigation.navigate(dt);
        if (r === 'arrived' || (r === 'gave_up' && !this.body.swimming)) this.startBasking();
        else if (r === 'gave_up') this.headForLand();
        return;
      }
      case 'to_food': {
        const r = this.navigation.navigate(dt);
        if (r === 'arrived') this.startGrazing();
        else if (r === 'gave_up' && ++this.foodTries < FOOD_TRIES) this.startFeeding();
        else if (r === 'gave_up') this.headForLand();
        return;
      }
      case 'graze':
        this.graze(dt);
        return;
    }
  }

  private bask(dt: number) {
    const b = this.body;
    // Settling in: creep round to lie across the sun's rays, or alongside its mate.
    if (this.settle > 0) {
      this.settle -= dt;
      const goal =
        this.settleYaw ?? [SUN_YAW + Math.PI / 2, SUN_YAW - Math.PI / 2].reduce((a, c) => (Math.abs(wrapAngle(c - b.yaw)) < Math.abs(wrapAngle(a - b.yaw)) ? c : a));
      const diff = wrapAngle(goal - b.yaw);
      if (Math.abs(diff) > BROADSIDE_SLACK && b.grounded) {
        this.input.move.x = clamp(-diff * 3, -1, 1);
        this.input.move.y = CREEP;
        return;
      }
      this.settle = 0;
    }
    this.nextSneeze -= dt;
    if (this.nextSneeze <= 0 && this.sneezeT < 0 && b.grounded && b.horizontalSpeed < 0.02) {
      this.sneezeT = 0;
      this.sneezes++;
      this.nextSneeze = this.between(this.sinceMeal < FED_SNEEZING ? SNEEZE_GAP_FED : SNEEZE_GAP);
    }
    this.timer -= dt;
    if (this.timer > 0 || this.sneezeT >= 0) return;
    if (this.hunger <= 0) {
      this.patches = this.foodTries = 0;
      this.startFeeding();
    } else {
      this.activity = 'shuffle';
      this.navigation.setGoal(this.herd.baskSpot(this, this.rand), null);
    }
  }

  private startBasking() {
    this.activity = 'bask';
    this.navigation.rePicks = 0;
    // Alongside the mate, head to head or head to tail, whichever it came in as.
    const m = this.navigation.goal?.mate;
    this.settleYaw = m ? (Math.cos(this.body.yaw - m.yaw) >= 0 ? m.yaw : m.yaw + Math.PI) : null;
    this.beside = this.navigation.goal?.mate?.body ?? null;
    this.navigation.goal = null;
    this.timer = this.between(BASK_TIME);
    this.settle = SETTLE_TIME;
  }

  private startFeeding() {
    const food = this.herd.food(this, this.rand, this.patches > 0 ? this.feet : null);
    if (!food) return this.headForLand();
    this.activity = 'to_food';
    this.navigation.setGoal(food, food);
  }

  private startGrazing() {
    this.activity = 'graze';
    this.foodTries = 0;
    this.nextBite = 0.3;
    this.chomp = null;
    this.timer = NOSE_IN;
    this.patches++;
  }

  /** How far the drawn snout is from the patch's fronds (m): across, and up (positive when the fronds are above it). */
  private toFronds(p: AlgaePatch) {
    const s = this.model.bodySpheres[0];
    return { flat: Math.hypot(p.x - s.x, p.z - s.z), dy: p.y + FROND - s.y };
  }

  /** How far the drawn snout is from the patch's fronds (m), or Infinity if the patch is gone. */
  touch(p: AlgaePatch | null): number {
    if (!p) return Infinity;
    const { flat, dy } = this.toFronds(p);
    return Math.hypot(flat, dy);
  }

  private graze(dt: number) {
    const g = this.navigation.goal!;
    const food = g.food!;
    // Someone else ate the last of it: on to another, or done.
    if (!this.herd.growing(food)) return this.grazedPatch();
    if (this.chomp === food) {
      this.chomp = null;
      this.bites++;
      if (this.herd.bite(food)) return this.grazedPatch();
    }
    const b = this.body;
    const { flat, dy } = this.toFronds(food);
    const touching = Math.hypot(flat, dy) < TOUCH * 1.5;
    // Nose in until its snout is in the fronds; in the water, kick up to them or sink down onto them.
    if (flat > TOUCH * 0.5) this.noseIn(food);
    if (b.swimming && dy > 0.004 && (this.navigation.kick -= dt) <= 0) {
      this.input.jump = true;
      this.navigation.kick = KICK_GAP;
    }
    if (!touching && (this.timer -= dt) < 0) return ++this.foodTries < FOOD_TRIES ? this.startFeeding() : this.headForLand();
    this.nextBite -= dt;
    if (this.nextBite > 0 || !touching) return;
    // The bite clip: head up with the mouth open, down onto the fronds, and the jaws snap shut on them.
    if (!this.model.bite(() => (this.chomp = food))) return;
    this.timer = NOSE_IN;
    this.nextBite = this.between(BITE_GAP);
  }

  /**
   * Edge the snout onto the patch: turn to face it and creep forward or back so the drawn snout comes
   * over it, slowly, so it doesn't overshoot (swimming, a full stroke would carry it right past).
   */
  private noseIn(p: AlgaePatch) {
    const b = this.body;
    const s = this.model.bodySpheres[0];
    const diff = wrapAngle(Math.atan2(p.x - this.feet.x, p.z - this.feet.z) - b.yaw);
    const reach = Math.hypot(s.x - this.feet.x, s.z - this.feet.z);
    const gap = Math.hypot(p.x - this.feet.x, p.z - this.feet.z) * Math.cos(diff) - reach;
    this.input.move.x = clamp(-diff * 2.5, -1, 1);
    let go = clamp(gap * 10, -0.3, 0.3);
    // On land the body only turns while moving.
    if (!b.swimming && Math.abs(diff) > 0.1 && Math.abs(go) < 0.12) go = gap < 0 ? -0.12 : 0.12;
    this.input.move.y = go;
  }

  /** It ate the patch: maybe on to another nearby, otherwise back to land with a full belly. */
  private grazedPatch() {
    if (this.patches < MAX_PATCHES && this.rand() < 0.6) return this.startFeeding();
    this.meals++;
    this.sinceMeal = 0;
    this.hunger = this.between(HUNGER);
    this.headForLand();
  }

  private headForLand() {
    this.activity = 'to_land';
    this.navigation.setGoal(this.herd.baskSpot(this, this.rand), null);
  }

  private animate(dt: number) {
    if (this.sneezeT >= 0) {
      const before = this.sneezeT;
      this.sneezeT += dt;
      if (before < SNEEZE_BLOW && this.sneezeT >= SNEEZE_BLOW) this.sprayDue = true;
      if (this.sneezeT >= SNEEZE_TIME) this.sneezeT = -1;
    }
  }

  /** The head's nod for the sneeze under way (radians, positive snout up). */
  private nod(): number {
    const smooth = (x: number) => x * x * (3 - 2 * x);
    const t = this.sneezeT;
    if (t >= 0) {
      if (t < SNEEZE_WINDUP) return SNEEZE_UP * smooth(t / SNEEZE_WINDUP);
      if (t < SNEEZE_BLOW) return SNEEZE_UP + (SNEEZE_DOWN - SNEEZE_UP) * smooth((t - SNEEZE_WINDUP) / (SNEEZE_BLOW - SNEEZE_WINDUP));
      return SNEEZE_DOWN * (1 - smooth((t - SNEEZE_BLOW) / (SNEEZE_TIME - SNEEZE_BLOW)));
    }
    return 0;
  }

  update(alpha: number, dt: number, spray: SaltSpray) {
    if (this.gone) return;
    this.visual.downed = this.down;
    this.model.nod += (this.nod() - this.model.nod) * (1 - Math.exp(-40 * dt));
    this.visual.update(this.states.state, alpha, dt);
    this.model.updateBodySpheres();
    if (this.sprayDue) {
      this.sprayDue = false;
      const [snout, head] = this.model.bodySpheres;
      this.dir.set(snout.x - head.x, snout.y - head.y, snout.z - head.z).normalize();
      this.dir.y += 0.25;
      spray.sneeze(this.v.set(snout.x, snout.y, snout.z), this.dir.normalize());
    }
  }
}

/** The marine iguanas that aren't the player. */
export class Iguanas {
  readonly list: Iguana[] = [];
  readonly spray: SaltSpray;
  /** Tests that aren't about them stop the iguanas where they are (still solid) to save time. */
  paused = false;

  private constructor(
    scene: THREE.Scene,
    private player: PlayerController,
    private obstacles: readonly Obstacle[],
    private algae: Algae,
    private plants: Plants,
  ) {
    this.spray = new SaltSpray(scene);
  }

  static async load(
    url: string,
    scene: THREE.Scene,
    world: RAPIER.World,
    player: PlayerController,
    obstacles: readonly Obstacle[],
    algae: Algae,
    plants: Plants,
    water: Water,
  ) {
    const herd = new Iguanas(scene, player, obstacles, algae, plants);
    for (const [i, h] of HOMES.entries()) {
      const model = await LizardModel.load(url);
      const tint = new THREE.Color(...h.tint);
      model.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const tinted = (m: THREE.Material) => {
          const c = m.clone() as THREE.MeshToonMaterial;
          c.color?.multiply(tint);
          return c;
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(tinted) : tinted(mesh.material);
      });
      scene.add(model.root);
      const rand = rng(70 + i);
      const home = herd.clearSpot(shoreX(h.z) - (BASK_UP[0] + BASK_UP[1]) / 2, h.z, SUN_YAW + Math.PI / 2);
      // Staggered, so they don't all go to sea together.
      herd.list.push(new Iguana(model, world, home, SUN_YAW + Math.PI / 2, herd, rand, 25 + i * 45, water));
    }
    return herd;
  }

  /** Every other body an iguana must go round: the lizard's and the other iguanas'. */
  others(ig: Iguana): PlayerController[] {
    return [this.player, ...this.list.filter((o) => o !== ig && !o.gone).map((o) => o.body)];
  }

  /**
   * The nearest spot to (x, z) where a body lying along `yaw` is on bare black lava, above the sea,
   * and clear of every rock, log and tree.
   */
  private clearSpot(x: number, z: number, yaw: number) {
    const clear = (px: number, pz: number) => this.clearAt(px, pz, yaw);
    for (let r = 0; r < 0.6; r += 0.02) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        if (clear(px, pz) && terrainHeight(px, pz) > WATER_Y + 0.02) return { x: px, z: pz };
      }
    }
    return { x, z };
  }

  /** Whether (x, z) is clear of every rock, log and tree, with room for a body beside it. */
  open(x: number, z: number) {
    return !this.obstacles.some((o) => covers(o, x, z, BASK_CLEAR));
  }

  /** Whether a body lying along `yaw` at (x, z) is all on bare black lava, above the sea, clear of rocks, logs and trees. */
  private clearAt(x: number, z: number, yaw: number) {
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    return [-BODY_REACH, 0, BODY_REACH].every((s) => {
      const bx = x + fx * s;
      const bz = z + fz * s;
      return lavaCover(bx, bz) >= BLACK_LAVA && !this.obstacles.some((o) => covers(o, bx, bz, BASK_CLEAR));
    });
  }

  /**
   * Somewhere to bask: beside the nearest iguana basking within reach (the lizard lying still counts),
   * if there's room on black lava on one side of it; otherwise near its home, on dry lava a little up
   * from the water, clear of rocks.
   */
  baskSpot(ig: Iguana, rand: () => number): BaskSpot {
    const at = ig.body.position;
    // Lying still on the black lava.
    const lying = (b: PlayerController) =>
      b.grounded && !b.swimming && !b.climbing && b.horizontalSpeed < 0.02 && lavaCover(b.position.x, b.position.z) >= BLACK_LAVA;
    const mates = [
      ...(lying(this.player) ? [this.player] : []),
      ...this.list.filter((o) => o !== ig && !o.gone && o.activity === 'bask' && lying(o.body)).map((o) => o.body),
    ]
      .filter((m) => Math.hypot(m.position.x - at.x, m.position.z - at.z) < JOIN_RANGE)
      .sort((a, b) => Math.hypot(a.position.x - at.x, a.position.z - at.z) - Math.hypot(b.position.x - at.x, b.position.z - at.z));
    for (const m of mates) {
      const fx = Math.sin(m.yaw);
      const fz = Math.cos(m.yaw);
      const lx = Math.cos(m.yaw);
      const lz = -Math.sin(m.yaw);
      // The side and the end nearer the newcomer first.
      const nearSide = (at.x - m.position.x) * lx + (at.z - m.position.z) * lz >= 0 ? 1 : -1;
      const nearEnd = (at.x - m.position.x) * fx + (at.z - m.position.z) * fz >= 0 ? 1 : -1;
      for (const side of [nearSide, -nearSide]) {
        const x = m.position.x + lx * side * BESIDE;
        const z = m.position.z + lz * side * BESIDE;
        const crowded = this.others(ig).some((o) => o !== m && Math.hypot(o.position.x - x, o.position.z - z) < BESIDE);
        if (crowded || !this.clearAt(x, z, m.yaw)) continue;
        // Walking in along that line from off one end: no rock, log, tree or cactus on the way.
        for (const end of [nearEnd, -nearEnd]) {
          const steps = Math.ceil(LINE_UP / 0.02);
          const open = Array.from({ length: steps + 1 }, (_, i) => (i / steps) * LINE_UP).every(
            (d) => !this.obstacles.some((o) => covers(o, x + fx * end * d, z + fz * end * d, LANE)),
          );
          if (open) return { x, y: terrainHeight(x, z), z, mate: { body: m, x: m.position.x, z: m.position.z, yaw: m.yaw, end } };
        }
      }
    }
    return this.homeSpot(ig, rand);
  }

  /** Somewhere to bask near its home: on dry lava a little up from the water, clear of rocks. */
  private homeSpot(ig: Iguana, rand: () => number): BaskSpot {
    let z = ig.home.z + (rand() * 2 - 1) * BASK_RANGE;
    if (!offPiles(z)) z = ig.home.z;
    const up = BASK_UP[0] + (BASK_UP[1] - BASK_UP[0]) * rand();
    const spot = this.clearSpot(shoreX(z) - up, z, SUN_YAW + Math.PI / 2);
    return { ...spot, y: terrainHeight(spot.x, spot.z), mate: null };
  }

  /** Whether a patch is still there to eat. */
  growing(p: AlgaePatch) {
    return this.algae.get(p.id) === p;
  }

  /** Take a bite of a patch; true when that was the last of it. */
  bite(p: AlgaePatch) {
    return this.algae.bite(p.id, 1 / BITES_PER_PATCH);
  }

  /** An algae patch off its home shore to graze, near `after` if given (the patch it just left), or null. */
  food(ig: Iguana, rand: () => number, after: THREE.Vector3 | null): AlgaePatch | null {
    const taken = new Set(this.list.filter((o) => o !== ig).map((o) => o.meal));
    const ok = this.algae.all().filter((p) => {
      if (taken.has(p) || this.algae.grown(p.id) < RIPE || p.y > WATER_Y + 0.01 || p.y < WATER_Y - MAX_DIVE || !offPiles(p.z)) return false;
      if (after) return Math.hypot(p.x - after.x, p.z - after.z) < NEXT_PATCH && Math.hypot(p.x - after.x, p.z - after.z) > 0.05;
      return Math.abs(p.z - ig.home.z) < FOOD_RANGE && p.x - shoreX(p.z) < FOOD_OUT;
    });
    return ok.length ? ok[Math.floor(rand() * ok.length)] : null;
  }

  /**
   * The lizard walked into some of them this step: each one it ran into is pushed along the way the
   * lizard faces, at PUSH_SPEED, as far as there's room.
   */
  pushedBy(lizard: PlayerController, dt: number) {
    if (this.paused || lizard.swimming || lizard.climbing) return;
    for (const ig of this.list) {
      if (ig.gone || ig.body.swimming || !lizard.blockers.includes(ig.body.collider)) continue;
      ig.body.shove(Math.sin(lizard.yaw) * PUSH_SPEED * dt, Math.cos(lizard.yaw) * PUSH_SPEED * dt, lizard.collider);
    }
  }

  step(dt: number) {
    if (this.paused) return;
    for (const ig of this.list) ig.step(dt, this.plants);
  }

  update(alpha: number, dt: number) {
    if (this.paused) return;
    for (const ig of this.list) ig.update(alpha, dt, this.spray);
    this.spray.update(dt);
  }

  /** Every iguana's body as spheres (refreshed by `update`), for parting plants. */
  get bodySpheres() {
    return this.list.filter((ig) => !ig.gone).flatMap((ig) => ig.model.bodySpheres);
  }

  /** Scare every iguana within `r` of (x, z): a shadow going over. */
  scare(x: number, z: number, r: number) {
    if (this.paused) return;
    for (const ig of this.list) {
      if (Math.hypot(ig.body.position.x - x, ig.body.position.z - z) < r) ig.scare(x, z);
    }
  }

}
