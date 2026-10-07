import { wrapAngle } from '../math/angles';
/**
 * Fits the lizard's spine to the surface under it, in the side-on plane of its body.
 *
 * Coordinates are (s, y): s along the lizard's facing from the physics body's centre (+ toward the
 * snout), y up from the physics body's feet height. The physics capsule is straight and keeps a skin
 * gap, so on its own the drawn lizard hovers a couple of millimetres up on flat ground and much more
 * where the capsule rests across a curve like a log. The fit instead puts the hind feet on the
 * surface, pitches the hips to match, then bends the chest so the front feet land too, and the
 * neck, head and tail follow the surface from there. Each joint stays clear of the surface below it
 * (the belly can rest on it, not sink into it), and no joint bends further than its limit.
 *
 * Angles are pitches in this plane: positive tips a bone so its forward end rises. Every angle is
 * absolute (relative to level); the caller turns them into per-bone rotations.
 */

export interface Point {
  s: number;
  y: number;
}

/** Rest positions (model space, feet at y = 0) of the joints the fit moves, from the lizard rig. */
export interface SpineRig {
  /** Joints from the hips forward: hips (where the tail joins), chest, neck, head, snout tip. */
  hips: Point;
  chest: Point;
  neck: Point;
  head: Point;
  snout: Point;
  /** Tail joints from the hips back to the tip: tail1 start is `hips`, then tail2..tail4 starts, tip. */
  tail: Point[];
  /** Where the hind and front feet stand (y = 0). */
  hindFoot: Point;
  frontFoot: Point;
}

export interface SpineFit {
  /** Height of the model's origin above the physics feet height. */
  rootY: number;
  /** Absolute pitch of the hips (and so of the whole model), and of each bone after it. */
  hips: number;
  chest: number;
  neck: number;
  head: number;
  /** Absolute pitch of tail1..tail4 (positive: the end nearer the body is higher). */
  tail: number[];
}

/** How far a foot will reach down below the physics body's feet before it gives up and hangs. */
const FOOT_REACH = 0.03;
/** How far a foot over a drop hangs below the surface under the body's centre. */
const HANG_BELOW_CENTRE = 0.012;
/**
 * How far above the hind feet the front feet can get (scrabbling at a face) before the hind feet
 * leave the ground, as a fraction of the distance between them.
 */
const MAX_TRUNK_RISE = 0.875;
/** How far the tail may hang below the physics feet height. */
const TAIL_REACH = 0.08;
/** Steepest the hips pitch to follow the ground. */
const MAX_HIPS = 0.7;
/** Largest bend at each joint relative to its parent. */
const MAX_TRUNK_BEND = 0.6;
const MAX_NECK_BEND = 0.45;
const MAX_TAIL_BEND = 0.45;
/** A joint's clearance over the surface below it, as a fraction of its rest height (the belly is ~20% below the spine). */
const CLEARANCE = 0.8;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const rot = (v: Point, a: number): Point => ({
  s: v.s * Math.cos(a) - v.y * Math.sin(a),
  y: v.s * Math.sin(a) + v.y * Math.cos(a),
});
const add = (a: Point, b: Point): Point => ({ s: a.s + b.s, y: a.y + b.y });
const sub = (a: Point, b: Point): Point => ({ s: a.s - b.s, y: a.y - b.y });

/**
 * The pitch nearest `near` that turns `v` (hanging off a pivot at height `fromY`) so its far end sits
 * at `toY`. When it can't reach, the nearest it can get.
 */
function aim(v: Point, fromY: number, toY: number, near: number): number {
  const r = Math.hypot(v.s, v.y);
  const phi = Math.atan2(v.y, v.s);
  const x = Math.asin(clamp((toY - fromY) / r, -1, 1));
  const a1 = wrapAngle(x - phi);
  const a2 = wrapAngle(Math.PI - x - phi);
  return Math.abs(wrapAngle(a1 - near)) <= Math.abs(wrapAngle(a2 - near)) ? a1 : a2;
}

/**
 * @param surface Surface height under the body at `s`, relative to the physics feet height.
 * @param hindSlope Pitch of the ground under the hind feet (from its normal).
 */
