import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { InputState } from '../input';
import { PlayerController } from '../player/controller';
import { MovementStateMachine } from '../player/state';
import { LizardModel } from '../player/lizardModel';
import { LizardVisual } from '../player/visual';
import { covers, type Obstacle } from '../world/obstacles';
import { ROCK_PILES } from '../world/layout';
import { rng } from '../world/noise';
import { shoreX, WATER_Y } from '../world/shore';
import { IGUANA_GROUP, terrainHeight } from '../world/terrain';
import type { Algae, AlgaePatch } from '../world/algae';
import type { Plants } from '../world/plants';
import { Splashes } from '../world/splashes';
import type { Water } from '../world/water';
import { SaltSpray } from './saltSpray';

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
export type IguanaActivity = 'bask' | 'shuffle' | 'to_food' | 'graze' | 'to_land';

/** Where each lives (z of its stretch of lava shore) and its skin tint (multiplies the texture). */
const HOMES = [
  { z: -0.7, tint: [1.14, 0.9, 0.82] },
  { z: -1.4, tint: [0.92, 1.04, 0.9] },
  { z: 2.7, tint: [0.8, 0.8, 0.84] },
] as const;
/** Basking spots are this far up from the waterline (m, from-to), and within this of home along the shore. */
const BASK_UP = [0.1, 0.32] as const;
const BASK_RANGE = 0.2;
/** It keeps this far (m) off the rock piles' sides, leaving them to the crabs. */
const PILE_BERTH = 0.12;
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
/** Grazes a patch this long (s, from-to), biting every so often (s, from-to), and goes on to at most this many. */
const GRAZE_TIME = [6, 12] as const;
const BITE_GAP = [0.5, 1.1] as const;
const MAX_PATCHES = 3;
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
/** A bite dips the head this far for this long (radians, s). */
const BITE_DIP = -0.3;
const BITE_TIME = 0.32;
/** The snout is this far ahead of the feet (m). */
const SNOUT = 0.08;
/** Arrived: feet within this of a spot, or snout within this of food and at about its height (m). */
const SPOT_REACH = 0.05;
const FOOD_REACH = 0.035;
const FOOD_LEVEL = 0.045;
/** Ambles at this share of the lizard's walking speed (about its walk clip's own pace). */
const AMBLE = 0.6;
/** Settling to bask, it creeps round at this share of walking pace until broadside to the sun (radians off). */
const CREEP = 0.12;
const SETTLE_TIME = 3;
const BROADSIDE_SLACK = 0.25;
/** Making less than this headway (m) for this long (s) is being stuck: it tries going round to one side. */
const HEADWAY = 0.015;
const STUCK_TIME = 2;
const DETOUR_TIME = 1.2;
const DETOUR_ANGLE = 1.2;
/** After this many tries it gives up on where it was going. */
const MAX_STUCK = 6;
/** Swimming, it kicks up (taps Space) this often (s) when deeper than it wants to be. */
const KICK_GAP = 0.6;
/** Heading back to land it keeps its back within this of the surface (m). */
const SURFACE_SWIM = 0.03;
/** Body top above the feet: skin, then the capsule's diameter (m). */
const BODY_TOP = 0.032;
/** Where the sun is (as in render/scene.ts): basking, the body lies across its rays. */
const SUN_YAW = Math.atan2(2.5, 1.7);

const offPiles = (z: number) => ROCK_PILES.every((p) => Math.abs(z - p.z) > p.width + PILE_BERTH);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Goal {
  x: number;
  y: number;
  z: number;
  /** Food: reached with the snout, at its height. */
  food: AlgaePatch | null;
}

