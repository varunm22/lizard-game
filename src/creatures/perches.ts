import * as THREE from 'three';
import { terrainHeight } from '../world/terrain';
import type { Obstacle } from '../world/obstacles';

/** Where the hawk can sit: its feet's spot on top of a rock or a tree, and the way it faces there. */
export interface Perch {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** The rock or tree it's on. */
  on: string;
}

/** How the perched hawk is drawn, measured off the model: what the perch has to leave room for. */
export interface PerchFit {
  /** How far its curled toes reach below its feet point (m). */
  sole: number;
  /** Its tail as points from the feet: [back, out to either side, up] (m). */
  tail: readonly (readonly [number, number, number])[];
}

/** How many perches of each kind, and how far apart (m). */
const ROCKS = 4;
const TREES = 3;
const APART = 1;
/** Rocks this high off the ground and out of the forest; trees and cactus no higher than this (m). */
const ROCK_MIN = 0.06;
const TREE_MAX = 1.7;
/** Feet planted on ground within this of level (m): the spot either side and in front of the feet. */
const FOOTING = { side: 0.008, ahead: 0.012, level: 0.004 };
/** The tail and the hawk's middle clear of anything by this much (m). */
const CLEAR = 0.002;
/** Up to this far the toes sink into the surface, gripping it (m). */
const GRIP = 0.001;
/** Spots on top of each candidate, this far apart (m), or fewer on a big one. */
const STEP = 0.012;
const GRID = 16;

/**
 * Perches: spots on the tallest rocks out of the forest (the rock piles' crests among them) and on
 * the lower trees and cactus at its edge and along the coast, at least a metre apart, the hawk facing
 * inland over the island from each as near as it can. A spot has to take its feet on the level, with
 * nothing rising in front of them, and leave room behind for its tail angled down and back: on a
 * rock that's near the edge with the drop behind it, on a tree the top of a pad or branch. Each is
 * found with rays onto the drawn meshes, so the toes rest on what you see.
 */
export function findPerches(obstacles: Obstacle[], forest: (x: number, z: number) => number, inland: { x: number; z: number }, fit: PerchFit): Perch[] {
  const meshes = obstacles.filter((o) => o.kind !== 'log').map((o) => o.mesh);
  for (const m of meshes) m.updateMatrixWorld(true);
  const boxes = meshes.map((m) => new THREE.Box3().setFromObject(m));
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const from = new THREE.Vector3();
  const near: THREE.Object3D[] = [];
  const hits: THREE.Intersection[] = [];
  /** The meshes near the candidate being weighed: the only ones `surface` looks at. */
  let local: number[] = [];
  /** The surface at (x, z): the top of whatever's drawn there, or the ground. */
  const surface = (x: number, z: number) => {
    near.length = 0;
    for (const i of local) {
      const b = boxes[i];
      if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) near.push(meshes[i]);
    }
    let y = terrainHeight(x, z);
    if (near.length) {
      ray.set(from.set(x, 10, z), down);
      hits.length = 0;
      const hit = ray.intersectObjects(near, false, hits)[0];
      if (hit) y = Math.max(y, hit.point.y);
    }
    return y;
  };

  /** Whether the hawk fits at (x, y, z) facing `face`: its feet on the level and its tail clear. */
  const seat = (x: number, z: number, y: number, face: number): boolean => {
    const fx = Math.sin(face);
    const fz = Math.cos(face);
    // The tail, tip first (it rules out most spots): every point of it clear of what's under it.
    const feet = y + fit.sole - GRIP;
    for (let i = fit.tail.length - 1; i >= 0; i--) {
      const [back, out, up] = fit.tail[i];
      for (const s of out > 0 ? [-1, 1] : [0]) {
        const tx = x - fx * back + fz * s * out;
        const tz = z - fz * back - fx * s * out;
        if (surface(tx, tz) > feet + up - CLEAR) return false;
      }
    }
    // Footing: level either side, nothing rising in front.
    for (const s of [-1, 1]) {
      if (Math.abs(surface(x + fz * s * FOOTING.side, z - fx * s * FOOTING.side) - y) > FOOTING.level) return false;
    }
    return surface(x + fx * FOOTING.ahead, z + fz * FOOTING.ahead) <= y + FOOTING.level;
  };

  /** The best spot on one rock or tree: as high as any, facing as near inland as it can. */
  const best = (o: Obstacle): Perch | null => {
    const box = boxes[meshes.indexOf(o.mesh)];
    const around = box.clone().expandByScalar(0.1);
    local = boxes.flatMap((b, i) => (b.intersectsBox(around) ? [i] : []));
    // Within the top quarter of what stands above the ground (a slab's mesh reaches well down into it).
    const low = box.max.y - 0.25 * (box.max.y - Math.max(box.min.y, terrainHeight(o.position.x, o.position.z)));
    const spots: { x: number; z: number; y: number }[] = [];
    // A grid of no more than about GRID spots a side over it, but no finer than STEP.
    const step = Math.max(STEP, Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / GRID);
    for (let x = box.min.x + step / 2; x < box.max.x; x += step) {
      for (let z = box.min.z + step / 2; z < box.max.z; z += step) {
        const y = surface(x, z);
        // On this one (not the ground or a neighbour beside it), within reach of its top.
        if (y > low && y <= box.max.y + 1e-6) spots.push({ x, z, y });
      }
    }
    spots.sort((a, b) => b.y - a.y);
    for (const s of spots) {
      const toward = Math.atan2(inland.x - s.x, inland.z - s.z);
      // Facing inland if it can, otherwise turning further and further round.
      for (let k = 0; k <= 8; k++) {
        const face = toward + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
        if (seat(s.x, s.z, s.y, face)) return { x: s.x, y: s.y + fit.sole - GRIP, z: s.z, yaw: face, on: o.name };
      }
    }
    return null;
  };

  const found: Perch[] = [];
  const take = (list: Obstacle[], count: number) => {
    let n = 0;
    for (const o of list) {
      if (n >= count) break;
      if (found.some((p) => Math.hypot(p.x - o.position.x, p.z - o.position.z) < APART)) continue;
      const p = best(o);
      if (!p) continue;
      found.push(p);
      n++;
    }
  };
  // Highest first, by what's drawn: a slab's recorded height runs from its bed.
  const top = (o: Obstacle) => boxes[meshes.indexOf(o.mesh)].max.y;
  take(
    obstacles.filter((o) => o.kind === 'rock' && o.height > ROCK_MIN && forest(o.position.x, o.position.z) < 0.3).sort((a, b) => top(b) - top(a)),
    ROCKS,
  );
  // Trees: the ones nearest the open island that aren't too tall to come down onto.
  take(
    obstacles
      .filter((o) => (o.kind === 'tree' || o.kind === 'cactus') && boxes[meshes.indexOf(o.mesh)].max.y < TREE_MAX)
      .sort((a, b) => forest(a.position.x, a.position.z) - forest(b.position.x, b.position.z) || Math.hypot(a.position.x - inland.x, a.position.z - inland.z) - Math.hypot(b.position.x - inland.x, b.position.z - inland.z)),
    TREES,
  );
  return found;
}
