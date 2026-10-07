import * as THREE from 'three';
import type { InputState } from '../input';
import type { PlayerController } from '../player/controller';
import { MOVEMENT } from '../player/movement';
import { wrapAngle } from '../math/angles';
import type { AlgaePatch } from '../world/algae';
import { WATER_Y } from '../world/shore';

/** The snout is this far ahead of the feet (m). */
const SNOUT = 0.08;

/** Arrived: feet within this of a spot, or snout within this of food and at about its height (m). */
const SPOT_REACH = 0.05;
const FOOD_REACH = 0.035;
const FOOD_LEVEL = 0.045;

/** Ambles at this share of the lizard's walking speed (about its walk clip's own pace). */
const AMBLE = 0.6;

/**
 * Walking to a point, it keeps its turning circle's diameter to at most this share of the way there,
 * slowing down for a sharp turn close by, but never below this share of walking pace.
 */
const TURN_IN = 0.4;
const MIN_PACE = 0.06;

/** Making less than this headway (m) for this long (s) is being stuck: it tries going round to one side. */
const HEADWAY = 0.015;
const STUCK_TIME = 2;
const DETOUR_TIME = 1.2;
const DETOUR_ANGLE = 1.2;

/** After this many tries it gives up on where it was going. */
const MAX_STUCK = 6;

/**
 * Another body (the lizard, another iguana) within this far ahead (m) whose centre line comes nearer
 * its way than PASS_WIDE (m) is gone round: it walks to a point beside that body, PASS_CLEAR (m) out
 * from its centre line on the side that's the shorter way round, then on to where it was going.
 */
const LOOK_AHEAD = 0.3;
const PASS_WIDE = 0.06;
const PASS_CLEAR = 0.075;

/** A body's centre line runs this far (m) each way from its middle, end caps included. */
const BODY_ENDS = 0.06;

/** Someone lying within this of the spot it's going to bask on (m): it picks another spot, at most this many times. */
const SPOT_TAKEN = 0.12;
const RE_PICKS = 3;

/**
 * It comes in alongside the mate along a line off the mate's end: first to a point LINE_UP (m) out
 * along it, unless it's already behind that end, more than LEAD_IN out and nearer the line than that
 * is out, and then in along the line to its spot, steering for a point CARROT (m) further in than
 * where it is, which brings it onto the line in one smooth curve.
 */
const LEAD_IN = 0.1;
export const LINE_UP = 0.2;
const CARROT = 0.04;
const VIA_REACH = 0.03;

/**
 * Beside a mate, it's close enough to lie down once within this of level with its spot (m, either
 * way) and this near the line in: alongside, even if a body or the lie of the rock keeps it a little
 * short of the exact spot or a little wide of it, rather than pushing on at the mate.
 */
const MATE_LEVEL = 0.035;
const MATE_LINE = 0.04;

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
export const KICK_GAP = 0.6;

/** Heading back to land it keeps its back within this of the surface (m). */
const SURFACE_SWIM = 0.03;

/** Body top above the feet: skin, then the capsule's diameter (m). */
const BODY_TOP = 0.032;

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

/**
 * Closest distance in the ground plane between the path from a to b and a body's centre line (±BODY_ENDS
 * along its facing), counting only the part of the body level with the path before b: a body just
 * beyond or beside the end of the path (a mate it's walking up to) isn't in its way.
 */
function pathGap(o: PlayerController, ax: number, az: number, bx: number, bz: number): number {
  const px = bx - ax;
  const pz = bz - az;
  const len2 = px * px + pz * pz || 1e-9;
  const fx = Math.sin(o.yaw);
  const fz = Math.cos(o.yaw);
  let best = Infinity;
  for (let i = -6; i <= 6; i++) {
    const qx = o.position.x + fx * BODY_ENDS * (i / 6);
    const qz = o.position.z + fz * BODY_ENDS * (i / 6);
    const t = ((qx - ax) * px + (qz - az) * pz) / len2;
    if (t >= 1) continue;
    const c = Math.max(0, t);
    best = Math.min(best, Math.hypot(qx - ax - px * c, qz - az - pz * c));
  }
  return best;
}

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
   * First go to these, in turn (the point on the line in beside the mate, off its nearer end), so
   * it's lined up with the mate before the last stretch in alongside it.
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

interface NavigationContext {
  others(): PlayerController[];
  open(x: number, z: number): boolean;
  growing(patch: AlgaePatch): boolean;
  baskSpot(): BaskSpot;
  goalChanged(): void;
}

/** Steering, obstacle avoidance and recovery for one iguana; activity decisions stay in Iguana. */
export class IguanaNavigation {
  goal: Goal | null = null;
  private best = Infinity;
  private noHeadway = 0;
  private stuck = 0;
  private detour = 0;
  kick = 0;
  /**
   * Going round a body in its way: which body, which side (+1 its left of the way, -1 its right), and
   * the way it was heading when it picked the side, which the points beside the body are laid out along.
   */
  pass: { body: PlayerController; side: number; dx: number; dz: number } | null = null;
  /** Where it's making for right now (a via point, a point beside a body, or the goal), for headway. */
  private aim = new THREE.Vector2(NaN, NaN);
  rePicks = 0;