class Iguana {
  readonly body: PlayerController;
  readonly states = new MovementStateMachine();
  readonly visual: LizardVisual;
  activity: IguanaActivity = 'bask';
  /** Counts, for tests. */
  sneezes = 0;
  bites = 0;
  meals = 0;
  private goal: Goal | null = null;
  private timer: number;
  private hunger: number;
  private sinceMeal = Infinity;
  private patches = 0;
  private foodTries = 0;
  private nextSneeze: number;
  private nextBite = 0;
  /** Time into the sneeze or bite under way, or -1. */
  private sneezeT = -1;
  private biteT = -1;
  private sprayDue = false;
  private settle = 0;
  private best = Infinity;
  private noHeadway = 0;
  private stuck = 0;
  private detour = 0;
  private kick = 0;
  private feet = new THREE.Vector3();
  private splashes: Splashes;
  private input: InputState = { move: { x: 0, y: 0 }, run: false, jump: false, look: { yaw: 0, pitch: 0 }, zoom: 0 };
  private v = new THREE.Vector3();
  private dir = new THREE.Vector3();

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
    return this.activity === 'to_food' || this.activity === 'graze' ? (this.goal?.food ?? null) : null;
  }

  get sneezing() {
    return this.sneezeT >= 0;
  }

  /** Go and feed now. */
  feed() {
    this.hunger = 0;
    this.timer = 0;
    this.patches = this.foodTries = 0;
    if (this.activity !== 'bask') this.startFeeding();
  }

  /** Sneeze now (if on land). */
  sneeze() {
    this.nextSneeze = 0;
  }

  step(dt: number, plants: Plants) {
    const b = this.body;
    b.feetAt(1, this.feet);
    this.input.move.x = this.input.move.y = 0;
    this.input.jump = false;
    this.think(dt);
    b.speedScale = plants.speedScale(this.feet.x, this.feet.z, Math.sin(b.yaw), Math.cos(b.yaw));
    b.step(dt, this.input);
    this.states.update(
      {
        grounded: b.grounded,
        jumped: b.jumped,
        landed: b.landed,
        verticalSpeed: b.velocity.y,
        horizontalSpeed: b.horizontalSpeed,
        climbing: b.climbing,
        swimming: b.swimming,
      },
      dt,
    );
    this.splashes.update(b, dt);
    this.animate(dt);
  }

  private think(dt: number) {
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
        const r = this.navigate(dt);
        if (r === 'arrived' || (r === 'gave_up' && !this.body.swimming)) this.startBasking();
        else if (r === 'gave_up') this.headForLand();
        return;
      }
      case 'to_food': {
        const r = this.navigate(dt);
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
    // Settling in: creep round to lie across the sun's rays.
    if (this.settle > 0) {
      this.settle -= dt;
      const goal = [SUN_YAW + Math.PI / 2, SUN_YAW - Math.PI / 2].reduce((a, c) => (Math.abs(wrap(c - b.yaw)) < Math.abs(wrap(a - b.yaw)) ? c : a));
      const diff = wrap(goal - b.yaw);
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
      this.setGoal(this.herd.baskSpot(this, this.rand), null);
    }
  }

  private startBasking() {
    this.activity = 'bask';
    this.goal = null;
    this.timer = this.between(BASK_TIME);
    this.settle = SETTLE_TIME;
  }

  private startFeeding() {
    const food = this.herd.food(this, this.rand, this.patches > 0 ? this.feet : null);
    if (!food) return this.headForLand();
    this.activity = 'to_food';
    this.setGoal(food, food);
  }

  private startGrazing() {
    this.activity = 'graze';
    this.foodTries = 0;
    this.timer = this.between(GRAZE_TIME);
    this.nextBite = 0.3;
    this.patches++;
  }

  private graze(dt: number) {
    this.nextBite -= dt;
    if (this.nextBite <= 0) {
      this.biteT = 0;
      this.bites++;
      this.nextBite = this.between(BITE_GAP);
    }
    // Drifting in the water, nose back in to the patch.
    const g = this.goal!;
    const b = this.body;
    const sx = this.feet.x + Math.sin(b.yaw) * SNOUT;
    const sz = this.feet.z + Math.cos(b.yaw) * SNOUT;
    if (Math.hypot(g.x - sx, g.z - sz) > FOOD_REACH * 2) this.steer(g, 0.4);
    this.timer -= dt;
    if (this.timer > 0) return;
    if (this.patches < MAX_PATCHES && this.rand() < 0.6) return this.startFeeding();
    this.meals++;
    this.sinceMeal = 0;
    this.hunger = this.between(HUNGER);
    this.headForLand();
  }

  private headForLand() {
    this.activity = 'to_land';
    this.setGoal(this.herd.baskSpot(this, this.rand), null);
  }

  private setGoal(at: { x: number; y: number; z: number }, food: AlgaePatch | null) {
    this.goal = { x: at.x, y: at.y, z: at.z, food };
    this.best = Infinity;
    this.noHeadway = this.stuck = this.detour = 0;
  }

  /** Head for the goal, going round what's in the way. */
  private navigate(dt: number): 'going' | 'arrived' | 'gave_up' {
    const g = this.goal!;
    const b = this.body;
    const fx = Math.sin(b.yaw);
    const fz = Math.cos(b.yaw);
    const reachFrom = g.food ? SNOUT : 0;
    const flat = Math.hypot(g.x - (this.feet.x + fx * reachFrom), g.z - (this.feet.z + fz * reachFrom));
    const dy = g.y - this.feet.y;
    if (g.food ? flat < FOOD_REACH && Math.abs(dy) < FOOD_LEVEL : flat < SPOT_REACH) return 'arrived';

    const dist = Math.hypot(flat, g.food ? dy : 0);
    if (dist < this.best - HEADWAY) {
      this.best = dist;
      this.noHeadway = 0;
    } else if ((this.noHeadway += dt) > STUCK_TIME) {
      if (++this.stuck > MAX_STUCK) return 'gave_up';
      this.best = dist;
      this.noHeadway = 0;
      this.detour = DETOUR_TIME;
      // On land a hop sometimes gets it up a ledge it can't climb.
      if (!b.swimming && this.stuck % 3 === 0) this.input.jump = true;
    }
    let side = 0;
    if (this.detour > 0) {
      this.detour -= dt;
      side = (this.stuck % 2 === 1 ? 1 : -1) * DETOUR_ANGLE;
    }
    // Right over the food and above it: stop and sink down to it.
    const sinking = b.swimming && g.food !== null && flat < FOOD_REACH * 1.5 && dy < 0;
    this.steer(g, sinking ? 0 : flat < 0.1 ? AMBLE * 0.6 : AMBLE, side);

    if (b.swimming) {
      // Kick up toward food above it, or toward the surface going back to land.
      const deep = g.food ? dy > 0.02 : this.feet.y + BODY_TOP < WATER_Y - SURFACE_SWIM;
      this.kick -= dt;
      if (deep && this.kick <= 0) {
        this.input.jump = true;
        this.kick = KICK_GAP;
      }
    }
    return 'going';
  }

  /** Turn toward the goal (plus `side` radians), moving at `pace` once facing roughly its way. */
  private steer(g: Goal, pace: number, side = 0) {
    const b = this.body;
    const diff = wrap(Math.atan2(g.x - this.feet.x, g.z - this.feet.z) + side - b.yaw);
    this.input.move.x = clamp(-diff * 2.5, -1, 1);
    // On land the body only turns while moving, so it keeps creeping; in the water it turns on the spot.
    const facing = Math.abs(diff) < 0.9;
    this.input.move.y = facing ? pace : b.swimming ? 0 : Math.min(pace, 0.3);
    if (b.swimming && facing && pace > 0) this.input.move.y = 1;
  }

  private animate(dt: number) {
    if (this.sneezeT >= 0) {
      const before = this.sneezeT;
      this.sneezeT += dt;
      if (before < SNEEZE_BLOW && this.sneezeT >= SNEEZE_BLOW) this.sprayDue = true;
      if (this.sneezeT >= SNEEZE_TIME) this.sneezeT = -1;
    }
    if (this.biteT >= 0 && (this.biteT += dt) >= BITE_TIME) this.biteT = -1;
  }

  /** The head's nod for the sneeze or bite under way (radians, positive snout up). */
  private nod(): number {
    const smooth = (x: number) => x * x * (3 - 2 * x);
    const t = this.sneezeT;
    if (t >= 0) {
      if (t < SNEEZE_WINDUP) return SNEEZE_UP * smooth(t / SNEEZE_WINDUP);
      if (t < SNEEZE_BLOW) return SNEEZE_UP + (SNEEZE_DOWN - SNEEZE_UP) * smooth((t - SNEEZE_WINDUP) / (SNEEZE_BLOW - SNEEZE_WINDUP));
      return SNEEZE_DOWN * (1 - smooth((t - SNEEZE_BLOW) / (SNEEZE_TIME - SNEEZE_BLOW)));
    }
    if (this.biteT >= 0) return BITE_DIP * Math.sin((Math.PI * this.biteT) / BITE_TIME);
    return 0;
  }

  update(alpha: number, dt: number, spray: SaltSpray) {
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

  private constructor(
    scene: THREE.Scene,
    private obstacles: readonly Obstacle[],
    private algae: Algae,
    private plants: Plants,
  ) {
    this.spray = new SaltSpray(scene);
  }

  static async load(url: string, scene: THREE.Scene, world: RAPIER.World, obstacles: readonly Obstacle[], algae: Algae, plants: Plants, water: Water) {
    const herd = new Iguanas(scene, obstacles, algae, plants);
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

  /** The nearest spot to (x, z) where a body lying along `yaw` is clear of every rock, log and tree. */
  private clearSpot(x: number, z: number, yaw: number) {
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const clear = (px: number, pz: number) =>
      [-BODY_REACH, 0, BODY_REACH].every((s) => !this.obstacles.some((o) => covers(o, px + fx * s, pz + fz * s, BASK_CLEAR)));
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

  /** Somewhere to bask near its home: on dry lava a little up from the water, clear of rocks. */
  baskSpot(ig: Iguana, rand: () => number) {
    let z = ig.home.z + (rand() * 2 - 1) * BASK_RANGE;
    if (!offPiles(z)) z = ig.home.z;
    const up = BASK_UP[0] + (BASK_UP[1] - BASK_UP[0]) * rand();
    const spot = this.clearSpot(shoreX(z) - up, z, SUN_YAW + Math.PI / 2);
    return { ...spot, y: terrainHeight(spot.x, spot.z) };
  }

  /** An algae patch off its home shore to graze, near `after` if given (the patch it just left), or null. */
  food(ig: Iguana, rand: () => number, after: THREE.Vector3 | null): AlgaePatch | null {
    const taken = new Set(this.list.filter((o) => o !== ig).map((o) => o.meal));
    const ok = this.algae.all().filter((p) => {
      if (taken.has(p) || p.y > WATER_Y + 0.01 || p.y < WATER_Y - MAX_DIVE || !offPiles(p.z)) return false;
      if (after) return Math.hypot(p.x - after.x, p.z - after.z) < NEXT_PATCH && Math.hypot(p.x - after.x, p.z - after.z) > 0.05;
      return Math.abs(p.z - ig.home.z) < FOOD_RANGE && p.x - shoreX(p.z) < FOOD_OUT;
    });
    return ok.length ? ok[Math.floor(rand() * ok.length)] : null;
  }

  step(dt: number) {
    for (const ig of this.list) ig.step(dt, this.plants);
  }

  update(alpha: number, dt: number) {
    for (const ig of this.list) ig.update(alpha, dt, this.spray);
    this.spray.update(dt);
  }

  /** Every iguana's body as spheres (refreshed by `update`), for parting plants. */
  get bodySpheres() {
    return this.list.flatMap((ig) => ig.model.bodySpheres);
  }
}
