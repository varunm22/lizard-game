import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { toonGradient } from '../render/toon';
import { carvePond, nearPond, WATER_Y } from './pond';

/** Side of the walkable square (m). The physics heightfield covers exactly this. */
export const TERRAIN_SIZE = 4;
/** Cells per side of the physics heightfield: 4 m / 128 = ~3 cm, a fifth of a lizard. */
const CELLS = 128;
/** The drawn ground extends past the walkable square so the clearing's rim fades into the fog. */
const VISUAL_SIZE = 8;
const SEED = 7;
/** Collision group bit carried by the invisible edge walls, so the camera can see past them. */
export const EDGE_WALL_GROUP = 0x0002;

/** Lattice value noise in [-1, 1], smooth-stepped between integer points. */
function valueNoise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash(xi, zi);
  const b = hash(xi + 1, zi);
  const c = hash(xi, zi + 1);
  const d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function hash(x: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(SEED, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h & 0xffff) / 0x7fff - 1;
}

const smoothstep = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/**
 * Ground height (m) at a world position. Layered noise, damped to almost flat in the middle of the
 * clearing so there's an easy play area, with gentle swells further out, a bank rising at the rim,
 * and the pond carved in.
 */
export function terrainHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const swell = valueNoise(x / 1.3 + 11, z / 1.3 - 4) * 0.05;
  const bumps = valueNoise(x / 0.35 - 7, z / 0.35 + 3) * 0.012;
  const grit = valueNoise(x / 0.09 + 2, z / 0.09 + 9) * 0.003;
  const calm = 0.25 + 0.75 * smoothstep(0.35, 1.1, r);
  const t = Math.max(0, r - 1.5);
  const bank = t < 1 ? 0.3 * t * t : 0.3 + 0.6 * (t - 1);
  return carvePond(x, z, (swell + bumps) * calm + grit + bank);
}

/** Approximate surface normal from the height function, for colouring. */
function slopeAt(x: number, z: number): number {
  const e = 0.02;
  const dx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e);
  const dz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
  return Math.hypot(dx, dz);
}

const GRASS = new THREE.Color(0x8fb36a);
const MOSS = new THREE.Color(0x6f9a55);
const DIRT = new THREE.Color(0xa88e68);
/** Wet sand at the waterline, darkening to silt on the pond bed. */
const SAND = new THREE.Color(0xc4b08a);
const SILT = new THREE.Color(0x6e7a5c);

/** Build the toon-shaded ground mesh and its Rapier heightfield collider, plus walls at the edge. */
export function buildTerrain(scene: THREE.Scene, world: RAPIER.World) {
  const segments = (CELLS * VISUAL_SIZE) / TERRAIN_SIZE;
  const geo = new THREE.PlaneGeometry(VISUAL_SIZE, VISUAL_SIZE, segments, segments).rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = terrainHeight(x, z);
    pos.setY(i, y);
    // Moss in the hollows, bare dirt where the noise says so or the ground gets steep.
    const patch = valueNoise(x / 0.5 + 31, z / 0.5 - 17);
    c.copy(GRASS).lerp(MOSS, smoothstep(-0.2, 0.5, valueNoise(x / 0.8 - 5, z / 0.8 + 21)));
    c.lerp(DIRT, Math.max(smoothstep(0.25, 0.6, patch), smoothstep(0.35, 0.8, slopeAt(x, z))));
    if (nearPond(x, z)) {
      c.lerp(SAND, smoothstep(WATER_Y + 0.008, WATER_Y + 0.002, y)).lerp(SILT, smoothstep(WATER_Y - 0.01, WATER_Y - 0.06, y));
    }
    c.toArray(colors, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() }),
  );
  mesh.receiveShadow = true;
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
  const half = TERRAIN_SIZE / 2 - 0.1;
  for (const [x, z, hx, hz] of [
    [half, 0, 0.05, half],
    [-half, 0, 0.05, half],
    [0, half, half, 0.05],
    [0, -half, half, 0.05],
  ]) {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, 2, hz)
        .setTranslation(x + Math.sign(x) * 0.05, 1, z + Math.sign(z) * 0.05)
        .setCollisionGroups((EDGE_WALL_GROUP << 16) | 0xffff),
    );
  }

  return mesh;
}
