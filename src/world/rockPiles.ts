import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { ROCK_PILES } from './layout';
import { shoreX, WATER_Y } from './shore';
import { terrainHeight } from './terrain';
import { hull, type Obstacle } from './obstacles';

/**
 * Rock piles: heaps of lava slabs on the rocky shore that run from the land out into the sea, like
 * the tumbled breakwaters marine iguanas and Sally Lightfoot crabs crowd onto. Each slab is its own
 * convex obstacle with a near-flat top. Their tops follow the pile's shape: a crest a few lizard
 * lengths in from the waterline, falling away to the sides and down to a last step just out of the
 * water at the far end. Along the spine, neighbouring tops never differ by more than the lizard can
 * climb in one go, so it can walk up from the land or climb out of the sea and go all the way up.
 */

/**
 * Spacing of the level slabs down the pile's spine (m): each step's tread is a body length or more,
 * since the lizard only climbs onto a top it can lie down on. The slabs are wider than this, so
 * they overlap.
 */
const SPINE_STEP = 0.15;
/** Slabs off the spine keep their centres this fraction of their two half-widths apart, so they overlap a little. */
const OVERLAP = 0.8;
/** The first slab stands this far above the ground at the land end (m), an easy step. */
const FIRST_STEP = 0.03;
/** The last slab, at the sea end, stands this far out of the water (m): low enough to climb out onto. */
const LAST_STEP = 0.022;
/** Where along the pile (0 land end, 1 sea end) the crest is. */
const CREST_AT = 0.42;
/** Slabs are pushed this far into the ground or sea bed below them (m). */
const BED = 0.02;
/** Random rise or fall of each slab's top (m), small enough to keep every step climbable. */
const JITTER = 0.01;
/** Thickness of one layer of slabs in a stack (m), and the most layers a stack gets. */
const LAYER = 0.07;
const MAX_LAYERS = 4;

/** Tint over the slabs' grey: the same black basalt as the shore boulders. */
const TINT = 0x6c6763;

export interface SlabKit {
  geometry: THREE.BufferGeometry[];
  /** Top and base height of each slab mesh, in its own units. */
  extent: { top: number; bottom: number }[];
}

/**
 * Height of the pile's top surface at a point given as `u` along its spine (0 at the land end, 1 at
 * the sea end) and `v` across it (-1 to 1 from one edge to the other), above the water.
 */
function crest(u: number, v: number, peak: number, start: number): number {
  // Straight ramps up to the crest and down to the sea, so every step along the spine rises about the same.
  const along = u < CREST_AT ? start + ((peak - start) * u) / CREST_AT : LAST_STEP + ((peak - LAST_STEP) * (1 - u)) / (1 - CREST_AT);
  return along * (1 - v * v);
}

export function buildRockPiles(
  kit: SlabKit,
  scene: THREE.Scene,
  world: RAPIER.World,
  rand: () => number,
  material: (tint: THREE.ColorRepresentation) => THREE.Material,
): Obstacle[] {
  const obstacles: Obstacle[] = [];
  for (const pile of ROCK_PILES) {
    const x0 = shoreX(pile.z) + pile.from;
    const x1 = shoreX(pile.z) + pile.to;
    const length = x1 - x0;
    const start = terrainHeight(x0, pile.z) - WATER_Y + FIRST_STEP;
    const placed: { x: number; z: number; w: number }[] = [];
    const slab = (u: number, v: number, x: number, z: number, onSpine: boolean) => {
      const ground = terrainHeight(x, z);
      const top = WATER_Y + crest(u, v, pile.peak, start) + (rand() - 0.5) * 2 * JITTER;
      if (top < ground + 0.012) return;
      // Bigger slabs where the pile is tall, so the heap broadens toward its base; a few big ones anywhere.
      const r = onSpine ? 0.13 + 0.02 * rand() : 0.06 + 0.06 * Math.min(1, (top - ground) / 0.3) + 0.05 * rand() ** 3;
      const w = 0.8 * r; // the slab meshes reach ~0.8 of their unit radius
      if (!onSpine && placed.some((p) => Math.hypot(p.x - x, p.z - z) < OVERLAP * (p.w + w))) return;
      placed.push({ x, z, w });
      // Stack slabs from the bed up to the top, each a flat layer a few cm thick, the lower ones wider
      // and pushed off-centre, so the column reads as a heap of fallen blocks; the top layer sets
      // the footing. Deep under water the bottom layer just takes up whatever is left.
      const base = ground - BED;
      const layers = Math.min(MAX_LAYERS, Math.max(1, Math.round((top - base) / LAYER)));
      const thick = Math.min(LAYER, (top - base) / layers);
      for (let l = 0; l < layers; l++) {
        const above = layers - 1 - l; // layers above this one
        const lTop = top - above * thick;
        const lBase = l === 0 ? base : lTop - thick;
        const lr = r * (1 + 0.18 * above) * (0.9 + 0.2 * rand());
        const lx = x + (above ? (rand() - 0.5) * 0.5 * r : 0);
        const lz = z + (above ? (rand() - 0.5) * 0.5 * r : 0);
        const level = !above && onSpine;
        addSlab(lx, lz, lTop, lBase, lr, level ? 0.03 : (0.05 + 0.15 * Math.abs(v)) * rand(), v, top - ground);
      }
    };
    const addSlab = (x: number, z: number, top: number, base: number, r: number, tip: number, v: number, height: number) => {
      const k = Math.floor(rand() * kit.geometry.length);
      const { top: t, bottom: b } = kit.extent[k];
      const sy = (top - base) / (t - b);
      const scale = new THREE.Vector3(r, sy, r);
      // Slabs on the flanks lie tipped outward and down, as if tumbled; the spine stays level.
      const rot = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(1, 0, 0), tip * (v >= 0 ? 1 : -1))
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * 2 * Math.PI));
      const position = new THREE.Vector3(x, top - t * sy, z);
      const shade = 0.85 + 0.3 * rand();
      const mesh = new THREE.Mesh(kit.geometry[k], material(new THREE.Color(TINT).multiplyScalar(shade)));
      mesh.position.copy(position);
      mesh.quaternion.copy(rot);
      mesh.scale.copy(scale);
      mesh.name = `${pile.name}-${obstacles.length}`;
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      const scaled = kit.geometry[k].clone().scale(scale.x, scale.y, scale.z);
      const collider = world.createCollider(hull(scaled).setTranslation(x, position.y, z).setRotation(rot).setFriction(0.9));
      scaled.dispose();
      obstacles.push({ name: mesh.name, kind: 'rock', position, height, radius: 0.8 * r, mesh, collider });
    };
    // The spine first: a row of level slabs every SPINE_STEP, the climbing route up and over.
    const rows = Math.round(length / SPINE_STEP);
    for (let i = 0; i <= rows; i++) {
      const u = i / rows;
      slab(u, 0, x0 + u * length, pile.z + (rand() - 0.5) * 0.02, true);
    }
    // Then the flanks, filled in at random wherever there's room.
    for (let n = 0; n < 900; n++) {
      const u = rand();
      const v = rand() * 2 - 1;
      slab(u, v, x0 + u * length, pile.z + v * pile.width, false);
    }
  }
  return obstacles;
}
