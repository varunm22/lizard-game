import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PALETTE } from '../render/scene';
import { toonGradient } from '../render/toon';
import { terrainHeight } from './terrain';
import { POND, WATER_Y } from './pond';

export interface Obstacle {
  name: string;
  position: THREE.Vector3;
  /** Height of its top above the ground beneath its centre (m). */
  height: number;
  mesh: THREE.Mesh;
  collider: RAPIER.Collider;
}

/**
 * Placeholder obstacles until the props step: a few rocks and a fallen log, fixed in place and sunk
 * a little into the terrain. Each collider is the convex hull of its own mesh, so what you see is
 * what you stand on, and the faceted tops give flat footing instead of a ball to slide off. Sized
 * against the jump (0.1 m): the pebble, mid rock and log can be jumped onto, the big rock only with a
 * well-timed running jump. Two more sit in the pond: a boulder sunk in the deep middle, and an
 * island whose top is just low enough to climb out onto from the water.
 */
/** The rock island's top stands this far out of the water: low enough to climb onto from a swim. */
const ISLAND_TOP = 0.025;

export function buildObstacles(scene: THREE.Scene, world: RAPIER.World): Obstacle[] {
  const obstacles: Obstacle[] = [];
  const stone = new THREE.MeshToonMaterial({ color: PALETTE.stone, gradientMap: toonGradient() });
  const bark = new THREE.MeshToonMaterial({ color: PALETTE.bark, gradientMap: toonGradient() });

  const place = (
    name: string,
    mesh: THREE.Mesh,
    collider: RAPIER.ColliderDesc,
    x: number,
    z: number,
    lift: number,
    rot = new THREE.Quaternion(),
  ) => {
    const pos = new THREE.Vector3(x, terrainHeight(x, z) + lift, z);
    mesh.position.copy(pos);
    mesh.quaternion.copy(rot);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = name;
    scene.add(mesh);
    const c = world.createCollider(collider.setTranslation(pos.x, pos.y, pos.z).setRotation(rot).setFriction(0.9));
    return { position: pos, mesh, collider: c };
  };

  // Rocks are squashed icosahedra: [name, x, z, radius, height scale, depth sunk into the ground].
  for (const [name, x, z, r, squash, sink] of [
    ['rock-big', -0.45, -0.35, 0.09, 0.9, 0.04],
    ['rock-mid', 0.4, -0.5, 0.05, 0.7, 0.01],
    ['pebble', 0.25, 0.3, 0.025, 0.6, 0.006],
    ['rock-sunk', POND.x - 0.1, POND.z + 0.1, 0.15, 0.7, 0.03],
    ['rock-island', POND.x + 0.42, POND.z - 0.27, 0.1, 0.8, null],
  ] as const) {
    const half = r * squash;
    // The island (no depth given) is sunk into the bed as far as it takes to leave its top ISLAND_TOP above the water.
    const lift = half - (sink ?? terrainHeight(x, z) + 2 * half - (WATER_Y + ISLAND_TOP));
    const geometry = new THREE.IcosahedronGeometry(r, 1).scale(1, squash, 1);
    // Each obstacle gets its own material so the camera can fade it on its own.
    const placed = place(name, new THREE.Mesh(geometry, stone.clone()), hull(geometry), x, z, lift);
    obstacles.push({ name, ...placed, height: lift + half });
  }

  const logR = 0.035;
  const logLen = 0.6;
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
  const lay = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const logRot = yaw.clone().multiply(lay);
  // 14 sides laid on their side leave a flat face on top.
  const logGeometry = new THREE.CylinderGeometry(logR, logR, logLen, 14);
  const log = place(
    'log',
    new THREE.Mesh(logGeometry, bark),
    hull(logGeometry),
    0,
    -0.6,
    logR - 0.004,
    logRot,
  );
  obstacles.push({ name: 'log', ...log, height: 2 * logR - 0.004 });

  return obstacles;
}

function hull(geometry: THREE.BufferGeometry): RAPIER.ColliderDesc {
  const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(geometry.getAttribute('position').array));
  if (!desc) throw new Error('convex hull failed');
  return desc;
}
