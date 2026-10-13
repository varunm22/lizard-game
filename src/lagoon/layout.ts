import * as THREE from 'three';
import { ridgedNoise, smoothstep, valueNoise } from '../world/noise';
import { lavaRelief, WATER_Y } from '../world/shore';

/**
 * The mangrove lagoon (`?level=lagoon`), laid out like the sheltered lagoons behind the lava on
 * Isabela and Santa Cruz (Elizabeth Bay, Black Turtle Cove): a 12 m square of calm, shallow water
 * walled by red mangroves. The juvenile lizard comes in from the colony's lava coast on the west.
 * Ahead is a basin a few centimetres to a hand deep over mud and sand, with a pale sand bar, mud
 * hummocks where the mangroves stand on their stilt roots, lava knobs to bask on, and deeper pools
 * where the rays and shark pups cruise. Along the east side a tidal channel runs north to south,
 * too deep to wade and pulling south, cut along the foot of a lava flow: its far bank is a rock
 * face no swimmer can climb out onto. Over it lies the lava field, the way on. Lava herons stalk the
 * shallows. A driftwood log lies in a pool behind the channel's mangrove fringe; floated out into the
 * current, it jams across the channel's narrows and makes a bridge.
 */

/** Inside this (m, either way from the middle in x and z) animals and props keep off the walls. */
export const LAGOON_EDGE = 5.85;
const W = WATER_Y;

/** Where the lizard starts: on the lava coast, looking out north-east over the lagoon. */
export const START = { x: -4.85, z: -3.55, yaw: Math.PI / 4 };

/** The finish: the edge of the lava field across the channel; reached within `r` of its middle. */
export const FINISH = { x: 4.75, z: -0.9, r: 0.5 };

/**
 * The safe point: a nook among the roots of three old mangroves halfway across, where no heron
 * reaches. Once the lizard has reached it, a catch sends it back there rather than to the start.
 */
export const SAFE_POINTS = [{ x: -0.8, z: 0.5, r: 0.2, yaw: Math.PI / 2 }] as const;

/** The channel's middle line (x, m) at z, and its half-width there: narrowest at the jam. */
export function channelX(z: number): number {
  return 2.75 + 0.18 * Math.sin(0.45 * z + 0.5) + 0.06 * Math.sin(1.4 * z);
}
/** Where the channel narrows between a root snag and a lava knob: a log floating down jams here. */
export const JAM_Z = -0.45;
export function channelHalf(z: number): number {
  return 0.42 - 0.12 * smoothstep(0.7, 0, Math.abs(z - JAM_Z));
}
export const JAM = { x: channelX(JAM_Z), z: JAM_Z };

/** Height of the channel's west bank (mud) and the top of its east bank (the lava shelf's lip). */
export const BANK_TOP = W + 0.012;
export const SHELF_TOP = W + 0.065;
/** The channel's depth in the middle (m). */
const CHANNEL_DEPTH = 0.3;

/** How fast the ebb runs down the channel's middle (m/s), southward; faster through the narrows. */
export const CURRENT = 0.1;

/** Where (x, z) is across the channel: -1 at the west bank, 1 at the east, beyond either outside it. */
export function acrossChannel(x: number, z: number): number {
  return (x - channelX(z)) / channelHalf(z);
}

/** The current at (x, z) (m/s, as x and z into `out`): the channel's ebb south, and the log pool draining east down its creek. */
export function current(x: number, z: number, out: { x: number; z: number }) {
  const u = acrossChannel(x, z);
  out.x = 0;
  out.z = Math.abs(u) < 1 ? -CURRENT * (0.42 / channelHalf(z)) * (1 - u * u) : 0;
  if (u <= -1 && x > CREEK_FROM && Math.abs(z - CREEK.z) < CREEK.half + 0.05) out.x = CREEK_FLOW;
  return out;
}
/** The creek's outflow (m/s, east) from this far east (m) to the channel. */
const CREEK_FLOW = 0.035;
const CREEK_FROM = 1.65;

/** X of the colony's lava coast on the west side (m) at z: lava west of it, the lagoon east. */
export function westCoastX(z: number): number {
  return -4.35 + 0.3 * Math.sin(0.55 * z + 1) + 0.12 * Math.sin(1.5 * z - 0.3);
}

