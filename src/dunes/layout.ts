import * as THREE from 'three';
import { ridgedNoise, rng, smoothstep, valueNoise } from '../world/noise';
import { lavaRelief, SEA_DEPTH, WATER_Y } from '../world/shore';

/**
 * The nesting dunes (`?level=dunes`), laid out like the hatching grounds on Fernandina: a flat of
 * pale sand pocked with nest burrows in the west, where the lizard hatches; a belt of low dunes,
 * their crests running SW-NE across the trade wind, broken into separate dunes with gaps between;
 * tongues and knolls of black lava poking up through the sand, where the racer snakes lie up; and
 * a black lava shore to the east with a little sandy cove, where the adult colony basks. The sea
 * lies to the east as on the island, so the water, its swells and swimming work the same.
 */

/** X of the waterline (m) at a given z: a few slow bends, a little further out than the island's. */
export function duneShoreX(z: number): number {
  return 2.45 + 0.2 * Math.sin(0.8 * z + 1.0) + 0.08 * Math.sin(2.3 * z - 0.4);
}

/** How much the coast at z is the sandy cove rather than lava (0 lava, 1 sand): z 0.65 to 1.75. */
export function cove(z: number): number {
  return smoothstep(0.45, 0.8, z) * smoothstep(1.95, 1.6, z);
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
const NEST_BURROW: Burrow = { x: -3.32, z: 0.35, yaw: -Math.PI / 2, size: 1 };

/** Where the lizard starts: just inside its burrow's mouth, facing out. */
export const NEST = { x: NEST_BURROW.x + 0.035, z: NEST_BURROW.z, yaw: Math.PI / 2 };

/**
 * The finish: a patch of the lava shore where the adult colony basks, just above the waves. The run
 * is over once the lizard's feet are within `r` of its middle, at the edge of the adults lying there.
 */
export const COLONY = { x: duneShoreX(-0.35) - 0.42, z: -0.35, r: 0.6 };

/** Where the trade wind blows the sand: from the south-east toward the north-west (unit, x and z). */
export const WIND = { x: -0.86, z: -0.51 };

/**
 * The nest burrows: dozens of females dig in the same flat each season. Mostly in the west, the
 * flat between the start and the dunes, never within a lizard's length of each other.
 */
export const BURROWS: Burrow[] = (() => {
  const rand = rng(97);
  const list: Burrow[] = [NEST_BURROW];
  for (let i = 0; i < 4000 && list.length < 34; i++) {
    const x = -3.85 + rand() * 1.9;
    const z = -3.7 + rand() * 7.4;
    // Thicker toward the west, where the sand is deep and flat.
    if (rand() > smoothstep(-1.9, -3.2, x) + 0.15) continue;
    if (list.some((b) => Math.hypot(b.x - x, b.z - z) < 0.36)) continue;
    // The run out of the lizard's own burrow is clear.
    if (Math.abs(z - NEST.z) < 0.22 && x > NEST.x - 0.1 && x < NEST.x + 0.75) continue;
    // Dug into the wind's lee mostly: tunnels lean west-ish, with plenty of scatter.
    list.push({ x, z, yaw: -Math.PI / 2 + (rand() - 0.5) * 2.4, size: 0.85 + rand() * 0.35 });
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

/** The black lava flows: tongues running in from the shore, as points along each with its half-width there (m). */
const FLOWS: { pts: [number, number][]; w: number[] }[] = [
  { pts: [[3.2, 2.7], [2.0, 2.35], [1.0, 2.75], [0.0, 2.45], [-0.8, 2.85], [-1.4, 3.3]], w: [0.8, 0.65, 0.55, 0.45, 0.32, 0.22] },
  { pts: [[3.2, -2.5], [2.1, -2.75], [1.2, -2.15], [0.45, -2.4], [-0.1, -2.05]], w: [0.85, 0.65, 0.5, 0.38, 0.22] },
];
/** Lava knolls standing out of the dunes: the snakes' lookouts. */
export const KNOLLS = [
  { x: -0.75, z: 0.95, r: 0.42 },
  { x: 0.55, z: -0.7, r: 0.5 },
  { x: -1.75, z: -1.3, r: 0.36 },
  { x: 1.1, z: 0.95, r: 0.36 },
  { x: -1.6, z: 1.95, r: 0.3 },
  { x: -0.35, z: -1.35, r: 0.26 },
] as const;

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
  const rise = 0.035 + 0.075 * smoothstep(1.8, -3.6, x);
  const swell = valueNoise(x / 1.6 + 3, z / 1.6 - 8, 41) * 0.03;
  const bumps = valueNoise(x / 0.4 - 2, z / 0.4 + 5, 42) * 0.006;
  return rise + swell + bumps + duneRidges(x, z) * duneBelt(x) + burrowRelief(x, z, relief).h;
}

/** Where the dunes are, 0 to 1: a belt across the middle, and bigger ones out past the west wall. */
export function duneBelt(x: number): number {
  return smoothstep(1.7, 0.9, x) * (smoothstep(-2.95, -2.05, x) + 1.6 * smoothstep(-4.3, -5.6, x));
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
  const rise = 0.035 + 0.075 * smoothstep(1.8, -3.6, x);
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
export const RACER_HOMES = [
  { x: -1.0, z: 0.62, yaw: -2.2 },
  { x: 0.22, z: -0.42, yaw: -1.4 },
  { x: -1.95, z: -1.0, yaw: -0.9 },
  { x: 0.82, z: 1.2, yaw: -1.9 },
  { x: -1.42, z: 1.72, yaw: -2.6 },
  { x: 0.3, z: 2.08, yaw: -2.8 },
  { x: 1.5, z: -0.8, yaw: -1.6 },
  { x: 1.55, z: 0.35, yaw: -1.5 },
  { x: 0.55, z: -1.86, yaw: -0.4 },
] as const;
