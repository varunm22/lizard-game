import * as THREE from 'three';
import { ridgedNoise, smoothstep, valueNoise } from '../world/noise';
import { lavaRelief, WATER_Y } from '../world/shore';

/**
 * The sea lion beach (`?level=beach`), the last stage: the outer islet seen from the lava tunnels'
 * cove, laid out like the beaches of Española (Gardner Bay, Punta Suárez): a 12 m square with a
 * white coral-sand beach between black lava, sea lions hauled out along it, and behind it a low
 * lava field where the adult males hold their display rocks in the breeding season. The lizard,
 * grown now and in its red-and-turquoise breeding colours, comes in from the sea to the north.
 *
 * North to south: open sea, a lava reef awash where the lizard starts; the beach, its waterline
 * patrolled by a sea lion bull, the cows and pups lying above it; the lek on the lava field behind,
 * with three display rocks; the females basking at its back. West, a rocky lava shore; east, a lava
 * point running out into the sea, with tide pools, where the penguins and flightless cormorants stand.
 */

/** Inside this (m, either way from the middle in x and z) animals and props keep off the walls. */
export const BEACH_EDGE = 5.8;
const W = WATER_Y;

/** Where the lizard starts: on a lava reef just awash off the beach, looking south at the islet. */
export const START = { x: -2.6, z: -4.55, yaw: 0.1, r: 0.33 };

/** z of the waterline (m) at x along the beach: a gentle curve with a few slow bends. */
export function shoreZ(x: number): number {
  return -2.45 + 0.22 * Math.sin(0.55 * x + 1.1) + 0.08 * Math.sin(1.7 * x - 0.4);
}

/** x of the lava point's west edge (m) at z: it runs north into the sea, ending at z = POINT_TIP. */
export function pointX(z: number): number {
  return 2.55 + 0.18 * Math.sin(1.3 * z + 0.4) + 0.08 * Math.sin(3.1 * z);
}
export const POINT_TIP = -4.7;
/** x of the rocky west shore's edge (m) at z: lava west of it. */
export function westX(z: number): number {
  return -4.25 + 0.2 * Math.sin(0.9 * z - 0.5) + 0.08 * Math.sin(2.3 * z + 1);
}
/** z where the lava field begins behind the beach (m) at x. */
export function fieldZ(x: number): number {
  return 0.25 + 0.2 * Math.sin(0.8 * x + 2.0) + 0.07 * Math.sin(2.6 * x);
}

/**
 * The display rocks: low lava outcrops on the field, each held by a rival male at the start. `r`
 * is the top's radius (m) and `top` its height above the field; the controller climbs 7.5 cm, so
 * they're low enough to climb straight onto. 0 is a young male's, 1 a big old male's, 2 a seasoned one's.
 */
export const DISPLAY_ROCKS = [
  { x: -1.75, z: 1.55, r: 0.19, top: 0.05, yaw: 0.4 },
  { x: 0.55, z: 2.25, r: 0.22, top: 0.055, yaw: 2.1 },
  { x: 2.55, z: 1.35, r: 0.18, top: 0.05, yaw: -0.9 },
] as const;
/** Where a beaten rival goes to sulk, one per rock: out on the edge of the field. */
export const SULK_SPOTS = [
  { x: -3.3, z: 2.6 },
  { x: 1.2, z: 4.1 },
  { x: 4.2, z: 2.6 },
] as const;
/** Where the females bask together at the back of the field. */
export const FEMALE_SPOTS = [
  { x: -0.55, z: 3.75, yaw: 1.4 },
  { x: -0.15, z: 3.95, yaw: 1.2 },
  { x: 0.3, z: 3.7, yaw: 1.7 },
] as const;

/** The bull's beat: he swims to and fro along the beach this far off the waterline (m), where it's deep enough to dive and play (about 17 cm), between these x. */
export const BULL_BEAT = { x0: -3.8, x1: 2.0, off: 1.2 };
/** His stretch of shore: the beach within this far above the waterline, between the beat's ends. */
export const BULL_STRETCH = 1.5;

/** The cows' and pups' places on the beach above the bull's beat: where each lies and which way. */
export const COWS = [
  { x: -3.1, z: -1.2, yaw: 2.2, lift: 0 },
  { x: -2.0, z: -0.65, yaw: -2.6, lift: 1 },
  { x: -0.45, z: -1.05, yaw: 1.3, lift: 0 },
  { x: 0.75, z: -0.4, yaw: -1.9, lift: 0.4 },
  { x: 1.7, z: -1.3, yaw: 2.8, lift: 0 },
] as const;
export const PUPS = [
  { x: -2.35, z: -1.05, yaw: 0.6, mother: 1 },
  { x: -0.05, z: -0.6, yaw: -2.2, mother: 2 },
  { x: 1.3, z: -0.85, yaw: 1.9, mother: 4 },
] as const;