/** Deeper pools: where rays and shark pups cruise and a lizard can dive out of reach. `d` is depth. */
export const POOLS = [
  { x: -2.6, z: 1.9, r: 1.0, d: 0.22 },
  { x: 0.1, z: -2.9, r: 1.1, d: 0.2 },
  // The log's pool, behind the channel's fringe, joined to the channel by a creek.
  { x: 1.25, z: 3.05, r: 0.85, d: 0.22 },
  { x: -3.3, z: -4.5, r: 0.8, d: 0.18 },
  { x: -0.8, z: 4.4, r: 0.9, d: 0.2 },
] as const;
/** The creek from the log pool out through the fringe to the channel: along z = CREEK.z. */
export const CREEK = { z: 3.05, half: 0.2, depth: 0.16 };
export const LOG_POOL = POOLS[2];

/** Wading flats: ankle-deep water over firm sand, the herons' best hunting. */
const FLATS = [
  { x: -1.6, z: -0.6, r: 1.25 },
  { x: 1.15, z: -0.1, r: 1.1 },
  { x: -3.4, z: 3.6, r: 0.9 },
  { x: -2.0, z: -2.4, r: 0.8 },
];

/** The sand bar: a pale spit curving out from the coast toward the middle, its crest just dry. */
const BAR: [number, number][] = [[-4.5, -3.0], [-3.4, -1.75], [-2.4, -1.05], [-1.45, -0.95]];
const BAR_HALF = 0.24;

/** Black lava knobs standing out of the water: places to bask. */
export const ISLETS = [
  { x: -1.75, z: 2.95, r: 0.28 },
  { x: 0.35, z: 1.6, r: 0.24 },
  { x: -3.05, z: -3.35, r: 0.3 },
  { x: 0.95, z: -1.95, r: 0.22 },
  { x: -4.0, z: 1.9, r: 0.22 },
] as const;

/**
 * The mangrove stands: each a mud hummock (`r`) with red mangroves on it at `trees` (offsets from
 * its middle, m). The safe point's three trees stand round it with gaps between their root cages.
 */
export interface Stand {
  x: number;
  z: number;
  r: number;
  trees: [number, number][];
}
const ring3 = (r: number, a0: number): [number, number][] => [0, 1, 2].map((k) => [Math.sin(a0 + (k * 2 * Math.PI) / 3) * r, Math.cos(a0 + (k * 2 * Math.PI) / 3) * r]);
export const STANDS: Stand[] = [
  { x: SAFE_POINTS[0].x, z: SAFE_POINTS[0].z, r: 0.95, trees: ring3(0.6, 0.35) },
  { x: -3.75, z: 0.55, r: 0.85, trees: [[-0.3, -0.25], [0.35, 0.05], [-0.15, 0.45], [0.25, -0.5]] },
  { x: -2.05, z: 3.75, r: 0.7, trees: [[-0.2, 0.0], [0.35, 0.25]] },
  { x: 0.45, z: -1.05, r: 0.6, trees: [[0.0, 0.1], [-0.4, -0.2]] },
  { x: -2.4, z: -3.75, r: 0.8, trees: [[-0.3, 0.0], [0.25, 0.3], [0.35, -0.35]] },
  { x: 0.55, z: 4.55, r: 0.7, trees: [[-0.25, -0.1], [0.3, 0.2]] },
  { x: -1.05, z: -4.6, r: 0.6, trees: [[0.0, 0.0], [0.45, 0.25]] },
  { x: -4.6, z: 4.4, r: 0.7, trees: [[0.0, 0.0], [0.4, -0.3]] },
];

/** The channel's west bank fringe: mangroves every so often along it, but for the creek and the landing at the jam. */
export const FRINGE: { x: number; z: number }[] = (() => {
  const out: { x: number; z: number }[] = [];
  for (let z = -5.6; z <= 5.6; z += 0.58) {
    if (Math.abs(z - CREEK.z) < 0.8 || Math.abs(z - JAM_Z) < 0.55) continue;
    const zz = z + 0.08 * Math.sin(z * 7.3);
    out.push({ x: channelX(zz) - channelHalf(zz) - 0.18 + 0.05 * Math.sin(zz * 3.1), z: zz });
  }
  return out;
})();
/** How wide the mud strip along the channel's west bank is (m), and wider at the landing by the jam. */
const FRINGE_MUD = 0.45;

/** Distance from (x, z) to the segment a-b. */
function toSegment(x: number, z: number, a: [number, number], b: [number, number]) {
  const ex = b[0] - a[0];
  const ez = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez)));
  return Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t);
}

/** How far (x, z) is from the sand bar's crest line. */
function barDistance(x: number, z: number): number {
  let d = Infinity;
  for (let i = 0; i + 1 < BAR.length; i++) d = Math.min(d, toSegment(x, z, BAR[i], BAR[i + 1]));
  return d;
}

