import * as THREE from 'three';
import { ridgedNoise, rng, smoothstep, valueNoise } from '../world/noise';
import { lavaRelief, SEA_DEPTH, WATER_Y } from '../world/shore';

/**
 * The nesting dunes (`?level=dunes`), laid out like the hatching grounds on Fernandina, a 14 m
 * square crossed west to east in four stretches: a flat of pale sand pocked with nest burrows,
 * where the lizard hatches; a first belt of dunes, their crests running SW-NE across the trade
 * wind, broken into separate dunes with gaps between; a field of black lava tongues and knolls with
 * sand between, where most of the racer snakes lie up; and a second belt of dunes behind the beach,
 * then the black lava shore with a sandy cove, where the adult colony basks. Two safe points, rock
 * crevices at the foot of a knoll, split the crossing. The sea lies to the east as on the island,
 * so the water, its swells and swimming work the same.
 */

/** Inside this (m, either way from the middle in x and z) the dunes' animals and props keep off the walls. */
export const DUNES_EDGE = 6.85;

/** X of the waterline (m) at a given z: a few slow bends. */
export function duneShoreX(z: number): number {
  return 5.6 + 0.3 * Math.sin(0.5 * z + 1.0) + 0.1 * Math.sin(1.7 * z - 0.4);
}

/** How much the coast at z is the sandy cove rather than lava (0 lava, 1 sand): z 1.4 to 3. */
export function cove(z: number): number {
  return smoothstep(1.15, 1.6, z) * smoothstep(3.3, 2.85, z);
}

/**
 * Burrows: each a tunnel mouth slanting down into the sand along `yaw` (the way (sin yaw, cos yaw)
 * points into it), with the spoil the female dug out heaped in front. `size` scales both.
 */
export interface Burrow {
  x: number;
  z: number;
  yaw: number;
  size: number;
}

/**
 * The lizard's own burrow, where it hatches: its tunnel runs west into the sand, so it comes out
 * facing east, toward the sea it can't yet see.
 */
const NEST_BURROW: Burrow = { x: -6.2, z: 0.4, yaw: -Math.PI / 2, size: 1 };

/** Where the lizard starts: just inside its burrow's mouth, facing out. */
export const NEST = { x: NEST_BURROW.x + 0.035, z: NEST_BURROW.z, yaw: Math.PI / 2 };

/**
 * The finish: a patch of the lava shore where the adult colony basks, just above the waves. The run
 * is over once the lizard's feet are within `r` of its middle, at the edge of the adults lying there.
 */
export const COLONY = { x: duneShoreX(-0.6) - 0.45, z: -0.6, r: 0.6 };

/**
 * The safe points: a crevice at the foot of a lava knoll, part way across. Within `r` the lizard is
 * out of every snake's reach, and once it has reached one, a catch sends it back there rather than
 * to the nest. `yaw` is the way out of it, toward the next stretch.
 */
export const SAFE_POINTS = [
  { x: -1.86, z: 0.12, r: 0.2, yaw: Math.PI / 2 },
  { x: 1.48, z: -0.34, r: 0.2, yaw: Math.PI / 2 },
] as const;

/** Where the trade wind blows the sand: from the south-east toward the north-west (unit, x and z). */
export const WIND = { x: -0.86, z: -0.51 };

/** The black lava flows: tongues running in from the shore, as points along each with its half-width there (m). */
const FLOWS: { pts: [number, number][]; w: number[] }[] = [
  // The lava field in the middle: tongues reaching in from the north and the south.
  { pts: [[-0.5, 7.4], [-0.1, 5.2], [-0.8, 3.4], [-0.3, 1.9]], w: [0.75, 0.6, 0.45, 0.22] },
  { pts: [[0.5, -7.4], [0.95, -5.1], [0.2, -3.1], [0.75, -1.9]], w: [0.75, 0.6, 0.45, 0.22] },
  // From the shore, north and south of the colony.
  { pts: [[7.4, 5.0], [5.0, 4.5], [3.6, 5.1], [2.4, 4.6]], w: [0.95, 0.7, 0.5, 0.25] },
  { pts: [[7.4, -4.6], [4.8, -5.0], [3.4, -4.3], [2.5, -4.8]], w: [0.95, 0.7, 0.5, 0.25] },
];
/** Lava knolls standing out of the sand: the snakes' lookouts, and the two safe points' crevices. */
export const KNOLLS = [
  // First dunes.
  { x: -3.6, z: 1.6, r: 0.42 },
  { x: -2.75, z: -1.15, r: 0.4 },
  { x: -3.95, z: -2.8, r: 0.34 },
  // The first safe point's.
  { x: -1.28, z: 0.12, r: 0.52 },
  // The lava field.
  { x: -0.15, z: 1.05, r: 0.45 },
  { x: 0.4, z: -1.0, r: 0.5 },
  { x: 1.0, z: 2.5, r: 0.4 },
  { x: -0.6, z: -2.7, r: 0.38 },
  // The second safe point's.
  { x: 2.0, z: -0.34, r: 0.48 },
  // Beach dunes.
  { x: 3.3, z: 1.45, r: 0.38 },
  { x: 3.6, z: -1.95, r: 0.42 },
  { x: 2.7, z: 3.3, r: 0.3 },
] as const;