/** Where the penguins stand on the point, and the loops the swimmers follow off it, in open water clear of the point's lava (tests/beach.spec.ts checks). */
export const PENGUIN_ROCKS = [
  { x: 3.25, z: -3.9, yaw: -2.6 },
  { x: 3.55, z: -3.45, yaw: -1.9 },
] as const;
export const SWIM_LOOPS = [
  { x: 1.45, z: -4.2, rx: 1.05, rz: 0.55 },
  { x: 0.0, z: -3.75, rx: 2.1, rz: 0.45 },
] as const;
/** The cormorants' rocks on the point: one dries its wings, the other comes and goes from the sea. */
export const CORMORANT_ROCKS = [
  { x: 3.0, z: -3.05, yaw: -2.3 },
  { x: 2.85, z: -4.25, yaw: -3.0 },
] as const;

/** Tide pools in the lava of the point and the west shore: (x, z, r, depth). */
export const TIDE_POOLS = [
  { x: 3.6, z: -2.6, r: 0.22, d: 0.05 },
  { x: 3.15, z: -2.0, r: 0.16, d: 0.04 },
  { x: -4.7, z: -1.4, r: 0.2, d: 0.05 },
] as const;

/** Reef lava in the sea: the start reef, just awash, and a few knobs further out under the water. */
const REEFS = [
  { x: START.x, z: START.z, r: 0.4, top: W + 0.018 },
  { x: -0.9, z: -5.1, r: 0.35, top: W - 0.09 },
  { x: 0.9, z: -3.6, r: 0.25, top: W - 0.11 },
] as const;

/** How far below the surface the open sea floor lies (m). */
const SEA_FLOOR = 0.34;

/** Bare black lava at (x, z), 0 to 1: the west shore, the point, the field and the reefs. */
export function beachLava(x: number, z: number): number {
  const ragged = valueNoise(x / 0.2 + 5, z / 0.2 - 2, 71) * 0.07;
  const west = smoothstep(0.03, -0.05, x - westX(z) + ragged);
  const point = smoothstep(-0.03, 0.05, x - pointX(z) + ragged) * smoothstep(POINT_TIP - 0.05, POINT_TIP + 0.15, z + ragged * 0.5);
  const field = smoothstep(-0.05, 0.08, z - fieldZ(x) + ragged);
  let lava = Math.max(west, point, field);
  for (const r of REEFS) lava = Math.max(lava, smoothstep(0.03, -0.04, Math.hypot(x - r.x, z - r.z) - r.r + ragged));
  return lava;
}

/** Sand under and above the water: the beach, and the sea floor off it. */
function sandHeight(x: number, z: number): number {
  const s = z - shoreZ(x);
  const ripples = valueNoise(x / 0.35, z / 0.35, 72) * 0.004;
  if (s > 0) {
    // The beach rises from the waterline in a gentle berm, then levels off toward the field.
    const rise = 0.075 * Math.pow(Math.min(s, 2.6) / 2.6, 0.75) + 0.012 * smoothstep(0.4, 1.2, s) * valueNoise(x / 0.9, z / 0.9, 73);
    return W + 0.004 + rise + ripples;
  }
  const out = -s;
  return W - 0.035 * smoothstep(0, 0.35, out) - (SEA_FLOOR - 0.035) * smoothstep(0.5, 2.0, out) + ripples + 0.02 * valueNoise(x / 0.8 + 3, z / 0.8, 74) * smoothstep(1, 2, out);
}

/** The lava's own surface: low and ragged on the shores and the point, rising across the field. */
function lavaHeight(x: number, z: number): number {
  const relief = lavaRelief(x, z, 0.02);
  const tumuli = 0.025 * smoothstep(0.35, 0.8, valueNoise(x / 0.8 + 3, z / 0.8 + 1, 75));
  // The field: from the top of the beach it climbs gently south, a few low tumuli on it.
  const inField = z - fieldZ(x);
  const field = W + 0.085 + 0.02 * smoothstep(0, 0.3, inField) + 0.07 * smoothstep(0.3, 4.2, inField) + tumuli * smoothstep(0.3, 1, inField);
  // The shores: a low ledge a few centimetres proud of the water, dropping off steeply into it.
  const shore = W + 0.03 + relief + 0.03 * smoothstep(0.3, 0.8, valueNoise(x / 0.5 - 2, z / 0.5 + 6, 76));
  return Math.max(field + relief, shore);
}

/** How far from the water's edge of lava at (x, z) is (m, rough): where the ledge drops away. */
function intoLava(x: number, z: number): number {
  const west = westX(z) - x;
  const point = Math.min(x - pointX(z), z - POINT_TIP);
  return Math.max(west, point);
}

