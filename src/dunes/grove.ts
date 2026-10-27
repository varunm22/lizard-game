import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { loadGltf } from '../render/gltf';
import { toonGradient } from '../render/toon';
import { rng } from '../world/noise';
import { WATER_Y } from '../world/shore';
import { terrainHeight } from '../world/terrain';
import { covers, type Obstacle } from '../world/obstacles';
import { COLONY, duneShoreX, RACER_HOMES } from './layout';

/** Its own random numbers, so it moves nothing else. */
const SEED = 83;
/** Where the grove stands (world m): on the shore south of the colony, where the walk-in heads. */
export const GROVE = { x0: 2.8, x1: 5.4, z0: -5.8, z1: COLONY.z - 2.2 };
const TREES = 18;
/** Trunk colliders reach this far into the ground, as on the island. */
const ROOT_DEPTH = 0.05;

/**
 * The edge of the island's forest, south of the colony along the shore: tree daisies (Scalesia)
 * behind and palo santo toward the colony, the island's own trees (props.glb), so that walking on
 * from the colony at the end of the run looks like walking into the island, the next stage. Solid
 * trunks, like the island's; added after everything else is placed, so nothing else moves.
 */
export async function buildGrove(url: string, scene: THREE.Scene, world: RAPIER.World, obstacles: Obstacle[]) {
  const gltf = await loadGltf(url);
  const kit = new Map<string, { geometry: THREE.BufferGeometry; extras: Record<string, number> }>();
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) kit.set(mesh.name, { geometry: mesh.geometry, extras: (mesh.userData ?? {}) as Record<string, number> });
  });
  const rand = rng(SEED);
  const range = (a: number, b: number) => a + (b - a) * rand();
  const material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });
  const placed: { x: number; z: number }[] = [];
  for (let i = 0; i < 3000 && placed.length < TREES; i++) {
    const x = range(GROVE.x0, GROVE.x1);
    const z = range(GROVE.z0, GROVE.z1);
    if (x > duneShoreX(z) - 0.35 || terrainHeight(x, z) < WATER_Y + 0.03) continue;
    if (RACER_HOMES.some((h) => Math.hypot(h.x - x, h.z - z) < 0.5)) continue;
    if (placed.some((t) => Math.hypot(t.x - x, t.z - z) < 0.45) || obstacles.some((o) => covers(o, x, z, 0.15))) continue;
    // Tree daisies deeper in, palo santo at the edge nearest the colony.
    const edge = (z - GROVE.z0) / (GROVE.z1 - GROVE.z0);
    const kind = rand() < 0.1 + 0.35 * edge ? 'palo_santo' : 'scalesia';
    const variant = kit.has(kind) ? kind : `${kind}_${Math.floor(rand() * 2)}`;
    const item = kit.get(variant);
    if (!item) throw new Error(`props.glb has no ${variant}`);
    const { trunk_radius: r, trunk_height: h } = item.extras;
    const s = range(0.85, 1.15);
    let y = terrainHeight(x, z);
    for (let k = 0; k < 8; k++) y = Math.min(y, terrainHeight(x + Math.cos(k * 0.785) * r * s, z + Math.sin(k * 0.785) * r * s));
    y -= 0.01;
    const mesh = new THREE.Mesh(item.geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = range(0, 2 * Math.PI);
    mesh.scale.setScalar(s);
    const half = (h * s + ROOT_DEPTH) / 2;
    const collider = world.createCollider(RAPIER.ColliderDesc.cylinder(half, r * s).setTranslation(x, y - ROOT_DEPTH + half, z).setFriction(0.9));
    const name = `grove-${kind.replace('_', '-')}-${placed.length}`;
    mesh.name = name;
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    obstacles.push({ name, kind: 'tree', position: mesh.position, height: h * s, radius: r * s, mesh, collider });
    placed.push({ x, z });
  }
}