  constructor(
    private body: PlayerController,
    private feet: THREE.Vector3,
    private input: InputState,
    private context: NavigationContext,
  ) {}

  setGoal(at: { x: number; y: number; z: number; mate?: Goal['mate'] }, food: AlgaePatch | null) {
    this.goal = { x: at.x, y: at.y, z: at.z, food, mate: at.mate ?? null, via: [] };
    const m = at.mate;
    if (m) {
      // Off the end of the mate that was picked.
      const fx = Math.sin(m.yaw);
      const fz = Math.cos(m.yaw);
      this.goal.via = [{ x: at.x + fx * m.end * LINE_UP, z: at.z + fz * m.end * LINE_UP }];
    }
    this.context.goalChanged();
    this.pass = null;
    this.best = Infinity;
    this.noHeadway = this.stuck = this.detour = 0;
  }

  /** The nearest body (the lizard, another iguana) in the way from its feet to `to`, other than `skip`, or null. */
  private inTheWay(to: { x: number; z: number }, skip: PlayerController | null): PlayerController | null {
    const reach = Math.hypot(to.x - this.feet.x, to.z - this.feet.z);
    const look = Math.min(LOOK_AHEAD, reach) / (reach || 1);
    const bx = this.feet.x + (to.x - this.feet.x) * look;
    const bz = this.feet.z + (to.z - this.feet.z) * look;
    let near: PlayerController | null = null;
    let nearest = Infinity;
    for (const o of this.context.others()) {
      if (o === skip || Math.abs(o.position.y - this.body.position.y) > 0.06) continue;
      if (pathGap(o, this.feet.x, this.feet.z, bx, bz) > PASS_WIDE) continue;
      const d = Math.hypot(o.position.x - this.feet.x, o.position.z - this.feet.z);
      if (d < nearest) {
        nearest = d;
        near = o;
      }
    }
    return near;
  }

  /**
   * The two points beside body `o` on `side` of the way (dx, dz): PASS_CLEAR out from the furthest
   * its centre line reaches on that side, level with its near end and with its far end.
   */
  private besidePoints(o: PlayerController, side: number, dx: number, dz: number) {
    // Across the way, positive to its left.
    const lx = dz;
    const lz = -dx;
    const fx = Math.sin(o.yaw);
    const fz = Math.cos(o.yaw);
    let out = -Infinity;
    let lo = Infinity;
    let hi = -Infinity;
    for (const e of [-BODY_ENDS, BODY_ENDS]) {
      out = Math.max(out, side * (fx * lx + fz * lz) * e);
      const along = (fx * dx + fz * dz) * e;
      lo = Math.min(lo, along);
      hi = Math.max(hi, along);
    }
    const off = side * (out + PASS_CLEAR);
    const at = (a: number) => ({ x: o.position.x + lx * off + dx * a, z: o.position.z + lz * off + dz * a });
    return { near: at(lo), far: at(hi) };
  }

  /**
   * Where to make for to get round a body in the way to `to`: beside it, on the side it picked when
   * it first met it (the shorter way round that isn't into a rock), kept to until the way is clear.
   * Null when nothing's in the way.
   */
  private passPoint(to: { x: number; z: number }, skip: PlayerController | null): { x: number; z: number } | null {
    const o = this.inTheWay(to, skip);
    if (!o) {
      this.pass = null;
      return null;
    }
    const reach = Math.hypot(to.x - this.feet.x, to.z - this.feet.z) || 1;
    const dx = (to.x - this.feet.x) / reach;
    const dz = (to.z - this.feet.z) / reach;
    if (this.pass?.body !== o) {
      // How far off its way each side's point lies, and whether it's clear of rocks there.
      const sides = [1, -1].map((side) => {
        const { near, far } = this.besidePoints(o, side, dx, dz);
        const off = Math.abs((far.x - this.feet.x) * dz - (far.z - this.feet.z) * dx);
        const open = [near, far].every((p) => this.context.open(p.x, p.z));
        return { side, cost: off + (open ? 0 : 1) };
      });
      sides.sort((a, b) => a.cost - b.cost);
      this.pass = { body: o, side: sides[0].side, dx, dz };
    }
    const p = this.pass;
    let { near, far } = this.besidePoints(o, p.side, p.dx, p.dz);
    // Got there and it's still in the way (it lies along the way, or moved): lay the points out afresh from here.
    if (Math.hypot(far.x - this.feet.x, far.z - this.feet.z) < VIA_REACH) {
      p.dx = dx;
      p.dz = dz;
      ({ near, far } = this.besidePoints(o, p.side, dx, dz));
    }
    // Round its near end first if heading straight for the far point would clip it.
    return pathGap(o, this.feet.x, this.feet.z, far.x, far.z) < PASS_WIDE && Math.hypot(near.x - this.feet.x, near.z - this.feet.z) > VIA_REACH ? near : far;
  }

