import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { InputState } from '../input';
import { PlayerController } from '../player/controller';
import { MovementStateMachine } from '../player/state';
import { LizardModel } from '../player/lizardModel';
import { LizardVisual } from '../player/visual';
import { covers, type Obstacle } from '../world/obstacles';
import { lavaCover, ROCK_PILES } from '../world/layout';
import { rng } from '../world/noise';
import { shoreX, WATER_Y } from '../world/shore';
import { IGNORE_BODIES, IGUANA_GROUP, terrainHeight } from '../world/terrain';
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
/** Another body (the lizard, another iguana) this far ahead on its way (m) and nearer its line than this (m) is passed to one side. */
const LOOK_AHEAD = 0.3;
const PASS_WIDE = 0.1;
/** Passing, it bears off this far (radians) and sticks to the side it picked for this long (s). */
const AVOID_ANGLE = 0.9;
const AVOID_HOLD = 1;
/** Someone lying within this of the spot it's going to bask on (m): it picks another spot, at most this many times. */
const SPOT_TAKEN = 0.12;
const RE_PICKS = 3;
/**
 * Looking for somewhere to bask, it lies down beside another iguana basking within this (m), the
 * lizard included, side by side and the same way round, for the warmth: this far apart, centre to
 * centre (two 12 mm bodies with a few mm between). It walks this close to the spot before settling.
 */
const JOIN_RANGE = 0.8;
const BESIDE = 0.052;
/** It lines up this far (m) off the mate's end before walking in alongside it. */
const LEAD_IN = 0.1;
const LINE_UP = 0.2;
const VIA_REACH = 0.03;
const MATE_REACH = 0.03;
/** The mate it's going to lie beside moving this far (m) sends it to look again. */
const MATE_MOVED = 0.05;
/**
 * It won't go on if that would bring its body within BODY_GAP (m, centre line to centre line) of
 * another's, this far ahead: two 12 mm bodies, plus the 8 mm each one's controller keeps clear of
 * anything (closer, the other's controller steps it away: a shove), and a little more.
 */
const GIVE_WAY_LOOK = 0.012;
const GIVE_WAY_TURN = 0.08;
const BODY_GAP = 0.05;
const MATE_GAP = 0.036;
/** Half the straight part of a body's centre line, snout end to hips (m). */
const BODY_HALF = 0.048;
/** Swimming, it kicks up (taps Space) this often (s) when deeper than it wants to be. */
const KICK_GAP = 0.6;
/** Heading back to land it keeps its back within this of the surface (m). */
const SURFACE_SWIM = 0.03;
/** Body top above the feet: skin, then the capsule's diameter (m). */
const BODY_TOP = 0.032;
/** Where the sun is (as in render/scene.ts): basking, the body lies across its rays. */
const SUN_YAW = Math.atan2(2.5, 1.7);

/** Closest distance between two bodies' centre lines in the ground plane, each a segment ±BODY_HALF along its facing. */
function segmentGap(ax: number, az: number, afx: number, afz: number, bx: number, bz: number, bfx: number, bfz: number): number {
  let best = Infinity;
  // Sampled is plenty at this size.
  for (let i = -4; i <= 4; i++) {
    const px = ax + afx * BODY_HALF * (i / 4);
    const pz = az + afz * BODY_HALF * (i / 4);
    const t = Math.max(-BODY_HALF, Math.min(BODY_HALF, (px - bx) * bfx + (pz - bz) * bfz));
    best = Math.min(best, Math.hypot(px - bx - bfx * t, pz - bz - bfz * t));
  }
  return best;
}

const offPiles = (z: number) => ROCK_PILES.every((p) => Math.abs(z - p.z) > p.width + PILE_BERTH);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Goal {
  x: number;
  y: number;
  z: number;
  /** Food: reached with the snout, at its height. */
  food: AlgaePatch | null;
  /** Basking beside another body: it, where it lay when picked, and the way to lie (parallel to it). */
  mate: { body: PlayerController; x: number; z: number; yaw: number; end: number } | null;
  /**
   * First go to these, in turn (two points in line beside the mate, off its nearer end), so it's
   * lined up with the mate before the last stretch in alongside it.
   */
  via: { x: number; z: number }[];
}