export function fitSpine(rig: SpineRig, surface: (s: number) => number, hindSlope: number): SpineFit {
  // Feet hang at most a little below whatever holds the body up under its centre (the top of a rock
  // or log), and never more than FOOT_REACH below the physics body.
  const hang = Math.max(-FOOT_REACH, Math.min(0, surface(0)) - HANG_BELOW_CENTRE);
  const reach = (s: number) => Math.max(surface(s), hang);
  /** Lowest a joint at rest height `restY` may sit with its far end at `p`. */
  const floor = (p: Point, restY: number) => surface(p.s) + restY * CLEARANCE;

  // Hips: hind feet on the surface, pitched to the ground under them. With the hind feet hanging
  // (nothing within reach), start level and let the chest's clearance tip them.
  // Climbing onto something tall, the hind feet leave the ground once the front feet couldn't reach.
  const hindY = Math.max(reach(rig.hindFoot.s), reach(rig.frontFoot.s) - MAX_TRUNK_RISE * (rig.frontFoot.s - rig.hindFoot.s));
  let hips = hindY === surface(rig.hindFoot.s) ? clamp(hindSlope, -MAX_HIPS, MAX_HIPS) : 0;
  let rootY = 0;
  let chestAt: Point = rig.chest;
  const placeHips = () => {
    rootY = hindY - rot(rig.hindFoot, hips).y;
    chestAt = add({ s: 0, y: rootY }, rot(rig.chest, hips));
  };
  placeHips();
  // Keep the chest joint off the surface by tipping up about the hind feet (draping over a rim).
  const lift = floor(chestAt, rig.chest.y) - chestAt.y;
  if (lift > 0) {
    hips = clamp(hips + Math.atan2(lift, rig.chest.s - rig.hindFoot.s), -MAX_HIPS, MAX_HIPS);
    placeHips();
  }

  // Chest: bend so the front feet reach the surface, but keep the neck joint clear of it.
  const chestOf = (h: number) => {
    let c = aim(sub(rig.frontFoot, rig.chest), chestAt.y, reach(rig.frontFoot.s), h);
    const v = sub(rig.neck, rig.chest);
    const neckAt = add(chestAt, rot(v, c));
    const up = floor(neckAt, rig.neck.y) - neckAt.y;
    if (up > 0) c += Math.atan2(up, v.s);
    return c;
  };
  let chest = chestOf(hips);
  // Too sharp a bend (front feet high on a log, hind feet on the ground): the hips take up the rest.
  const excess = chest - hips - clamp(chest - hips, -MAX_TRUNK_BEND, MAX_TRUNK_BEND);
  if (excess !== 0) {
    hips = clamp(hips + excess, -MAX_HIPS, MAX_HIPS);
    placeHips();
    chest = chestOf(hips);
  }
  chest = hips + clamp(chest - hips, -MAX_TRUNK_BEND, MAX_TRUNK_BEND);

  // Neck and head follow the surface ahead at their rest height, without dipping into it.
  const neckAt = add(chestAt, rot(sub(rig.neck, rig.chest), chest));
  const u = sub(rig.head, rig.neck);
  const headEnd = (a: number) => add(neckAt, rot(u, a));
  let neck = aim(u, neckAt.y, reach(neckAt.s + u.s) + rig.head.y, chest);
  neck = chest + clamp(neck - chest, -MAX_NECK_BEND, MAX_NECK_BEND);
  const headAt = headEnd(neck);
  const w = sub(rig.snout, rig.head);
  let head = aim(w, headAt.y, Math.max(reach(headAt.s + w.s) + rig.snout.y, floor(add(headAt, w), rig.snout.y)), neck);
  head = neck + clamp(head - neck, -MAX_NECK_BEND, MAX_NECK_BEND);

  // Tail: each bone lies back along the surface at its rest height, hanging further than the feet can.
  const tail: number[] = [];
  let parent = hips;
  let at = add({ s: 0, y: rootY }, rot(rig.hips, hips));
  for (let i = 0; i + 1 < rig.tail.length; i++) {
    const v = sub(rig.tail[i + 1], rig.tail[i]);
    const end = add(at, rot(v, parent));
    const target = Math.max(surface(end.s), -TAIL_REACH) + rig.tail[i + 1].y;
    let a = aim(v, at.y, target, parent);
    a = parent + clamp(a - parent, -MAX_TAIL_BEND, MAX_TAIL_BEND);
    tail.push(a);
    at = add(at, rot(v, a));
    parent = a;
  }

  return { rootY, hips, chest, neck, head, tail };
}