/**
 * The nest burrows: dozens of females dig in the same flat each season. Mostly in the west, the
 * flat between the start and the dunes, never within a lizard's length of each other.
 */
export const BURROWS: Burrow[] = (() => {
  const rand = rng(97);
  const list: Burrow[] = [NEST_BURROW];
  const dig = (x: number, z: number) => {
    if (list.some((b) => Math.hypot(b.x - x, b.z - z) < 0.36)) return;
    // The run out of the lizard's own burrow is clear, and the safe points.
    if (Math.abs(z - NEST.z) < 0.22 && x > NEST.x - 0.1 && x < NEST.x + 0.75) return;
    if (SAFE_POINTS.some((p) => Math.hypot(p.x - x, p.z - z) < 0.5)) return;
    // Dug into the wind's lee mostly: tunnels lean west-ish, with plenty of scatter.
    list.push({ x, z, yaw: -Math.PI / 2 + (rand() - 0.5) * 2.4, size: 0.85 + rand() * 0.35 });
  };
  // The nesting flat, thick toward the west where the sand is deep and flat.
  for (let i = 0; i < 6000 && list.length < 48; i++) {
    const x = -6.85 + rand() * 2.4;
    const z = -6.6 + rand() * 13.2;
    if (rand() > smoothstep(-4.4, -5.8, x) + 0.15) continue;
    dig(x, z);
  }
  // A few more out across the sand, dug by females that went further: somewhere to duck into.
  for (let i = 0; i < 6000 && list.length < 70; i++) {
    const x = -4.4 + rand() * 8.4;
    const z = -6.4 + rand() * 12.8;
    if (lavaShape(x, z) > 0 || x > duneShoreX(z) - 1.1) continue;
    dig(x, z);
  }
  return list;
})();

/** Footprint of a burrow's mouth and spoil heap along and across its tunnel (m, before `size`). */
const MOUTH = { back: 0.055, front: 0.08, half: 0.048, depth: 0.05 };
const SPOIL = { at: -0.14, along: 0.12, across: 0.1, height: 0.022 };
/** No burrow reaches further than this from its middle (m). */
const BURROW_REACH = 0.3;

/**
 * How a burrow shapes the ground at (x, z): the pit of its mouth (negative), deepening into the
 * tunnel, and its heap of spoil (positive). `hole` is how far into the mouth the point is (0 to 1),
 * for colouring it dark.
 */
function burrowRelief(x: number, z: number, out = { h: 0, hole: 0, spoil: 0 }) {
  out.h = out.hole = out.spoil = 0;
  for (const b of BURROWS) {
    const dx = x - b.x;
    const dz = z - b.z;
    if (Math.abs(dx) > BURROW_REACH || Math.abs(dz) > BURROW_REACH) continue;
    const s = Math.sin(b.yaw);
    const c = Math.cos(b.yaw);
    // Along the tunnel (+ goes in) and across it, in units of the burrow's size.
    const a = (dx * s + dz * c) / b.size;
    const w = (dx * c - dz * s) / b.size;
    // The mouth: an oval pit sloping down into the tunnel, its far end a steep wall.
    const across = smoothstep(1, 0.55, Math.abs(w) / MOUTH.half);
    const span = smoothstep(-MOUTH.back - 0.02, -MOUTH.back + 0.015, a) * smoothstep(MOUTH.front + 0.012, MOUTH.front - 0.008, a);
    const pit = across * span;
    if (pit > 0) {
      const deep = 0.25 + 0.75 * smoothstep(-MOUTH.back, MOUTH.front, a);
      out.h -= pit * deep * MOUTH.depth * b.size;
      out.hole = Math.max(out.hole, pit * deep);
    }
    // The spoil: a low heap in front of the mouth.
    const sa = (a - SPOIL.at) / SPOIL.along;
    const sw = w / SPOIL.across;
    const r2 = sa * sa + sw * sw;
    if (r2 < 1) {
      const heap = (1 - r2) * (1 - r2);
      out.h += heap * SPOIL.height * b.size;
      out.spoil = Math.max(out.spoil, heap);
    }
  }
  return out;
}
const relief = { h: 0, hole: 0, spoil: 0 };


