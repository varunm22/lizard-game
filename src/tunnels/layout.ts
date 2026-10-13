import * as THREE from 'three';
import { smoothstep, valueNoise } from '../world/noise';
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
 * The lower floor (m): flat lava with a little roughness, a shallow layer of grit in the jameo, and
 * the flooded dip, whose bed goes below the water. Under the rock it doesn't matter.
 */
export function tunnelsHeight(x: number, z: number): number {
  const rough = valueNoise(x / 0.3 + 4, z / 0.3 - 2, 91) * 0.004 + valueNoise(x / 0.07, z / 0.07, 92) * 0.0015;
  const k = inPool(x, z);
  const floor = FLOORS[0] + rough;
  if (k <= 0) return floor;
  return floor + (WATER_Y - POOLS[0].depth - floor) * k;
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
  c.lerp(MOSS, 0.4 * sun * smoothstep(0.4, 0.9, ny) * smoothstep(-0.2, 0.5, n1));
  c.multiplyScalar(band(lit.glow) * (0.85 + 0.15 * Math.max(0, ny)));
  c.lerp(tmp.copy(c).multiply(SUNLIT).multiplyScalar(2.1), sun);
}

/** The lower floor's colour at (x, z), height y: as the rock facing up, darker in the water. */
export function tunnelsColour(x: number, z: number, y: number, c: THREE.Color) {
  rockColour(x, y, z, 1, c);
  if (y < WATER_Y) c.multiplyScalar(0.75);
}

/** The ground under the run's marks: the upper floor round the start, the lower floor elsewhere. */
export function terrainOrUpper(x: number, z: number): number {
  return Math.hypot(x - START.x, z - START.z) < 0.5 ? START_Y : tunnelsHeight(x, z);
}
