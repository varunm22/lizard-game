import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadGltf } from '../render/gltf';
import { toonGradient } from '../render/toon';
import { rng } from './noise';
import { BEACH_PATH, forestCover, lavaCover, sandCover, shoreDistance, SPAWN } from './layout';
import { rockyShore, WATER_Y } from './shore';
import { TERRAIN_SIZE, terrainHeight } from './terrain';
import { covers, hull, type Obstacle } from './obstacles';

/**
 * Scatters the island's props from assets-src/props.py: trees through the forest and along the back
 * of the coast, fallen logs and mossy rocks under the trees, black lava boulders over the beach, the
 * rocky shore and the sea floor off it, and lava cactus on the bare lava. Each one inside the walls
 * is solid (an obstacle the camera fades out when it's in the way); trees beyond the walls are only a
 * backdrop for the fog.
 */
const SEED = 41;

/** Tints multiplied over the props' grey rock: black basalt by the sea, mossy grey in the forest. */
const ROCK_TINT = { basalt: 0x6c6763, forest: 0xc2c9a8 } as const;

/** Trunk colliders reach this far into the ground, so a tree on a slope has no gap under its uphill side (m). */
const ROOT_DEPTH = 0.05;

interface Kit {
  geometry: Map<string, THREE.BufferGeometry>;
  extras: Map<string, Record<string, number>>;
}

export interface PropsResult {
  obstacles: Obstacle[];
  /** The algae meshes, for `Algae` to grow on the rocks. */
  algae: { green: THREE.BufferGeometry; red: THREE.BufferGeometry };
}