/** Distance from (x, z) to the segment from a to b, and how far along it (0 to 1) the nearest point is. */
function toSegment(x: number, z: number, a: [number, number], b: [number, number]) {
  const ex = b[0] - a[0];
  const ez = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez)));
  return { d: Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t), t };
}

/** How much (x, z) lies within a lava flow or knoll, 0 to 1, with ragged edges; buried or not. */
function lavaShape(x: number, z: number): number {
  const ragged = valueNoise(x / 0.25 + 3, z / 0.25 - 6, 51) * 0.09 + valueNoise(x / 0.08, z / 0.08, 52) * 0.025;
  let inside = -Infinity;
  for (const f of FLOWS) {
    for (let i = 0; i + 1 < f.pts.length; i++) {
      const { d, t } = toSegment(x, z, f.pts[i], f.pts[i + 1]);
      inside = Math.max(inside, f.w[i] + (f.w[i + 1] - f.w[i]) * t - d);
    }
  }
  for (const k of KNOLLS) inside = Math.max(inside, k.r - Math.hypot(x - k.x, z - k.z));
  // The whole coast is lava but for the cove.
  const s = x - duneShoreX(z) + valueNoise(x / 0.3 - 4, z / 0.3, 53) * 0.18;
  inside = Math.max(inside, (s + 0.95) * (1 - cove(z)) - 0.02);
  return smoothstep(-0.01, 0.03, inside + ragged);
}

/** Height of the sand alone at (x, z), before the lava and the coast. */
function sandHeight(x: number, z: number): number {
  // Rising gently inland from the back of the shore, with long low swells and small bumps.
  const rise = 0.035 + 0.12 * smoothstep(4.8, -6.6, x);
  const swell = valueNoise(x / 1.6 + 3, z / 1.6 - 8, 41) * 0.03;
  const bumps = valueNoise(x / 0.4 - 2, z / 0.4 + 5, 42) * 0.006;
  return rise + swell + bumps + duneRidges(x, z) * duneBelt(x) + burrowRelief(x, z, relief).h;
}

/**
 * Where the dunes are, 0 to 1: a belt past the nesting flat, a taller one behind the beach, and
 * bigger ones out past the west wall.
 */
export function duneBelt(x: number): number {
  const first = smoothstep(-4.9, -4.2, x) * smoothstep(-1.4, -2.1, x);
  const beach = 1.2 * smoothstep(2.0, 2.6, x) * smoothstep(4.8, 4.1, x);
  return first + beach + 1.6 * smoothstep(-7.3, -8.6, x);
}

/**
 * The dunes: ridges across the wind, a long gentle windward slope up to a crest and a steep slip
 * face down the lee (no steeper than sand lies, about 35°), with flat-floored hollows between. The
 * crests break up along their length into separate dunes, leaving gaps to run through. Also gives
 * the crest-ness (0 to 1) and lee-ness for colouring.
 */
