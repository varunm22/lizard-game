import * as THREE from 'three';
import { ridgedNoise, smoothstep, valueNoise } from '../world/noise';
import { WATER_Y } from '../world/shore';
import LAYOUT from '../assets/tunnels.json';

/**
 * The lava tunnels (`?level=tunnels`): a maze of small lava tubes on two floors under a lava field,
 * like the tubes and tubelets under Santa Cruz and Isabela. The layout lives in
 * `assets-src/tunnels.py`, which meshes the rock and writes `tunnels.json`; this reads it.
 *
 * The lower floor's ground is the heightfield (FLOORS[0], with a flooded dip); the upper floor is
 * the rock mesh (FLOORS[1]). Holes in the upper floor drop into the tubes below, a gap across one
 * tube has to be jumped at a run, and rubble piles in the lower tubes climb back up through holes
 * in their ceilings. Skylights let the sun in; the run ends in a jameo, a wide collapse open to the
 * sky, on the lower floor in the south-east.
 */

export interface XZ {
  x: number;
  z: number;
}
export interface Hole {
  kind: 'drop' | 'gap';
  name: string;
  /** A drop hole is round (a = b); a gap is a stadium from a to b, cutting across a tube. */
  a: XZ;
  b: XZ;
  r: number;
}
export interface Ramp {
  name: string;
  /**
   * The pile's foot on the lower floor (its first riser) and its top, the far edge of its last
   * tread, flush with the upper floor: a stair of fallen slabs, STEPS.count of them.
   */
  foot: XZ;
  top: XZ;
}
export interface Skylight extends XZ {
  name: string;
  r: number;
}
export interface Tube {
  floor: number;
  name: string;
  pts: XZ[];
  half: number;
}

export const FLOORS = LAYOUT.floors as [number, number];
export const TOP = LAYOUT.top;
export const START = LAYOUT.start as { x: number; z: number; yaw: number };
/** Where the run starts: the upper floor, in the sunlit chamber at the west end. */
export const START_Y = FLOORS[1];
export const FINISH = LAYOUT.finish as { x: number; z: number; r: number };
export const JAMEO = LAYOUT.jameo as { x: number; z: number; r: number };
export const HOLES = LAYOUT.holes as Hole[];
export const RAMPS = LAYOUT.ramps as Ramp[];
/** A rubble pile's steps: how many, each riser's height and each tread's depth (m). */
export const STEPS = LAYOUT.steps as { count: number; riser: number; tread: number };
export const SKYLIGHTS = LAYOUT.skylights as Skylight[];
export const TUBES = LAYOUT.tubes as Tube[];
export const POOLS = LAYOUT.pools as { x: number; z: number; rx: number; rz: number; depth: number }[];
/** A barn owl's roost: its ledge (feet, m) high in the skylight of the same name, and the way out from the wall (dx, dz). */
export interface Roost {
  name: string;
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
}
export const ROOSTS = LAYOUT.roosts as Roost[];
/** The outer islet across the water from the cove (the next stage, not built yet): its middle and radius (m). */
export const ISLET = LAYOUT.islet as { x: number; z: number; r: number };

/** Distance (m) from (x, z) to the segment a-b. */
export function segmentDistance(x: number, z: number, a: XZ, b: XZ): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / l2));
  return Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz));
}

/** Whether (x, z) is over a hole in the upper floor (within `margin` m of its rim). */
export function overHole(x: number, z: number, margin = 0): Hole | null {
  return HOLES.find((h) => segmentDistance(x, z, h.a, h.b) < h.r + margin) ?? null;
}

/**
 * How far into the flooded dip (x, z) is: 0 at its rim, 1 over its bed. The banks are nearly
 * straight and gentle (about 15°): the lizard's body stays level, so it can't stand on steep ground.
 */
function inPool(x: number, z: number): number {
  let d = 0;
  for (const p of POOLS) {
    const r = Math.hypot((x - p.x) / p.rx, (z - p.z) / p.rz);
    const t = Math.min(1, Math.max(0, (1 - r) / 0.62));
    d = Math.max(d, t * t * (3 - 2 * t) * 0.3 + t * 0.7);
  }
  return d;
}

/**
 * The cove's cliff line: z (m) at x, south of which the lava field has fallen away into the sea.
 * The same curve as `cove_z` in assets-src/tunnels.py, which carves the rock to it.
 */
export function coveZ(x: number): number {
  return 3.95 + 0.08 * Math.sin(5.1 * x + 0.7) + 0.05 * Math.sin(11.3 * x - 1.2) + 1.6 * smoothstep(3.25, 2.55, x) + 1.6 * smoothstep(4.55, 5.15, x);
}