  /**
   * Never walk into another body: about to go forward with the lizard or another iguana just ahead,
   * it backs off instead (still turning, so it comes round), rather than shoving it aside.
   */
  giveWay() {
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
    for (const o of this.context.others()) {
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
  navigate(dt: number): 'going' | 'arrived' | 'gave_up' {
    const g = this.goal!;
    const b = this.body;
    const fx = Math.sin(b.yaw);
    const fz = Math.cos(b.yaw);
    const reachFrom = g.food ? SNOUT : 0;
    const flat = Math.hypot(g.x - (this.feet.x + fx * reachFrom), g.z - (this.feet.z + fz * reachFrom));
    const dy = g.y - this.feet.y;
    if (g.food && !this.context.growing(g.food)) return 'gave_up';
    const m = g.mate;
    // How far out along the line in beside the mate it is, from its spot toward the mate's end, and how far off the line.
    const ex = m ? Math.sin(m.yaw) * m.end : 0;
    const ez = m ? Math.cos(m.yaw) * m.end : 0;
    const out = (this.feet.x - g.x) * ex + (this.feet.z - g.z) * ez;
    const off = Math.abs((this.feet.x - g.x) * ez - (this.feet.z - g.z) * ex);
    // Beside the mate it's there once about level with its spot, not just near it, so it lies alongside, not off its end.
    const there = g.food ? flat < FOOD_REACH && Math.abs(dy) < FOOD_LEVEL : m ? Math.abs(out) < MATE_LEVEL && off < MATE_LINE : flat < SPOT_REACH;
    if (there) return 'arrived';
    // Someone's lying where it meant to bask, or the mate it was going to lie beside has gone: look again.
    const taken = this.context.others().some((o) => o !== g.mate?.body && Math.hypot(o.position.x - g.x, o.position.z - g.z) < SPOT_TAKEN);
    const left = g.mate && Math.hypot(g.mate.body.position.x - g.mate.x, g.mate.body.position.z - g.mate.z) > MATE_MOVED;
    if (!g.food && this.rePicks < RE_PICKS && (taken || left)) {
      this.rePicks++;
      this.setGoal(this.context.baskSpot(), null);
      return 'going';
    }

    if (g.via.length && Math.hypot(g.via[0].x - this.feet.x, g.via[0].z - this.feet.z) < VIA_REACH) g.via.shift();
    let to: { x: number; z: number } = g.via[0] ?? g;
    if (m) {
      if (g.via.length && out > LEAD_IN && off < out - LEAD_IN) g.via.length = 0;
      if (!g.via.length) {
        const ahead = Math.max(0, out - CARROT);
        to = { x: g.x + ex * ahead, z: g.z + ez * ahead };
      }
    }
    // Once lined up off the mate's end, it walks in past it, on its line.
    const onLine = g.via.length === 0 ? (m?.body ?? null) : null;
    const pass = this.passPoint(to, onLine);
    const aim = pass ?? to;
    // Going round someone, headway is measured toward the point beside them, so that isn't being stuck.
    if (!(Math.hypot(aim.x - this.aim.x, aim.z - this.aim.y) < 0.03)) this.best = Infinity;
    this.aim.set(aim.x, aim.z);
    const dist = pass ? Math.hypot(pass.x - this.feet.x, pass.z - this.feet.z) : Math.hypot(flat, g.food ? dy : 0);
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
    // Near the spot, or lining up off its mate's end, it slows so it turns tight.
    this.steer(aim, sinking ? 0 : flat < 0.1 || (g.mate && g.via.length === 0) ? AMBLE * 0.5 : AMBLE, side);

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
  steer(g: { x: number; z: number }, pace: number, side = 0) {
    const b = this.body;
    const diff = wrapAngle(Math.atan2(g.x - this.feet.x, g.z - this.feet.z) + side - b.yaw);
    this.input.move.x = clamp(-diff * 2.5, -1, 1);
    // On land the body only turns while moving, so it keeps creeping; in the water it turns on the spot.
    const facing = Math.abs(diff) < 0.9;
    this.input.move.y = facing ? pace : b.swimming ? 0 : Math.min(pace, 0.3);
    if (b.swimming && facing && pace > 0) this.input.move.y = 1;
    else if (!b.swimming && pace > 0) {
      // It turns at a set rate, so the faster it walks the wider it swings. A point off to one side
      // closer than its turning circle would have it walking round and round it: slow down enough to
      // turn in to it, a walk of that circle's diameter being well short of the way there.
      const dist = Math.hypot(g.x - this.feet.x, g.z - this.feet.z);
      const across = Math.abs(diff) < Math.PI / 2 ? Math.sin(Math.abs(diff)) : 1;
      const tight = (TURN_IN * dist * MOVEMENT.turnRate) / (2 * Math.max(across, 1e-3) * MOVEMENT.walkSpeed);
      this.input.move.y = Math.min(this.input.move.y, Math.max(MIN_PACE, tight));
    }
  }

}