export function duneRidges(x: number, z: number, shape?: { hump: number; lee: number }): number {
  const u = x * WIND.x + z * WIND.z;
  const v = -x * WIND.z + z * WIND.x;
  const warp = valueNoise(v / 1.1 + 4, u / 2 + 1, 43) * 0.35 + valueNoise(v / 0.45, u / 0.6, 44) * 0.06;
  const f = (u + warp) / 1.45;
  const t = f - Math.floor(f);
  const crest = 0.72;
  const hump = t < crest ? 0.5 - 0.5 * Math.cos((Math.PI * t) / crest) : 0.5 - 0.5 * Math.cos((Math.PI * (1 - t)) / (1 - crest));
  // Whole dunes come and go along a crest line, a new pattern for each crest.
  const seg = smoothstep(-0.3, 0.3, valueNoise(v / 1.3 - 7, Math.floor(f) * 3.1, 45));
  const amp = 0.17 * seg * (0.75 + 0.25 * valueNoise(x / 2, z / 2, 46));
  const h = (amp * Math.max(0, hump - 0.12)) / 0.88;
  if (shape) {
    shape.hump = seg * Math.max(0, hump - 0.12) / 0.88;
    shape.lee = t > crest ? seg * smoothstep(1, crest, t) : 0;
  }
  return h;
}

/** Height of bare lava at (x, z): standing a few cm proud of the sand, rough and ropy. */
function lavaHeight(x: number, z: number): number {
  const rise = 0.035 + 0.12 * smoothstep(4.8, -6.6, x);
  const swell = valueNoise(x / 1.6 + 3, z / 1.6 - 8, 41) * 0.03;
  return rise + swell + 0.06 + lavaRelief(x, z, 0.035) + valueNoise(x / 0.5 + 9, z / 0.5, 54) * 0.015;
}

/** Height of land before the coast is carved: lava where it stands above the sand, sand elsewhere. */
function landHeight(x: number, z: number): number {
  const sand = sandHeight(x, z);
  const lava = lavaShape(x, z);
  if (lava <= 0) return sand;
  return sand + (Math.max(sand, lavaHeight(x, z)) - sand) * lava;
}

/** Ground height (m) of the dunes level at (x, z), the coast carved in like the island's. */
export function duneHeight(x: number, z: number): number {
  const land = Math.max(WATER_Y + 0.01, landHeight(x, z));
  const s = x - duneShoreX(z);
  const sandy = cove(z);
  if (s < 0) {
    if (s < -1.3) return land;
    const sand = WATER_Y + 0.07 * Math.pow(-s / 0.9, 0.8);
    const ledge = WATER_Y + (0.022 + 0.05 * -s + lavaRelief(x, z, 0.02)) * smoothstep(0, -0.07, s);
    const coast = ledge + (sand - ledge) * sandy;
    return coast + (land - coast) * smoothstep(-0.25, -1.3, s);
  }
  const sandBed = WATER_Y - 0.05 * smoothstep(0, 0.4, s) - (SEA_DEPTH - 0.05) * smoothstep(0.6, 1.8, s);
  const lavaBed = WATER_Y - 0.08 * smoothstep(0, 0.12, s) - (SEA_DEPTH - 0.1) * smoothstep(0.15, 1.1, s) + lavaRelief(x, z, 0.05) * smoothstep(0.05, 0.25, s);
  const swell = valueNoise(x / 0.9 + 4, z / 0.9 - 2, 13) * 0.03 * smoothstep(1, 2, s);
  return lavaBed + (sandBed - lavaBed) * sandy + swell;
}

/**
 * How much (x, z) is bare black lava, 0 to 1: inside a flow, knoll or the shore, and standing
 * above the sand there rather than buried by a dune.
 */
export function duneLava(x: number, z: number): number {
  const lava = lavaShape(x, z);
  if (lava <= 0) return 0;
  const s = x - duneShoreX(z);
  if (s > -0.05) return lava * (1 - cove(z));
  return lava * smoothstep(-0.004, 0.006, lavaHeight(x, z) - sandHeight(x, z));
}

/** How much (x, z) is open sand, 0 to 1 (the rest is lava, or under the sea). */
export function duneSand(x: number, z: number): number {
  return x - duneShoreX(z) > 0.05 ? 0 : 1 - duneLava(x, z);
}

/** Dry pale sand, a little warmer on the crests; damp and greyer in the hollows. */
const SAND = new THREE.Color(0xdccfa8);
const CREST = new THREE.Color(0xe6dbb8);
const HOLLOW = new THREE.Color(0xc2b38e);
/** Sand dark with basalt grit where it borders the lava. */
const GRIT = new THREE.Color(0x9a8e7b);
/** Fresh spoil from a burrow, still damp; the shadowed throat of the burrow. */
const SPOIL_SAND = new THREE.Color(0xcbb184);
const BURROW_DARK = new THREE.Color(0x4e3f30);
const WET_SAND = new THREE.Color(0xbba881);
/** Black lava, lighter on its weathered crests and darkest wet (as on the island). */
const LAVA = new THREE.Color(0x353130);
const LAVA_CREST = new THREE.Color(0x544c46);
const LAVA_WET = new THREE.Color(0x222020);
const tmp = new THREE.Color();
const shape = { hump: 0, lee: 0 };