/** How far out under the open sky (x, z) is: 0 under the lava field, 1 out in the cove and beyond. */
export function outside(x: number, z: number): number {
  return smoothstep(-0.25, 0.35, z - coveZ(x));
}

/** The sea's channel: from inside the tube's mouth out through the cove, widening as it goes. */
const CHANNEL = [
  { x: 3.6, z: 3.12, w: 0.13 },
  { x: 3.78, z: 3.7, w: 0.3 },
  { x: 3.7, z: 4.3, w: 0.42 },
  { x: 3.55, z: 5.2, w: 0.95 },
];
/** The sea bed's depth in the channel and the cove (m below the water). */
const SEA_BED = 0.22;

/** How far into the channel (x, z) is: 0 outside its banks, 1 in its middle. */
function inChannel(x: number, z: number): number {
  let best = 0;
  for (let i = 0; i + 1 < CHANNEL.length; i++) {
    const a = CHANNEL[i];
    const b = CHANNEL[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    const w = a.w + (b.w - a.w) * t;
    const d = Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz)) / w;
    best = Math.max(best, smoothstep(1, 0.45, d));
  }
  return best;
}

/** Rounded lava boulders (m above the ground under them), for the cove's beach and the islet's shore. */
function boulders(x: number, z: number, scale: number, seed: number): number {
  const n = valueNoise(x / scale, z / scale, seed);
  return Math.max(0, n - 0.15) * 0.8 * scale;
}

/**
 * The cove and the open sea round it (m): a beach of rounded boulders and black sand on the east side
 * of the cove, a rocky west side, the channel through the middle and the sea bed dropping away south.
 */
function coveHeight(x: number, z: number, floor: number): number {
  const out = z - coveZ(x);
  // Away from the cliff the shore shelves into the sea, and by the rock's south edge it's the open sea bed.
  const shelf = WATER_Y + 0.05 - 0.09 * smoothstep(0.35, 0.75, out);
  const beach = shelf + boulders(x, z, 0.09, 95) * smoothstep(0.15, 0.35, out) * (1 - smoothstep(0.55, 0.8, out));
  const shore = beach + (seaFloor(x, z) - beach) * smoothstep(4.55, 4.97, z);
  const ground = floor + (shore - floor) * smoothstep(-0.2, 0.2, out);
  const k = inChannel(x, z);
  return ground + (WATER_Y - SEA_BED + valueNoise(x / 0.2, z / 0.2, 96) * 0.02 - ground) * k;
}

/** The open sea's bed (m), deepening away to the south. */
function seaFloor(x: number, z: number): number {
  return WATER_Y - SEA_BED - 0.25 * smoothstep(5.2, 9, z) + valueNoise(x / 0.9, z / 0.9, 98) * 0.03;
}

/** The world outside the rock's square (m): the lava field, its sea cliffs, the sea bed and the islet. */
function outerHeight(x: number, z: number): number {
  const out = z - coveZ(x);
  const field = TOP + valueNoise(x / 0.8, z / 0.8, 97) * 0.03;
  const sea = seaFloor(x, z);
  const d = Math.hypot(x - ISLET.x, (z - ISLET.z) * 1.2) / ISLET.r;
  // The islet: a low dome of lava, steeper to the south, with a gentle beach on the side facing the cove.
  const north = smoothstep(0.4, -0.6, (z - ISLET.z) / ISLET.r);
  const dome = 1.4 * Math.pow(Math.max(0, 1 - d * d), 1.3 + north) + boulders(x, z, 0.35, 99) * smoothstep(1, 0.6, d) * (1 - north * 0.7);
  const islet = WATER_Y - 0.4 + (dome + 0.4) * smoothstep(1.15, 0.85, d);
  return Math.max(out < 0 ? field : sea, islet);
}

/**
 * The lower floor (m): lava with shallow sags and ropy wrinkles, a shallow layer of grit in the
 * jameo, the flooded dip, whose bed goes below the water, and out past the cliff the cove and the
 * sea. Under the rock it doesn't matter. Outside the rock's square, the world out there.
 */
export function tunnelsHeight(x: number, z: number): number {
  if (Math.abs(x) > 5 || Math.abs(z) > 5) return outerHeight(x, z);
  const rough = -0.003 - valueNoise(x / 0.3 + 4, z / 0.3 - 2, 91) * 0.004 + (ridgedNoise(x / 0.14, z / 0.08, 92) - 0.5) * 0.003;
  const k = inPool(x, z);
  let floor = FLOORS[0] + rough;
  if (k > 0) floor += (WATER_Y - POOLS[0].depth - floor) * k;
  return z > 2.9 && x > 2.4 ? coveHeight(x, z, floor) : floor;
}