/** Bare lava at (x, z), 0 to 1: the west coast, the knobs and the field east of the channel. */
export function lagoonLava(x: number, z: number): number {
  const ragged = valueNoise(x / 0.2 + 5, z / 0.2 - 2, 61) * 0.06;
  let lava = smoothstep(0.02, -0.06, x - westCoastX(z) + ragged);
  for (const k of ISLETS) lava = Math.max(lava, smoothstep(0.02, -0.04, Math.hypot(x - k.x, z - k.z) - k.r + ragged));
  lava = Math.max(lava, smoothstep(0.97, 1.02, acrossChannel(x, z)));
  return lava;
}

/** Height of the lava field east of the channel, rising gently to the east, ropy and lumpy. */
function fieldHeight(x: number, z: number): number {
  const e = x - channelX(z) - channelHalf(z);
  const tumuli = 0.03 * smoothstep(0.35, 0.8, valueNoise(x / 0.9 + 3, z / 0.9 + 1, 62));
  return SHELF_TOP + 0.08 * smoothstep(0, 3.2, e) + lavaRelief(x, z, 0.016) + tumuli * smoothstep(0.3, 1.0, e);
}

/** The lagoon floor and its banks west of the channel (and everywhere the channel isn't). */
function basinHeight(x: number, z: number): number {
  // The open floor: mud and sand a few centimetres to a hand deep.
  const n = 0.5 + 0.5 * valueNoise(x / 1.6 + 7, z / 1.6 - 3, 63);
  let h = W - (0.035 + 0.05 * n) + valueNoise(x / 0.3, z / 0.3, 64) * 0.004;
  for (const f of FLATS) h += (W - 0.016 - h) * smoothstep(f.r, f.r * 0.45, Math.hypot(x - f.x, z - f.z));
  for (const p of POOLS) h += (W - p.d - h) * smoothstep(p.r, p.r * 0.35, Math.hypot(x - p.x, z - p.z));
  // The sand bar, its crest a couple of centimetres out of the water.
  const bar = smoothstep(BAR_HALF, BAR_HALF * 0.25, barDistance(x, z));
  h = Math.max(h, h + (W + 0.022 - h) * bar);
  // Mud hummocks under the mangroves, just awash at their edges.
  for (const s of STANDS) {
    const d = Math.hypot(x - s.x, z - s.z);
    if (d < s.r) h = Math.max(h, h + (W + 0.011 + 0.004 * valueNoise(x / 0.15, z / 0.15, 65) - h) * smoothstep(s.r, s.r * 0.5, d));
  }
  // The mud strip along the channel's west bank, under the fringe; wider at the landing by the jam.
  const toBank = channelX(z) - channelHalf(z) - x;
  const wide = FRINGE_MUD + 0.5 * smoothstep(0.75, 0.2, Math.abs(z - JAM_Z));
  if (toBank > -0.05 && toBank < wide + 0.3) h = Math.max(h, h + (BANK_TOP - h) * smoothstep(wide + 0.3, wide, toBank));
  // The creek from the log pool through the fringe.
  if (x > LOG_POOL.x && Math.abs(z - CREEK.z) < CREEK.half + 0.1) {
    h = Math.min(h, W - CREEK.depth + (CREEK.depth + 0.02) * smoothstep(CREEK.half - 0.06, CREEK.half + 0.1, Math.abs(z - CREEK.z)));
  }
  // The edges north and south: mud under the mangrove forest.
  const edge = smoothstep(5.0, 5.7, Math.abs(z));
  if (edge > 0) h = Math.max(h, h + (W + 0.012 - h) * edge);
  // Lava: the west coast and the knobs, rough, a few centimetres proud of the water.
  const lava = lagoonLava(x, z);
  if (lava > 0) {
    const inland = Math.max(0, westCoastX(z) - x);
    const coast = W + 0.035 + 0.11 * smoothstep(0, 1.6, inland) + lavaRelief(x, z, 0.02);
    let top = coast;
    for (const k of ISLETS) {
      const d = Math.hypot(x - k.x, z - k.z);
      if (d < k.r + 0.05) top = Math.max(top, W + 0.03 + 0.03 * smoothstep(k.r, 0, d) + lavaRelief(x, z, 0.018));
    }
    h = h + (Math.max(h, top) - h) * lava;
  }
  return h;
}

/** Ground height (m) of the mangrove lagoon at (x, z). */
export function lagoonHeight(x: number, z: number): number {
  const u = acrossChannel(x, z);
  if (u >= 1) return fieldHeight(x, z);
  const basin = basinHeight(x, z);
  if (u < -1.6) return basin;
  // The channel: a steep mud bank on the west, a deep scoured middle, and the lava face on the east.
  const deep = W - CHANNEL_DEPTH + 0.02 * valueNoise(x / 0.2, z / 0.2, 66);
  if (u > 0.9) return deep + (fieldHeight(x, z) - deep) * smoothstep(0.9, 1.0, u);
  const bank = Math.min(basin, BANK_TOP);
  if (u < -1) return basin;
  return bank + (deep - bank) * smoothstep(-1, -0.55, u);
}