/** A spot to bask on, maybe beside a mate. */
export interface BaskSpot {
  x: number;
  y: number;
  z: number;
  mate: Goal['mate'];
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
  /** Settling in, the way to lie: beside a mate, parallel to it; null, across the sun's rays. */
  private settleYaw: number | null = null;
  private beside: PlayerController | null = null;
  private best = Infinity;
  private noHeadway = 0;
  private stuck = 0;
  private detour = 0;
  private kick = 0;
  private avoidSide = 0;
  private avoidHold = 0;
  private rePicks = 0;
  private other = new THREE.Vector3();
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
    this.body.stillGroups = IGNORE_BODIES;
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

  /** Who it's going to lie beside, or is lying beside: the lizard's or another iguana's body, or null. */
  get mate(): PlayerController | null {
    return this.goal?.mate?.body ?? this.beside;
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

  /** Basking, get up now and look for somewhere else to bask. */
  moveOn() {
    if (this.activity === 'bask') this.timer = 0;
    this.hunger = Math.max(this.hunger, 1);
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
    this.giveWay();
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
    // Settling in: creep round to lie across the sun's rays, or alongside its mate.
    if (this.settle > 0) {
      this.settle -= dt;
      const goal =
        this.settleYaw ?? [SUN_YAW + Math.PI / 2, SUN_YAW - Math.PI / 2].reduce((a, c) => (Math.abs(wrap(c - b.yaw)) < Math.abs(wrap(a - b.yaw)) ? c : a));
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
    this.rePicks = 0;
    // Alongside the mate, head to head or head to tail, whichever it came in as.
    const m = this.goal?.mate;
    this.settleYaw = m ? (Math.cos(this.body.yaw - m.yaw) >= 0 ? m.yaw : m.yaw + Math.PI) : null;
    this.beside = this.goal?.mate?.body ?? null;
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

  private setGoal(at: { x: number; y: number; z: number; mate?: Goal['mate'] }, food: AlgaePatch | null) {
    this.goal = { x: at.x, y: at.y, z: at.z, food, mate: at.mate ?? null, via: [] };
    const m = at.mate;
    if (m) {
      // Off the end of the mate that was picked.
      const fx = Math.sin(m.yaw);
      const fz = Math.cos(m.yaw);
      this.goal.via = [LINE_UP, LEAD_IN].map((d) => ({ x: at.x + fx * m.end * d, z: at.z + fz * m.end * d }));
    }
    this.beside = null;
    this.best = Infinity;
    this.noHeadway = this.stuck = this.detour = 0;
  }

  /**
   * How far to bear off (radians) the heading to the goal `reach` metres away, to pass the lizard or
   * another iguana lying in the way instead of walking into it.
   */
  private avoid(dt: number, heading: number, reach: number, mate: PlayerController | null): number {
    const dx = Math.sin(heading);
    const dz = Math.cos(heading);
    let near = Infinity;
    let lateral = 0;
    for (const o of this.herd.others(this)) {
      // Lining up off its mate's end and walking in alongside it, its way is clear of the mate.
      if (o === mate) continue;
      o.feetAt(1, this.other);
      if (Math.abs(this.other.y - this.feet.y) > 0.06) continue;
      const ox = Math.sin(o.yaw);
      const oz = Math.cos(o.yaw);
      // Along its body, snout to hips.
      for (const s of [-0.08, -0.03, 0.03, 0.08]) {
        const qx = this.other.x + ox * s - this.feet.x;
        const qz = this.other.z + oz * s - this.feet.z;
        const along = qx * dx + qz * dz;
        const across = qx * dz - qz * dx;
        if (along <= 0 || along > Math.min(LOOK_AHEAD, reach) || Math.abs(across) > PASS_WIDE || along >= near) continue;
        near = along;
        lateral = across;
      }
    }
    if (near === Infinity) {
      this.avoidHold -= dt;
      if (this.avoidHold <= 0) this.avoidSide = 0;
    } else {
      // Bear away from the side it's on, and keep to that side once picked so it doesn't dither.
      if (this.avoidSide === 0) this.avoidSide = lateral > 0 ? -1 : 1;
      this.avoidHold = AVOID_HOLD;
    }
    return this.avoidSide * AVOID_ANGLE;
  }

  /**
   * Never walk into another body: about to go forward with the lizard or another iguana just ahead,
   * it backs off instead (still turning, so it comes round), rather than shoving it aside.
   */
  private giveWay() {
    const b = this.body;
    if (this.input.move.y <= 0 || b.swimming) return;
    const fx = Math.sin(b.yaw);
    const fz = Math.cos(b.yaw);
    // Where it'll be in a few steps, turned as it's turning: a turn swings its ends sideways too.
    const yaw = b.yaw - this.input.move.x * GIVE_WAY_TURN;
    const nx = Math.sin(yaw);
    const nz = Math.cos(yaw);
    const x = b.position.x + nx * GIVE_WAY_LOOK;
    const z = b.position.z + nz * GIVE_WAY_LOOK;
    // Coming in alongside its mate it may close to just clear of it.
    const mate = this.goal && this.goal.via.length === 0 ? this.goal.mate?.body : null;
    for (const o of this.herd.others(this)) {
      if (Math.abs(o.position.y - b.position.y) > 0.05) continue;
      const clear = o === mate ? MATE_GAP : BODY_GAP;
      const gap = segmentGap(x, z, nx, nz, o.position.x, o.position.z, Math.sin(o.yaw), Math.cos(o.yaw));
      // Already closer than that and getting no closer by going on (alongside a mate) is fine.
      if (gap < clear && gap < segmentGap(b.position.x, b.position.z, fx, fz, o.position.x, o.position.z, Math.sin(o.yaw), Math.cos(o.yaw)) - 1e-4) {
        this.input.move.y = -0.6;
        return;
      }
    }
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
    if (g.food ? flat < FOOD_REACH && Math.abs(dy) < FOOD_LEVEL : flat < (g.mate ? MATE_REACH : SPOT_REACH)) return 'arrived';
    // Someone's lying where it meant to bask, or the mate it was going to lie beside has gone: look again.
    const taken = this.herd.others(this).some((o) => o !== g.mate?.body && Math.hypot(o.position.x - g.x, o.position.z - g.z) < SPOT_TAKEN);
    const left = g.mate && Math.hypot(g.mate.body.position.x - g.mate.x, g.mate.body.position.z - g.mate.z) > MATE_MOVED;
    if (!g.food && this.rePicks < RE_PICKS && (taken || left)) {
      this.rePicks++;
      this.setGoal(this.herd.baskSpot(this, this.rand), null);
      return 'going';
    }

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
    if (g.via.length && Math.hypot(g.via[0].x - this.feet.x, g.via[0].z - this.feet.z) < VIA_REACH) g.via.shift();
    const to = g.via[0] ?? g;
    // Once lined up off the mate's end, it walks in past it, on its line.
    const onLine = g.via.length <= 1 ? (g.mate?.body ?? null) : null;
    let side = this.avoid(dt, Math.atan2(to.x - this.feet.x, to.z - this.feet.z), Math.hypot(to.x - this.feet.x, to.z - this.feet.z), onLine);
    if (this.detour > 0) {
      this.detour -= dt;
      side = (this.stuck % 2 === 1 ? 1 : -1) * DETOUR_ANGLE;
    }
    // Right over the food and above it: stop and sink down to it.
    const sinking = b.swimming && g.food !== null && flat < FOOD_REACH * 1.5 && dy < 0;
    // Near the spot, or lining up off its mate's end, it slows so it turns tight.
    this.steer(to, sinking ? 0 : flat < 0.1 || (g.mate && g.via.length <= 1) ? AMBLE * 0.5 : AMBLE, side);

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
  private steer(g: { x: number; z: number }, pace: number, side = 0) {
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
    return [this.player, ...this.list.filter((o) => o !== ig).map((o) => o.body)];
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
    const lying = (b: PlayerController) => b.grounded && !b.swimming && !b.climbing && b.horizontalSpeed < 0.02;
    const mates = [
      ...(lying(this.player) ? [this.player] : []),
      ...this.list.filter((o) => o !== ig && o.activity === 'bask' && lying(o.body)).map((o) => o.body),
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
            (d) => !this.obstacles.some((o) => covers(o, x + fx * end * d, z + fz * end * d, 0.01)),
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
