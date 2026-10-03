import * as THREE from 'three';
import { FOG, PALETTE } from '../render/scene';

/**
 * The pond carved into the clearing, behind and to the left of the spawn point: a still surface at
 * WATER_Y over a bowl 35 cm deep (a couple of lizard lengths) and about 1.6 m across. A sloping
 * shore runs down to a shallow shelf you can wade onto, which then drops off into the deep middle.
 * Its surroundings never dip below the surface, so the water only shows inside the bowl.
 */
export const POND = {
  x: -1.4,
  z: 0.9,
  /** Mean shoreline radius (m); the outline wobbles around it. */
  radius: 0.8,
  /** Width of the shore that rises from the waterline back to the meadow. */
  shore: 0.2,
  /** Depth of the shallow shelf inside the shoreline, and of the deepest part. */
  shelf: 0.05,
  depth: 0.35,
} as const;
/** Height of the water surface (m). The meadow around the pond is all above it. */
export const WATER_Y = -0.045;
/** The water mesh covers this far from the centre; everything outside is dry land. */
export const POND_REACH = POND.radius * 1.2 + POND.shore;

const smoothstep = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/** Shoreline radius in the direction of (dx, dz) from the centre: a lopsided, natural outline. */
function shoreline(dx: number, dz: number): number {
  const a = Math.atan2(dz, dx);
  return POND.radius * (1 + 0.12 * Math.sin(2 * a + 1) + 0.06 * Math.sin(3 * a - 2));
}

/**
 * Carve the pond into a meadow height: inside the shoreline the bed falls gently to the shelf, then
 * drops off to full depth; outside it the shore blends from the waterline back to the meadow.
 */
export function carvePond(x: number, z: number, meadow: number): number {
  const dx = x - POND.x;
  const dz = z - POND.z;
  const r = Math.hypot(dx, dz);
  if (r >= POND_REACH) return meadow;
  const edge = shoreline(dx, dz);
  if (r >= edge) return WATER_Y + (meadow - WATER_Y) * smoothstep(edge, edge + POND.shore, r);
  const t = 1 - r / edge;
  return WATER_Y - POND.shelf * smoothstep(0, 0.2, t) - (POND.depth - POND.shelf) * smoothstep(0.2, 0.9, t);
}

export const nearPond = (x: number, z: number) => Math.hypot(x - POND.x, z - POND.z) < POND_REACH;

/** How far below the water surface a point is (m); negative above it or away from the pond. */
export function waterDepth(p: { x: number; y: number; z: number }): number {
  return nearPond(p.x, p.z) ? WATER_Y - p.y : -Infinity;
}

const UNDERWATER = new THREE.Color(0x3f8a8c);

/** The water surface: a translucent sheet over the bowl, seen from above and below. */
export function buildWater(scene: THREE.Scene): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(POND_REACH, 64).rotateX(-Math.PI / 2),
    new THREE.MeshToonMaterial({
      color: 0x5aa9b5,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  mesh.position.set(POND.x, WATER_Y, POND.z);
  mesh.renderOrder = 1;
  mesh.name = 'water';
  scene.add(mesh);
  return mesh;
}

/**
 * With the camera under the surface, swap the sky-coloured fog for close murky green, so the
 * pond reads as water from inside.
 */
export function updateUnderwaterView(scene: THREE.Scene, camera: THREE.Camera) {
  const under = waterDepth(camera.position) > 0;
  const fog = scene.fog as THREE.Fog;
  fog.color.set(under ? UNDERWATER : PALETTE.sky);
  fog.near = under ? 0.05 : FOG.near;
  fog.far = under ? 1.2 : FOG.far;
  (scene.background as THREE.Color).copy(fog.color);
}
