import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { toonGradient } from '../render/toon';
import { ridgedNoise, smoothstep, valueNoise } from './noise';
import { forestCover, lavaCover, sandCover, shoreDistance } from './layout';
import { carveShore, lavaRelief, WATER_Y } from './shore';

/** Side of the walkable square (m). The physics heightfield covers exactly this. */
export const TERRAIN_SIZE = 8;
/** Cells per side of the physics heightfield: 8 m / 256 = ~3 cm, a sixth of a lizard. */
const CELLS = 256;
/**
 * The drawn ground extends past the walkable square so the island's rim fades into the fog. Outside
 * the square it is drawn coarser (OUTER_CELL m), since only the fog-faded distance is out there.
 */
const VISUAL_SIZE = 18;
const OUTER_CELL = 0.125;
/** Collision group bit carried by the invisible edge walls, so the camera can see past them. */
export const EDGE_WALL_GROUP = 0x0002;
/** Collision group bit carried by plant stems: they block the body but aren't ground to stand on. */
export const PLANT_STEM_GROUP = 0x0004;
/** Query filter for looking for the surface under or ahead of the lizard: everything but plant stems. */
export const IGNORE_STEMS = (0xffff << 16) | (0xffff & ~PLANT_STEM_GROUP);

/**
 * Ground height (m) at a world position. Layered noise, damped to almost flat in the middle of the
 * clearing so there's an easy play area, rising gently into the forest, rough where it's lava, a
 * bank at the island's inland rim, and the coast carved in.
 */
export function terrainHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const swell = valueNoise(x / 1.3 + 11, z / 1.3 - 4) * 0.05;
  const bumps = valueNoise(x / 0.35 - 7, z / 0.35 + 3) * 0.012;
  const grit = valueNoise(x / 0.09 + 2, z / 0.09 + 9) * 0.003;
  const calm = 0.25 + 0.75 * smoothstep(0.35, 1.1, r);
  const forest = forestCover(x, z);
  const roots = forest * (0.05 + valueNoise(x / 0.5 + 1, z / 0.5 + 6, 3) * 0.02);
  const lava = lavaCover(x, z) * lavaRelief(x, z, 0.02);
  // The inland rim rises out of the fog; the coast doesn't, the sea runs on past the edge.
  const inland = smoothstep(-0.6, -1.5, shoreDistance(x, z));
  const t = Math.max(0, -x - 3.3, (Math.abs(z) - 3.4) * inland);
  const bank = t < 1 ? 0.3 * t * t : 0.3 + 0.6 * (t - 1);
  const land = Math.max(WATER_Y + 0.01, (swell + bumps) * calm + grit + roots + lava + bank);
  return carveShore(x, z, land);
}

/** Approximate surface normal from the height function, for colouring. */
function slopeAt(x: number, z: number): number {
  const e = 0.02;
  const dx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e);
  const dz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
  return Math.hypot(dx, dz);
}

/** Dry-season grass and red-brown volcanic soil in the clearing. */
const GRASS = new THREE.Color(0xa7ae62);
const DRY = new THREE.Color(0x8f9a50);
const SOIL = new THREE.Color(0x8d6b4b);
/** Leaf litter and moss under the trees. */
const LITTER = new THREE.Color(0x5e4b35);
const FOREST_MOSS = new THREE.Color(0x5a7834);
/** Pale coral sand, darker where the waves wet it. */
const SAND = new THREE.Color(0xe6d8b2);
const WET_SAND = new THREE.Color(0xbba881);
/** Black lava, lighter on its weathered crests and darkest wet. */
const LAVA = new THREE.Color(0x353130);
const LAVA_CREST = new THREE.Color(0x544c46);
const LAVA_WET = new THREE.Color(0x222020);