/** Ground height (m) of the sea lion beach at (x, z). */
export function beachHeight(x: number, z: number): number {
  let h = sandHeight(x, z);
  const lava = beachLava(x, z);
  if (lava > 0) {
    let top = lavaHeight(x, z);
    // Off the shore ledges the lava drops steeply into the sea, onto a rough rocky bottom.
    const into = intoLava(x, z);
    if (z < fieldZ(x) && into < 0.6) {
      const ledge = smoothstep(-0.02, 0.12, into);
      const bed = W - 0.08 - (SEA_FLOOR - 0.1) * smoothstep(0, -1.2, into) + lavaRelief(x, z, 0.05);
      top = bed + (top - bed) * ledge;
    }
    for (const r of REEFS) {
      const d = Math.hypot(x - r.x, z - r.z);
      if (d < r.r + 0.1) top = Math.max(top, r.top + lavaRelief(x, z, 0.012) - 0.06 * smoothstep(r.r - 0.08, r.r + 0.1, d));
    }
    h = h + (Math.max(h, top) - h) * lava;
  }
  for (const p of TIDE_POOLS) {
    const d = Math.hypot(x - p.x, z - p.z);
    if (d < p.r) h = Math.min(h, h + (W - p.d - h) * smoothstep(p.r, p.r * 0.5, d));
  }
  // The south edge: a bank rising out of the fog behind the females.
  const bank = Math.max(0, z - 4.7);
  h += 0.25 * bank * bank + 0.2 * bank;
  return h;
}

/** Water depth at (x, z) over the ground (m), or negative where the ground is above the water. */
export function depthAt(x: number, z: number): number {
  return W - beachHeight(x, z);
}

/** Whether (x, z) is on the bull's stretch: the beach between his beat's ends, from the shallows to `BULL_STRETCH` up the sand. */
export function onBullStretch(x: number, z: number): boolean {
  const s = z - shoreZ(x);
  return x > BULL_BEAT.x0 - 0.3 && x < BULL_BEAT.x1 + 0.3 && s > -0.9 && s < BULL_STRETCH && beachLava(x, z) < 0.5;
}

const SAND = new THREE.Color(0xf1e9d6);
const SAND_SHADE = new THREE.Color(0xe2d6bb);
const WET_SAND = new THREE.Color(0xcabda0);
const BED_SAND = new THREE.Color(0xd9ceb1);
const LAVA = new THREE.Color(0x2a2827);
const LAVA_CREST = new THREE.Color(0x575049);
const LAVA_WET = new THREE.Color(0x1f1d1d);
const LAVA_DUST = new THREE.Color(0x5a5450);
const GUANO = new THREE.Color(0xd8d5cc);
const tmp = new THREE.Color();

/** Colour of the beach's ground at (x, z), height y, into `c`. */
export function beachColour(x: number, z: number, y: number, c: THREE.Color) {
  // White coral sand, faintly patchy, darker where the waves wet it and on the sea floor.
  c.copy(SAND).lerp(SAND_SHADE, smoothstep(0.1, 0.6, valueNoise(x / 0.6 + 1, z / 0.6 - 4, 77)) * 0.7);
  const wet = smoothstep(W + 0.012, W + 0.002, y);
  c.lerp(WET_SAND, wet);
  if (y < W) c.lerp(BED_SAND, smoothstep(W, W - 0.05, y));
  const lava = beachLava(x, z);
  if (lava > 0) {
    // Ropy crests weathered lighter, pits and the wet edge darker; the field dusty, and splashed
    // white where the birds stand on the point.
    const crest = smoothstep(0.7, 0.95, ridgedNoise(x / 0.22 + 3, z / 0.22 - 8, 11));
    const pit = smoothstep(0.35, 0.8, valueNoise(x / 0.06 + 9, z / 0.06 - 2, 33));
    const wetLava = smoothstep(0.012, -0.004, y - W);
    tmp.copy(LAVA).lerp(LAVA_CREST, crest).lerp(LAVA_WET, Math.max(wetLava, 0.6 * pit));
    const dust = smoothstep(0, 1.5, z - fieldZ(x)) * smoothstep(0.1, 0.7, valueNoise(x / 0.4 + 2, z / 0.4, 78));
    tmp.lerp(LAVA_DUST, dust * 0.25);
    const guano = smoothstep(0.55, 0.8, valueNoise(x / 0.05 + 8, z / 0.05 - 1, 79)) * smoothstep(2.4, 3.1, x) * smoothstep(-1.6, -2.6, z);
    tmp.lerp(GUANO, guano * 0.3 * (1 - wetLava));
    c.lerp(tmp, lava);
  }
}