/**
 * The baked light (`assets-src/tunnels.py`): per cell of a coarse grid, `sun` (open sky straight
 * up along the sun's slant) and `glow` (sunlight spread through the air round corners), 0 to 1.
 */
const L = LAYOUT.light as { origin: [number, number, number]; cell: number; size: [number, number, number] };
let light: Uint8Array | null = null;

export function setLight(data: ArrayBuffer) {
  light = new Uint8Array(data);
}

/** The light at a point, trilinear between cells, into `out` (sun, glow). */
export function lightAt(x: number, y: number, z: number, out: { sun: number; glow: number }) {
  out.sun = 0;
  out.glow = 0;
  if (!light) return out;
  const [nx, ny, nz] = L.size;
  const fx = Math.min(nx - 1.001, Math.max(0, (x - L.origin[0]) / L.cell));
  const fy = Math.min(ny - 1.001, Math.max(0, (y - L.origin[1]) / L.cell));
  const fz = Math.min(nz - 1.001, Math.max(0, (z - L.origin[2]) / L.cell));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const k = Math.floor(fz);
  const u = fx - i;
  const v = fy - j;
  const w = fz - k;
  for (let dj = 0; dj < 2; dj++) {
    for (let dk = 0; dk < 2; dk++) {
      for (let di = 0; di < 2; di++) {
        const weight = (di ? u : 1 - u) * (dj ? v : 1 - v) * (dk ? w : 1 - w);
        const at = (((j + dj) * nz + (k + dk)) * nx + (i + di)) * 2;
        out.sun += weight * light[at];
        out.glow += weight * light[at + 1];
      }
    }
  }
  out.sun /= 255;
  out.glow /= 255;
  return out;
}

/** Bare basalt, the floors' ropy lava a little lighter, the red of oxidised walls, moss in the sun. */
const BASALT = new THREE.Color(0x4a4440);
const FLOOR_LAVA = new THREE.Color(0x5b534b);
const OXIDE = new THREE.Color(0x7a4c38);
const GLAZE = new THREE.Color(0x2f2b2a);
const MOSS = new THREE.Color(0x6f8f3e);
const GRIT = new THREE.Color(0x8a7b66);
const SUNLIT = new THREE.Color(0xfff0cc);
const tmp = new THREE.Color();
const lit = { sun: 0, glow: 0 };

/**
 * Toon bands for the baked glow: dark deep in the tubes, a few clear steps up toward the light.
 * Never black, so the way is always readable.
 */
function band(g: number): number {
  const steps = 4;
  const x = Math.pow(g, 0.55) * steps;
  const f = Math.floor(x);
  return 0.36 + (0.64 * (f + smoothstep(0.85, 1, x - f))) / steps;
}

/**
 * The colour of the rock (or, with `ny` = 1, the lower floor) at a point with the light on it:
 * the stone by where it faces, lit in toon bands by the glow, the sun's patches warm and bright,
 * moss where the sun falls on an upward face.
 */
export function rockColour(x: number, y: number, z: number, ny: number, c: THREE.Color) {
  const n1 = valueNoise(x / 0.16 + y * 4, z / 0.16 - y * 3, 93);
  const n2 = valueNoise(x / 0.05 - y * 9, z / 0.05 + y * 7, 94);
  c.copy(BASALT).lerp(FLOOR_LAVA, smoothstep(0.3, 0.8, ny));
  c.lerp(OXIDE, 0.55 * smoothstep(0.2, 0.7, n1) * (1 - smoothstep(0.2, 0.6, Math.abs(ny))));
  c.lerp(GLAZE, smoothstep(-0.3, -0.8, ny) * 0.7);
  c.multiplyScalar(0.9 + 0.2 * n2);
  if (Math.hypot(x - JAMEO.x, z - JAMEO.z) < JAMEO.r + 0.2 && y < FLOORS[0] + 0.03) c.lerp(GRIT, 0.6 * smoothstep(0, 0.6, n1 + 0.4));
  // Sample the light a little off the surface, into the air.
  lightAt(x, y + 0.03 * ny, z, lit);
  const sun = smoothstep(0.25, 0.6, lit.sun);
  c.lerp(MOSS, 0.3 * sun * smoothstep(0.4, 0.9, ny) * smoothstep(0.1, 0.6, n1));
  c.multiplyScalar(band(lit.glow) * (0.85 + 0.15 * Math.max(0, ny)));
  c.lerp(tmp.copy(c).multiply(SUNLIT).multiplyScalar(2.1), sun);
}