/** Colour of the ground at (x, z), height y, into `c`. */
function groundColour(x: number, z: number, y: number, c: THREE.Color) {
  // Clearing: grass with drier patches, bare soil where the noise says so or the ground gets steep.
  const patch = valueNoise(x / 0.5 + 31, z / 0.5 - 17);
  c.copy(GRASS).lerp(DRY, smoothstep(-0.2, 0.5, valueNoise(x / 0.8 - 5, z / 0.8 + 21)));
  c.lerp(SOIL, Math.max(smoothstep(0.25, 0.6, patch), smoothstep(0.35, 0.8, slopeAt(x, z))));
  const forest = forestCover(x, z);
  if (forest > 0) {
    tmp.copy(LITTER).lerp(FOREST_MOSS, smoothstep(-0.3, 0.4, valueNoise(x / 0.4 + 7, z / 0.4 - 3, 31)));
    c.lerp(tmp, forest);
  }
  // Wave-wetted in a band at the waterline; further down, the water itself does the tinting.
  const wet = smoothstep(WATER_Y + 0.008, WATER_Y + 0.001, y) * smoothstep(WATER_Y - 0.04, WATER_Y - 0.01, y);
  const sand = sandCover(x, z);
  if (sand > 0) c.lerp(tmp.copy(SAND).lerp(WET_SAND, wet), sand);
  const lava = lavaCover(x, z);
  if (lava > 0) {
    // Ropy crests weathered lighter, cracks and pits darker.
    const crest = smoothstep(0.7, 0.95, ridgedNoise(x / 0.22 + 3, z / 0.22 - 8, 11));
    const pit = smoothstep(0.35, 0.8, valueNoise(x / 0.06 + 9, z / 0.06 - 2, 33));
    tmp.copy(LAVA).lerp(LAVA_CREST, crest).lerp(LAVA_WET, Math.max(wet, 0.6 * pit));
    c.lerp(tmp, lava);
  }
}
const tmp = new THREE.Color();

/** A grid of ground vertices `cells` across a square of side `size` centred on the origin; `skip(x, z)` drops a cell. */
function groundGrid(size: number, cells: number, skip?: (x: number, z: number) => boolean) {
  const n = cells + 1;
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const c = new THREE.Color();
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = (ix / cells - 0.5) * size;
      const z = (iz / cells - 0.5) * size;
      const y = terrainHeight(x, z);
      const i = iz * n + ix;
      positions.set([x, y, z], i * 3);
      groundColour(x, z, y, c);
      c.toArray(colors, i * 3);
    }
  }
  const index: number[] = [];
  for (let iz = 0; iz < cells; iz++) {
    for (let ix = 0; ix < cells; ix++) {
      const step = size / cells;
      if (skip?.((ix + 0.5) * step - size / 2, (iz + 0.5) * step - size / 2)) continue;
      const a = iz * n + ix;
      // Same diagonal as PlaneGeometry, which the physics heightfield matches.
      index.push(a, a + n, a + 1, a + n, a + n + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/** Build the toon-shaded ground mesh and its Rapier heightfield collider, plus walls at the edge. */
export function buildTerrain(scene: THREE.Scene, world: RAPIER.World) {
  const material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });
  const inner = new THREE.Mesh(groundGrid(TERRAIN_SIZE, CELLS), material);
  const half = TERRAIN_SIZE / 2;
  const outer = new THREE.Mesh(
    groundGrid(VISUAL_SIZE, Math.round(VISUAL_SIZE / OUTER_CELL), (x, z) => Math.abs(x) < half && Math.abs(z) < half),
    material,
  );
  const mesh = new THREE.Group();
  for (const m of [inner, outer]) {
    m.receiveShadow = true;
    mesh.add(m);
  }
  mesh.name = 'terrain';
  scene.add(mesh);
  // Rapier's heightfield is a column-major (nrows+1) x (ncols+1) matrix: rows run along z, columns
  // along x, so the sample at grid (ix, iz) lives at index ix * (CELLS + 1) + iz.
  const heights = new Float32Array((CELLS + 1) * (CELLS + 1));
  for (let ix = 0; ix <= CELLS; ix++) {
    for (let iz = 0; iz <= CELLS; iz++) {
      const x = (ix / CELLS - 0.5) * TERRAIN_SIZE;
      const z = (iz / CELLS - 0.5) * TERRAIN_SIZE;
      heights[ix * (CELLS + 1) + iz] = terrainHeight(x, z);
    }
  }
  world.createCollider(
    RAPIER.ColliderDesc.heightfield(CELLS, CELLS, heights, { x: TERRAIN_SIZE, y: 1, z: TERRAIN_SIZE }).setFriction(1),
  );

  // Invisible walls just inside the heightfield's edge so nothing walks off the world.
  const wall = half - 0.1;
  for (const [x, z, hx, hz] of [
    [wall, 0, 0.05, wall],
    [-wall, 0, 0.05, wall],
    [0, wall, wall, 0.05],
    [0, -wall, wall, 0.05],
  ]) {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, 2, hz)
        .setTranslation(x + Math.sign(x) * 0.05, 1, z + Math.sign(z) * 0.05)
        .setCollisionGroups((EDGE_WALL_GROUP << 16) | 0xffff),
    );
  }

  return mesh;
}