/** Colour of the dunes' ground at (x, z), height y, into `c`. */
export function duneColour(x: number, z: number, y: number, c: THREE.Color) {
  duneRidges(x, z, shape);
  const belt = duneBelt(x);
  const hollow = belt * smoothstep(0.1, 0, shape.hump) * smoothstep(-0.2, 0.4, valueNoise(x / 0.6 + 2, z / 0.6 - 3, 55));
  c.copy(SAND).lerp(CREST, belt * shape.hump * 0.8).lerp(HOLLOW, 0.75 * hollow);
  c.lerp(tmp.copy(SAND).multiplyScalar(0.94), belt * shape.lee * 0.6);
  // Basalt grit in streaks near the lava.
  const nearLava = smoothstep(0, 0.6, lavaShape(x, z)) * (0.6 + 0.4 * valueNoise(x / 0.15, z / 0.15, 56));
  c.lerp(GRIT, 0.55 * nearLava);
  burrowRelief(x, z, relief);
  c.lerp(SPOIL_SAND, 0.7 * smoothstep(0, 0.6, relief.spoil));
  c.lerp(BURROW_DARK, smoothstep(0.2, 0.9, relief.hole));
  const wet = smoothstep(WATER_Y + 0.008, WATER_Y + 0.001, y) * smoothstep(WATER_Y - 0.04, WATER_Y - 0.01, y);
  c.lerp(WET_SAND, wet * cove(z));
  const lava = duneLava(x, z);
  if (lava > 0) {
    const crest = smoothstep(0.7, 0.95, ridgedNoise(x / 0.22 + 3, z / 0.22 - 8, 11));
    const pit = smoothstep(0.35, 0.8, valueNoise(x / 0.06 + 9, z / 0.06 - 2, 33));
    tmp.copy(LAVA).lerp(LAVA_CREST, crest).lerp(LAVA_WET, Math.max(wet, 0.6 * pit));
    c.lerp(tmp, lava);
  }
}

/** How much the ground at (x, z) shows wind ripples (open dry sand), 0 to 1, for the sand shader. */
export function duneRipples(x: number, z: number, y: number): number {
  burrowRelief(x, z, relief);
  return duneSand(x, z) * (1 - relief.hole) * smoothstep(WATER_Y + 0.006, WATER_Y + 0.02, y);
}

/** Whether (x, z) is down a burrow's mouth, deep enough to be out of sight (0 to 1). */
export function burrowDepth(x: number, z: number): number {
  return burrowRelief(x, z, relief).hole;
}

/**
 * Where the racers lie up: at the foot of the lava knolls and flows and along the shore rocks,
 * watching the sand, most of them near the straight way from the nest to the colony. Each lies
 * coiled with its head pointing along `yaw`.
 */
const HOME_SPOTS: [knoll: number, facing: number][] = [
  [0, -2.3], [0, 2.2], [1, -1.0], [1, 1.6], [2, -0.6],
  // The first safe point's knoll: only on its far side, looking out over the lava field.
  [3, 1.9],
  [4, -1.9], [4, 1.1], [5, -1.5], [5, 2.4], [6, -2.2], [7, 0.4],
  // The second safe point's: its far side.
  [8, 2.0],
  [9, -1.6], [10, -1.2], [11, -2.4],
];
export const RACER_HOMES: readonly { x: number; z: number; yaw: number }[] = [
  ...HOME_SPOTS.map(([k, a]) => {
    const n = KNOLLS[k];
    return { x: n.x + Math.sin(a) * (n.r + 0.08), z: n.z + Math.cos(a) * (n.r + 0.08), yaw: a };
  }),
  // On the shore rocks, short of the colony.
  { x: 4.55, z: 1.15, yaw: -1.7 },
  { x: 4.45, z: -2.55, yaw: -1.3 },
];