export async function buildProps(url: string, scene: THREE.Scene, world: RAPIER.World, landmarks: readonly Obstacle[]): Promise<PropsResult> {
  const gltf = await loadGltf(url);
  const kit: Kit = { geometry: new Map(), extras: new Map() };
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    kit.geometry.set(mesh.name, mesh.geometry);
    kit.extras.set(mesh.name, (mesh.userData ?? {}) as Record<string, number>);
  });
  const need = (name: string) => {
    const g = kit.geometry.get(name);
    if (!g) throw new Error(`props.glb has no ${name}`);
    return g;
  };

  const rand = rng(SEED);
  const range = (a: number, b: number) => a + (b - a) * rand();
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const obstacles: Obstacle[] = [];
  const material = (tint: THREE.ColorRepresentation = 0xffffff) =>
    new THREE.MeshToonMaterial({ vertexColors: true, color: tint, gradientMap: toonGradient() });
  const edge = TERRAIN_SIZE / 2 - 0.15;
  const inside = (x: number, z: number, r: number) => Math.abs(x) < edge - r && Math.abs(z) < edge - r;
  /** Room for a footprint of radius r at (x, z): clear of everything placed and the spawn point. */
  const free = (x: number, z: number, r: number, gap = 0.03) =>
    Math.hypot(x - SPAWN.x, z - SPAWN.z) > r + 0.3 &&
    !(z + r > BEACH_PATH.z0 && z - r < BEACH_PATH.z1 && shoreDistance(x, z) > BEACH_PATH.from) &&
    ![...landmarks, ...obstacles].some((o) => covers(o, x, z, r + gap));
  /** Lowest ground within r of (x, z), so nothing hangs over a dip. */
  const lowGround = (x: number, z: number, r: number) => {
    let low = terrainHeight(x, z);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * 2 * Math.PI;
      low = Math.min(low, terrainHeight(x + Math.cos(a) * r, z + Math.sin(a) * r));
    }
    return low;
  };
  const add = (o: Obstacle) => {
    o.mesh.name = o.name;
    o.mesh.castShadow = o.mesh.receiveShadow = true;
    scene.add(o.mesh);
    obstacles.push(o);
  };
  const yawQ = (yaw: number) => new THREE.Quaternion().setFromAxisAngle(Y, yaw);

  // Trees: a solid upright trunk, out of reach of any jump.
  const trees: { x: number; z: number }[] = [];
  const tree = (kind: string, x: number, z: number, solid: boolean, instances?: Map<string, THREE.Matrix4[]>) => {
    const variant = kit.geometry.has(kind) ? kind : `${kind}_${Math.floor(rand() * 2)}`;
    const geometry = need(variant);
    const { trunk_radius: r, trunk_height: h } = kit.extras.get(variant)!;
    const s = range(0.85, 1.15);
    const y = lowGround(x, z, r * s) - 0.01;
    const rot = yawQ(range(0, 2 * Math.PI));
    trees.push({ x, z });
    if (!solid) {
      const list = instances!.get(variant) ?? [];
      list.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), rot, new THREE.Vector3(s, s, s)));
      instances!.set(variant, list);
      return;
    }
    const mesh = new THREE.Mesh(geometry, material());
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(rot);
    mesh.scale.setScalar(s);
    const half = (h * s + ROOT_DEPTH) / 2;
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cylinder(half, r * s).setTranslation(x, y - ROOT_DEPTH + half, z).setFriction(0.9),
    );
    add({ name: `${kind}-${obstacles.length}`, kind: kind === 'lava_cactus' ? 'cactus' : 'tree', position: mesh.position, height: h * s, radius: r * s, mesh, collider });
  };
  const treeSpacing = (x: number, z: number, d: number) => trees.every((t) => Math.hypot(t.x - x, t.z - z) > d);

  // The forest: tree daisies deep in, palo santo toward its edges.
  for (let i = 0, placed = 0; i < 4000 && placed < 34; i++) {
    const x = range(-edge, 1.4);
    const z = range(-edge, edge);
    const cover = forestCover(x, z);
    if (cover < 0.55 || !inside(x, z, 0.15) || !treeSpacing(x, z, 0.62) || !free(x, z, 0.15, 0.1)) continue;
    tree(cover > 0.9 && (x < -2.1 || z < -2.2) && rand() < 0.75 ? 'scalesia' : 'palo_santo', x, z, true);
    placed++;
  }
  // Prickly pear trees along the back of the beach and on the lava, and palo santo now and then.
  for (let i = 0, placed = 0; i < 3000 && placed < 10; i++) {
    const z = range(-edge, edge);
    const x = range(0.6, 2.2);
    const s = shoreDistance(x, z);
    if (s > -0.75 || s < -1.6 || forestCover(x, z) > 0.3 || !inside(x, z, 0.15) || !treeSpacing(x, z, 0.7) || !free(x, z, 0.15, 0.1)) continue;
    tree(rand() < 0.75 ? 'opuntia' : 'palo_santo', x, z, true);
    placed++;
  }
  // Beyond the walls: more forest fading into the fog, drawn as one instanced mesh per kind.
  const backdrop = new Map<string, THREE.Matrix4[]>();
  for (let i = 0, placed = 0; i < 6000 && placed < 45; i++) {
    const x = range(-9, 3);
    const z = range(-9, 9);
    if (inside(x, z, -0.3) || shoreDistance(x, z) > -1 || !treeSpacing(x, z, 0.8)) continue;
    const cover = forestCover(x, z);
    tree(cover > 0.6 ? (rand() < 0.6 ? 'scalesia' : 'palo_santo') : rand() < 0.6 ? 'opuntia' : 'palo_santo', x, z, false, backdrop);
    placed++;
  }
  for (const [variant, list] of backdrop) {
    const mesh = new THREE.InstancedMesh(need(variant), material(), list.length);
    list.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.computeBoundingSphere();
    mesh.name = `backdrop-${variant}`;
    scene.add(mesh);
  }

  // Fallen logs on the forest floor, lying where they fell.
  for (let i = 0, placed = 0; i < 2000 && placed < 8; i++) {
    const x = range(-edge, 1.2);
    const z = range(-edge, edge);
    if (forestCover(x, z) < 0.6) continue;
    const variant = pick(['log_0', 'log_0', 'log_1', 'log_2']);
    const { radius: r, length } = kit.extras.get(variant)!;
    const yaw = range(0, Math.PI);
    const axis = new THREE.Vector3(length / 2, 0, 0).applyAxisAngle(Y, yaw);
    const ends = [-1, -0.5, 0, 0.5, 1].map((t) => [x + axis.x * t, z + axis.z * t] as const);
    if (!ends.every(([ex, ez]) => inside(ex, ez, r) && free(ex, ez, r, 0.08) && forestCover(ex, ez) > 0.4)) continue;
    // Bedded into the ground along its length, by a little of its radius.
    const y = Math.min(...ends.map(([ex, ez]) => terrainHeight(ex, ez))) - 0.15 * r;
    const rot = yawQ(yaw);
    const mesh = new THREE.Mesh(need(variant), material());
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(rot);
    const shape = new THREE.CylinderGeometry(r, r, length, 14).rotateZ(Math.PI / 2).translate(0, r, 0);
    const collider = world.createCollider(hull(shape).setTranslation(x, y, z).setRotation(rot).setFriction(0.9));
    add({ name: `log-${obstacles.length}`, kind: 'log', position: mesh.position, height: y + 2 * r - terrainHeight(x, z), radius: r, axis, mesh, collider });
    placed++;
  }

  // Rocks: lava boulders, each a convex hull, sunk a little into whatever they sit on.
  const rockVariants = [...kit.geometry.keys()].filter((n) => n.startsWith('rock_'));
  const rock = (x: number, z: number, r: number, tint: THREE.ColorRepresentation, sink = 0.15) => {
    if (!inside(x, z, r) || !free(x, z, r * 0.8, 0.01)) return false;
    const variant = pick(rockVariants);
    const geometry = need(variant);
    const box = geometry.boundingBox!;
    const s = r / Math.max(box.max.x, -box.min.x, box.max.z, -box.min.z);
    const rot = yawQ(range(0, 2 * Math.PI));
    const y = lowGround(x, z, r * 0.6) - box.min.y * s - sink * (box.max.y - box.min.y) * s;
    const mesh = new THREE.Mesh(geometry, material(tint));
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(rot);
    mesh.scale.setScalar(s);
    const scaled = geometry.clone().scale(s, s, s);
    const collider = world.createCollider(hull(scaled).setTranslation(x, y, z).setRotation(rot).setFriction(0.9));
    scaled.dispose();
    add({ name: `rock-${obstacles.length}`, kind: 'rock', position: mesh.position, height: y + box.max.y * s - terrainHeight(x, z), radius: r, mesh, collider });
    return true;
  };
  /** Try up to `tries` spots from `spot()` until `count` rocks are down. */
  const scatter = (count: number, tries: number, spot: () => [number, number, number] | null, tint: THREE.ColorRepresentation) => {
    for (let i = 0, placed = 0; i < tries && placed < count; i++) {
      const s = spot();
      if (s && rock(s[0], s[1], s[2], tint)) placed++;
    }
  };
  /** A random spot between the clearing and the east wall, z between zFrom and zTo, with its distance from the waterline. */
  const coastal = (zFrom = -edge, zTo = edge) => {
    const z = range(zFrom, zTo);
    const x = range(0.3, edge);
    return [x, z, shoreDistance(x, z)] as const;
  };
  /** Rock radius: mostly small, now and then a boulder. */
  const size = (small: number, big: number) => small + (big - small) * rand() ** 2.5;

  // Over the beach: scattered, often in little groups, with a few right at the water's edge.
  scatter(26, 2000, () => {
    const [x, z] = coastal();
    return sandCover(x, z) > 0.6 && shoreDistance(x, z) < -0.05 ? [x, z, size(0.025, 0.11)] : null;
  }, ROCK_TINT.basalt);
  scatter(8, 1000, () => {
    const [x, z, s] = coastal(-0.2, 2.4);
    return s > -0.12 && s < 0.25 && rockyShore(z) < 0.3 ? [x, z, size(0.04, 0.12)] : null;
  }, ROCK_TINT.basalt);
  // The rocky shore: boulders strewn over the lava and tumbled down into the water.
  scatter(34, 3000, () => {
    const [x, z, s] = coastal();
    return lavaCover(x, z) > 0.6 && s < -0.03 && s > -1.2 ? [x, z, size(0.03, 0.16)] : null;
  }, ROCK_TINT.basalt);
  scatter(55, 4000, () => {
    const [x, z, s] = coastal();
    return rockyShore(z) > 0.6 && s > -0.02 && s < 1.5 ? [x, z, size(0.04, 0.2)] : null;
  }, ROCK_TINT.basalt);
  // A few out on the sandy bottom off the beach.
  scatter(6, 600, () => {
    const [x, z, s] = coastal(-0.2, 2.4);
    return s > 0.5 && s < 1.6 && rockyShore(z) < 0.2 ? [x, z, size(0.06, 0.16)] : null;
  }, ROCK_TINT.basalt);
  // Mossy rocks in the forest.
  scatter(14, 1500, () => {
    const x = range(-edge, 1.2);
    const z = range(-edge, edge);
    return forestCover(x, z) > 0.6 ? [x, z, size(0.04, 0.16)] : null;
  }, ROCK_TINT.forest);

  // Lava cactus in clumps on the bare lava above the water.
  for (let i = 0, placed = 0; i < 1500 && placed < 12; i++) {
    const [x, z, s] = coastal();
    if (lavaCover(x, z) < 0.7 || s > -0.15 || terrainHeight(x, z) < WATER_Y + 0.01) continue;
    if (!inside(x, z, 0.06) || !free(x, z, 0.05, 0.02)) continue;
    tree('lava_cactus', x, z, true);
    placed++;
  }

  return { obstacles, algae: { green: need('algae_green'), red: need('algae_red') } };
}

const Y = new THREE.Vector3(0, 1, 0);