/** Water depth at (x, z) over the ground (m), or negative where the ground is above the water. */
export function depthAt(x: number, z: number): number {
  return W - lagoonHeight(x, z);
}

const MUD = new THREE.Color(0x4f4232);
const MUD_WET = new THREE.Color(0x3a3025);
const LITTER = new THREE.Color(0x5a4a2c);
const SAND = new THREE.Color(0xd2c29a);
const SAND_WET = new THREE.Color(0xae9e7a);
const BED_SAND = new THREE.Color(0x9c8c68);
const BED_MUD = new THREE.Color(0x5f523c);
const BED_FILM = new THREE.Color(0x6b7440);
const LAVA = new THREE.Color(0x353130);
const LAVA_CREST = new THREE.Color(0x544c46);
const LAVA_WET = new THREE.Color(0x222020);
const tmp = new THREE.Color();
const tmp2 = new THREE.Color();

/** Colour of the lagoon's ground at (x, z), height y, into `c`. */
export function lagoonColour(x: number, z: number, y: number, c: THREE.Color) {
  const under = W - y;
  const sandy = smoothstep(0.1, 0.5, valueNoise(x / 0.7 + 2, z / 0.7 - 5, 67) * 0.5 + 0.5) * 0.6 + smoothstep(BAR_HALF * 1.6, 0, barDistance(x, z));
  // Under water: sand and mud with a green film of algae in the shallows; darker in the deep.
  c.copy(BED_MUD).lerp(BED_SAND, Math.min(1, sandy));
  c.lerp(BED_FILM, 0.45 * smoothstep(0.08, 0.02, under) * smoothstep(-0.2, 0.5, valueNoise(x / 0.25, z / 0.25, 68)));
  c.multiplyScalar(1 - 0.35 * smoothstep(0.1, 0.3, under));
  // Out of the water: mud littered with mangrove leaves, or the bar's pale sand, wet at the waterline.
  const dry = smoothstep(-0.002, -0.008, under);
  if (dry > 0) {
    const wet = smoothstep(-0.012, -0.003, under);
    tmp.copy(MUD).lerp(LITTER, 0.5 * smoothstep(0.2, 0.7, valueNoise(x / 0.12, z / 0.12, 69))).lerp(MUD_WET, wet);
    const bar = smoothstep(BAR_HALF, BAR_HALF * 0.4, barDistance(x, z));
    tmp.lerp(tmp2.copy(SAND).lerp(SAND_WET, wet), bar);
    c.lerp(tmp, dry);
  }
  const lava = lagoonLava(x, z);
  if (lava > 0) {
    const crest = smoothstep(0.7, 0.95, ridgedNoise(x / 0.22 + 3, z / 0.22 - 8, 11));
    const pit = smoothstep(0.35, 0.8, valueNoise(x / 0.06 + 9, z / 0.06 - 2, 33));
    const wet = smoothstep(0.01, -0.005, y - W);
    tmp.copy(LAVA).lerp(LAVA_CREST, crest).lerp(LAVA_WET, Math.max(wet, 0.6 * pit));
    c.lerp(tmp, lava);
  }
}

/** Whether (x, z) is in the channel's water (between its banks). */
export function inChannel(x: number, z: number): boolean {
  return Math.abs(acrossChannel(x, z)) < 1;
}

/**
 * Where the herons hunt: a few standing spots each, in ankle-deep water or on a bank, that it
 * moves between now and then. 0 watches the sand bar, 1 the flats by the safe point, 2 the log's
 * pool, the channel bank and the landing at the jam.
 */
export const HERON_HAUNTS: readonly (readonly { x: number; z: number; yaw: number }[])[] = [
  [{ x: -3.05, z: -1.15, yaw: 2.6 }, { x: -2.25, z: -1.35, yaw: -0.4 }, { x: -3.85, z: -2.05, yaw: 0.9 }],
  [{ x: -1.55, z: -0.25, yaw: 1.2 }, { x: 0.25, z: -0.2, yaw: -1.8 }, { x: -1.25, z: 1.2, yaw: 2.2 }],
  [{ x: 1.85, z: 3.35, yaw: -1.9 }, { x: 1.8, z: 0.25, yaw: -1.6 }, { x: 1.3, z: -0.75, yaw: 1.3 }],
];
