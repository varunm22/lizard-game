import * as THREE from 'three';
import { FOG, PALETTE } from '../render/scene';
import { ridgedNoise, smoothstep, valueNoise } from './noise';

/**
 * The coast along the east (+X) side of the island. The waterline wanders north-south around
 * x = 2; the middle of it is a sandy beach that shelves gently into the sea, and both ends are black
 * lava: a low ledge that drops off steeply onto a rough rocky bottom. Out past a couple of metres the
 * sea floor levels off 40 cm down, which runs on past the edge of the walkable world into the fog.
 */
/** Height of the sea surface (m). All land is above it. */
export const WATER_Y = -0.045;
/** The water sheet starts this far west (m); everything west of it is dry land. */
export const OCEAN_X0 = 1.0;
/** Width of the sloping beach between the waterline and the land behind it (m). */
export const BEACH_WIDTH = 0.9;
/** Depth of the open sea floor (m below the surface). */
export const SEA_DEPTH = 0.4;

/**
 * The sea's life by depth (m below the surface): seaweed grows down to `algae[0]` and thins out to
 * none by `algae[1]`; coral starts at `coral[0]` and is as thick as it gets by `coral[1]`. Between
 * the two the zones overlap.
 */
export const SEA_ZONES = { algae: [0.12, 0.22], coral: [0.14, 0.24] } as const;
/** How much of the seaweed grows at a depth (0 to 1). */
export const algaeShare = (depth: number) => 1 - smoothstep(SEA_ZONES.algae[0], SEA_ZONES.algae[1], depth);
/** How much of the coral grows at a depth (0 to 1). */
export const coralShare = (depth: number) => smoothstep(SEA_ZONES.coral[0], SEA_ZONES.coral[1], depth);

/** X of the waterline (m) at a given z: a few slow bends. */
export function shoreX(z: number): number {
  return 2.0 + 0.22 * Math.sin(1.1 * z + 0.6) + 0.1 * Math.sin(2.7 * z - 1.3);
}
/** How much the coast at z is lava rather than sand (0 beach, 1 rocky shore): the beach runs from z = -0.2 to 2.4. */
export function rockyShore(z: number): number {
  return Math.min(1, 1 - smoothstep(-0.9, -0.2, z) + smoothstep(2.4, 3.0, z));
}

/** Rough lava surface relief (m, 0 up to about `amp`): ropy crests and lumps. */
export function lavaRelief(x: number, z: number, amp: number): number {
  return amp * (0.6 * ridgedNoise(x / 0.22 + 3, z / 0.22 - 8, 11) + 0.4 * (valueNoise(x / 0.07, z / 0.07, 12) * 0.5 + 0.5));
}

/**
 * Ground height near the coast, given the inland height `land` it blends back into. `s` is the
 * distance east of the waterline (negative on land).
 */
export function carveShore(x: number, z: number, land: number): number {
  const s = x - shoreX(z);
  const rocky = rockyShore(z);
  if (s < 0) {
    if (s < -BEACH_WIDTH - 0.4) return land;
    // Sand rises steadily from the waterline; lava steps up in a low rough ledge.
    const sand = WATER_Y + 0.07 * Math.pow(-s / BEACH_WIDTH, 0.8);
    const ledge = WATER_Y + (0.022 + 0.05 * -s + lavaRelief(x, z, 0.018)) * smoothstep(0, -0.07, s);
    const coast = sand + (ledge - sand) * rocky;
    return coast + (land - coast) * smoothstep(-0.25, -BEACH_WIDTH - 0.4, s);
  }
  // In the water: the beach shelves to a wading depth before dropping away; the lava drops off at
  // once onto a bouldery bottom.
  const sandBed = WATER_Y - 0.05 * smoothstep(0, 0.4, s) - (SEA_DEPTH - 0.05) * smoothstep(0.6, 1.8, s);
  const lavaBed =
    WATER_Y -
    0.08 * smoothstep(0, 0.12, s) -
    (SEA_DEPTH - 0.1) * smoothstep(0.15, 1.1, s) +
    lavaRelief(x, z, 0.05) * smoothstep(0.05, 0.25, s);
  const swell = valueNoise(x / 0.9 + 4, z / 0.9 - 2, 13) * 0.03 * smoothstep(1, 2, s);
  return sandBed + (lavaBed - sandBed) * rocky + swell;
}

/** Whether (x, z) is in the stretch the water sheet covers. Land there is always above the surface. */
export const inOcean = (x: number, _z: number) => x > OCEAN_X0;

/** How far below the sea surface a point is (m); negative above it or inland. */
export function waterDepth(p: { x: number; y: number; z: number }): number {
  return inOcean(p.x, p.z) ? WATER_Y - p.y : -Infinity;
}

const UNDERWATER = new THREE.Color(0x2a7f8c);

/**
 * With the camera under the surface, swap the sky-coloured fog for close blue-green, so the
 * sea reads as water from inside.
 */
export function updateUnderwaterView(scene: THREE.Scene, camera: THREE.Camera) {
  const under = waterDepth(camera.position) > 0;
  const fog = scene.fog as THREE.Fog;
  fog.color.set(under ? UNDERWATER : PALETTE.sky);
  fog.near = under ? 0.05 : FOG.near;
  fog.far = under ? 1.4 : FOG.far;
  (scene.background as THREE.Color).copy(fog.color);
}