const KEY = new THREE.Vector3(-0.35, 1, 0.45).normalize();

/**
 * How much light a face of rock catches for its shape (0 to 1, times its colour): darker in hollows,
 * under benches and round fallen blocks (`ao`, the generator's occlusion), and in toon bands by how it
 * faces a soft light from above and in front, so lumps, ledges and blocks stand out in the dim tubes.
 */
export function rockShade(nx: number, ny: number, nz: number, ao: number): number {
  const facing = nx * KEY.x + ny * KEY.y + nz * KEY.z;
  const key = facing > 0.55 ? 1 : facing > 0.05 ? 0.82 : 0.68;
  const hollow = ao > 0.7 ? 1 : ao > 0.45 ? 0.78 : 0.6;
  return key * hollow;
}

const SAND = new THREE.Color(0x2b2826);
const BOULDER = new THREE.Color(0x4d4844);
const PALE_SAND = new THREE.Color(0xd9ccae);
const SEA_BED_COLOUR = new THREE.Color(0x8f8a6e);
const SUN_DIR = new THREE.Vector3(2.5, 5, 1.7).normalize();
const sunTint = new THREE.Color();

/**
 * Out in the open (the world outside the rock's square, which has no baked light): the lava field and
 * its cliffs, the sea bed, and the islet's lava and pale sand, lit by the sun in two toon bands.
 */
function openColour(x: number, z: number, y: number, c: THREE.Color) {
  const e = 0.12;
  const dx = (tunnelsHeight(x + e, z) - tunnelsHeight(x - e, z)) / (2 * e);
  const dz = (tunnelsHeight(x, z + e) - tunnelsHeight(x, z - e)) / (2 * e);
  const ny = 1 / Math.hypot(dx, 1, dz);
  const lambert = (-dx * SUN_DIR.x + SUN_DIR.y - dz * SUN_DIR.z) * ny;
  const n1 = valueNoise(x / 0.5, z / 0.5, 93);
  const d = Math.hypot(x - ISLET.x, (z - ISLET.z) * 1.2) / ISLET.r;
  c.copy(BASALT).lerp(OXIDE, 0.4 * smoothstep(0.2, 0.8, n1));
  // The islet's beach: pale coral sand where the dome is low and gentle, on its side facing the cove.
  if (d < 1.1 && y < WATER_Y + 0.25) c.lerp(PALE_SAND, smoothstep(0.85, 0.95, ny) * smoothstep(WATER_Y + 0.25, WATER_Y + 0.12, y));
  if (y < WATER_Y) c.lerp(SEA_BED_COLOUR, 0.5);
  c.multiplyScalar(lambert > 0.45 ? 1 : 0.55).multiply(sunTint.copy(SUNLIT).multiplyScalar(1.6));
}

/**
 * The lower floor's colour at (x, z), height y: as the rock facing up, with darker ropy wrinkles; in
 * the cove, black sand between grey boulders; darker in the water. Outside the square, the open world.
 */
export function tunnelsColour(x: number, z: number, y: number, c: THREE.Color) {
  if (Math.abs(x) > 5 || Math.abs(z) > 5) return openColour(x, z, y, c);
  rockColour(x, y, z, 1, c);
  c.multiplyScalar(1 - 0.18 * smoothstep(0.88, 0.97, ridgedNoise(x / 0.14, z / 0.08, 92)));
  const out = outside(x, z);
  if (out > 0) {
    const rock = boulders(x, z, 0.09, 95) > 0.004 ? BOULDER : SAND;
    c.lerp(tmp.copy(rock).multiply(SUNLIT).multiplyScalar(1.8), out * 0.85);
  }
  // Shaded for its slope like the rock, so the boulders and ripples of the floor read.
  const e = 0.015;
  const dx = (tunnelsHeight(x + e, z) - tunnelsHeight(x - e, z)) / (2 * e);
  const dz = (tunnelsHeight(x, z + e) - tunnelsHeight(x, z - e)) / (2 * e);
  const k = 1 / Math.hypot(dx, 1, dz);
  c.multiplyScalar(rockShade(-dx * k, k, -dz * k, 1));
  if (y < WATER_Y) c.multiplyScalar(0.75);
}

/** The ground under the run's marks: the upper floor round the start, the lower floor elsewhere. */
export function terrainOrUpper(x: number, z: number): number {
  return Math.hypot(x - START.x, z - START.z) < 0.5 ? START_Y : tunnelsHeight(x, z);
}
