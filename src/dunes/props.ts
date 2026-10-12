import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { loadGltf } from '../render/gltf';
import { toonGradient } from '../render/toon';
import { rng } from '../world/noise';
import { WATER_Y } from '../world/shore';
import { CACTUS_GROUP, terrainHeight } from '../world/terrain';
import { covers, hull, type Obstacle } from '../world/obstacles';
import { Bushes } from './bushes';
import { BURROWS, COLONY, cove, duneLava, duneSand, duneShoreX, KNOLLS, NEST, RACER_HOMES } from './layout';

/**
 * Scatters the nesting dunes' props: black lava boulders on the knolls, along the flows and over
 * the shore rocks and into the sea; lava cactus on bare lava; bleached driftwood along the strand
 * line; saltbushes on the sand (`Bushes`, hiding places from the snakes); red mangroves at the back
 * of the sandy cove; the hatchling's torn eggshells in its burrow and others at a few burrows
 * hatched before it; and shell and coral grit strewn over the sand. Rocks, cactus, driftwood, the
 * mangroves and each saltbush's woody base are solid obstacles; the rest is only drawn.
 */
const SEED = 61;

/** Tints over the props' grey rock and bark: black basalt, and driftwood bleached silver by sun and salt. */
const BASALT = 0x6c6763;
const DRIFTWOOD = 0xd9d4cc;
/** A saltbush's woody base: a solid cylinder this wide and high (m) under the canopy's middle. */
const BUSH_BASE = { radius: 0.03, height: 0.08 };

/** Kept clear of props (m): round the nest, the finish, each snake's coil and each burrow mouth. */
const CLEAR = { nest: 0.45, colony: 0.1, racer: 0.22, burrow: 0.13 };
const EDGE = 3.85;

interface Kit {
  geometry: Map<string, THREE.BufferGeometry>;
  extras: Map<string, Record<string, number>>;
}

async function loadKit(url: string, kit: Kit) {
  const gltf = await loadGltf(url);
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    kit.geometry.set(mesh.name, mesh.geometry);
    kit.extras.set(mesh.name, (mesh.userData ?? {}) as Record<string, number>);
  });
}

export interface DunesProps {
  obstacles: Obstacle[];
  bushes: Bushes;
}

export async function buildDuneProps(propsUrl: string, dunesUrl: string, scene: THREE.Scene, world: RAPIER.World): Promise<DunesProps> {
  const kit: Kit = { geometry: new Map(), extras: new Map() };
  await loadKit(propsUrl, kit);
  await loadKit(dunesUrl, kit);
  const need = (name: string) => {
    const g = kit.geometry.get(name);
    if (!g) throw new Error(`no prop mesh ${name}`);
    return g;
  };
  const rand = rng(SEED);
  const range = (a: number, b: number) => a + (b - a) * rand();
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const material = (tint: THREE.ColorRepresentation = 0xffffff) =>
    new THREE.MeshToonMaterial({ vertexColors: true, color: tint, gradientMap: toonGradient() });
  const obstacles: Obstacle[] = [];
  const bushes = new Bushes();
  const inside = (x: number, z: number, r: number) => Math.abs(x) < EDGE - r && Math.abs(z) < EDGE - r;
  const s = (x: number, z: number) => x - duneShoreX(z);
  /** Room for a footprint of radius r at (x, z): clear of everything placed and the spots kept open. */
  const free = (x: number, z: number, r: number, gap = 0.03) =>
    Math.hypot(x - NEST.x, z - NEST.z) > r + CLEAR.nest &&
    Math.hypot(x - COLONY.x, z - COLONY.z) > r + CLEAR.colony &&
    RACER_HOMES.every((h) => Math.hypot(x - h.x, z - h.z) > r + CLEAR.racer) &&
    BURROWS.every((b) => Math.hypot(x - b.x, z - b.z) > r + CLEAR.burrow) &&
    !obstacles.some((o) => covers(o, x, z, r + gap)) &&
    !bushes.list.some((b) => Math.hypot(x - b.x, z - b.z) < r + b.radius * 0.6);
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

  // Rocks: lava boulders, each a convex hull, sunk a little into the ground.
  const rockVariants = [...kit.geometry.keys()].filter((n) => n.startsWith('rock_'));
  const rock = (x: number, z: number, r: number, sink = 0.15) => {
    if (!inside(x, z, r) || !free(x, z, r * 0.8, 0.01)) return false;
    const geometry = need(pick(rockVariants));
    const box = geometry.boundingBox!;
    const sc = r / Math.max(box.max.x, -box.min.x, box.max.z, -box.min.z);
    const rot = yawQ(range(0, 2 * Math.PI));
    const y = lowGround(x, z, r * 0.6) - box.min.y * sc - sink * (box.max.y - box.min.y) * sc;
    const mesh = new THREE.Mesh(geometry, material(BASALT));
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(rot);
    mesh.scale.setScalar(sc);
    const scaled = geometry.clone().scale(sc, sc, sc);
    const collider = world.createCollider(hull(scaled).setTranslation(x, y, z).setRotation(rot).setFriction(0.9));
    scaled.dispose();
    add({ name: `rock-${obstacles.length}`, kind: 'rock', position: mesh.position, height: y + box.max.y * sc - terrainHeight(x, z), radius: r, mesh, collider });
    return true;
  };
  const scatter = (count: number, tries: number, spot: () => [number, number, number] | null) => {
    for (let i = 0, placed = 0; i < tries && placed < count; i++) {
      const p = spot();
      if (p && rock(...p)) placed++;
    }
  };
  const size = (small: number, big: number) => small + (big - small) * rand() ** 2.5;
  const anywhere = () => [range(-EDGE, EDGE), range(-EDGE, EDGE)] as const;

  // Round and on top of each knoll: a crown of boulders, the snakes' cover.
  for (const k of KNOLLS) {
    scatter(5, 60, () => {
      const a = range(0, 2 * Math.PI);
      const d = k.r * Math.sqrt(rand()) * 1.05;
      return [k.x + Math.cos(a) * d, k.z + Math.sin(a) * d, size(0.03, 0.13)];
    });
  }
  // Along the flows and over the shore rocks, tumbled into the water.
  scatter(26, 2500, () => {
    const [x, z] = anywhere();
    return duneLava(x, z) > 0.7 && s(x, z) < -0.9 ? [x, z, size(0.03, 0.12)] : null;
  });
  scatter(40, 3000, () => {
    const [x, z] = anywhere();
    return x > 0.8 && duneLava(x, z) > 0.6 && s(x, z) > -0.9 && s(x, z) < -0.04 ? [x, z, size(0.03, 0.15)] : null;
  });
  scatter(30, 3000, () => {
    const [x, z] = anywhere();
    return x > 1.5 && cove(z) < 0.3 && s(x, z) > -0.03 && s(x, z) < 1.3 ? [x, z, size(0.04, 0.2)] : null;
  });
  // A few loose ones out on the sand.
  scatter(10, 1500, () => {
    const [x, z] = anywhere();
    return duneSand(x, z) > 0.95 && x > -2.6 && s(x, z) < -0.2 ? [x, z, size(0.02, 0.06)] : null;
  });

  // Upright plants with a solid stem: lava cactus on the bare lava, mangroves at the back of the cove.
  const tree = (kind: string, x: number, z: number, tint?: THREE.ColorRepresentation) => {
    const geometry = need(kind);
    const { trunk_radius: r, trunk_height: h } = kit.extras.get(kind)!;
    const sc = range(0.85, 1.15);
    const y = lowGround(x, z, r * sc) - 0.01;
    const mesh = new THREE.Mesh(geometry, material(tint));
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(yawQ(range(0, 2 * Math.PI)));
    mesh.scale.setScalar(sc);
    const half = (h * sc + 0.05) / 2;
    const cactus = kind === 'lava_cactus';
    const desc = RAPIER.ColliderDesc.cylinder(half, r * sc).setTranslation(x, y - 0.05 + half, z).setFriction(0.9);
    if (cactus) desc.setCollisionGroups((CACTUS_GROUP << 16) | 0xffff);
    const collider = world.createCollider(desc);
    add({ name: `${kind.replace('_', '-')}-${obstacles.length}`, kind: cactus ? 'cactus' : 'tree', position: mesh.position, height: h * sc, radius: r * sc, mesh, collider });
  };
  for (let i = 0, placed = 0; i < 2000 && placed < 12; i++) {
    const [x, z] = anywhere();
    if (duneLava(x, z) < 0.8 || terrainHeight(x, z) < WATER_Y + 0.015 || !inside(x, z, 0.06) || !free(x, z, 0.06, 0.03)) continue;
    tree('lava_cactus', x, z);
    placed++;
  }
  for (let i = 0, placed = 0; i < 800 && placed < 3; i++) {
    const z = range(0.7, 1.7);
    const x = duneShoreX(z) - range(0.3, 0.65);
    if (cove(z) < 0.8 || !free(x, z, 0.3, 0.05)) continue;
    tree('mangrove', x, z);
    placed++;
  }

  // Driftwood thrown up along the strand line, bleached silver.
  for (let i = 0, placed = 0; i < 1500 && placed < 6; i++) {
    const z = range(-3.4, 3.4);
    const x = duneShoreX(z) - range(0.12, 0.6);
    const variant = pick(['log_0', 'log_1', 'log_1', 'log_2']);
    const { radius: r, length } = kit.extras.get(variant)!;
    const yaw = range(-0.6, 0.6) + Math.PI / 2;
    const axis = new THREE.Vector3(length / 2, 0, 0).applyAxisAngle(Y, yaw);
    const ends = [-1, -0.5, 0, 0.5, 1].map((t) => [x + axis.x * t, z + axis.z * t] as const);
    if (!ends.every(([ex, ez]) => inside(ex, ez, r) && free(ex, ez, r, 0.05) && terrainHeight(ex, ez) > WATER_Y + 0.01)) continue;
    const y = Math.min(...ends.map(([ex, ez]) => terrainHeight(ex, ez))) - 0.2 * r;
    const rot = yawQ(yaw);
    const mesh = new THREE.Mesh(need(variant), material(DRIFTWOOD));
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(rot);
    const shape = new THREE.CylinderGeometry(r, r, length, 14).rotateZ(Math.PI / 2).translate(0, r, 0);
    const collider = world.createCollider(hull(shape).setTranslation(x, y, z).setRotation(rot).setFriction(0.9));
    add({ name: `driftwood-${obstacles.length}`, kind: 'log', position: mesh.position, height: y + 2 * r - terrainHeight(x, z), radius: r, axis, mesh, collider });
    placed++;
  }

  // Saltbushes over the sand: scattered through the dunes and thicker at the back of the shore.
  for (let i = 0, placed = 0; i < 4000 && placed < 16; i++) {
    const x = range(-2.7, 1.9);
    const z = range(-3.5, 3.5);
    const variant = pick(['saltbush_0', 'saltbush_1']);
    const ex = kit.extras.get(variant)!;
    const sc = range(0.85, 1.25);
    const r = ex.radius * sc;
    if (duneSand(x, z) < 0.98 || s(x, z) > -0.35 || !inside(x, z, r) || !free(x, z, r * 0.7, 0.05)) continue;
    // Keep them apart, so open sand runs between.
    if (bushes.list.some((b) => Math.hypot(b.x - x, b.z - z) < b.radius + r + 0.35)) continue;
    // Not in a slip face: they grow where the sand is settled.
    if (Math.abs(terrainHeight(x + 0.1, z) - terrainHeight(x - 0.1, z)) > 0.05 || Math.abs(terrainHeight(x, z + 0.1) - terrainHeight(x, z - 0.1)) > 0.05) continue;
    const y = lowGround(x, z, r * 0.5) - 0.005;
    const mesh = new THREE.Mesh(need(variant), material());
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(yawQ(range(0, 2 * Math.PI)));
    mesh.scale.setScalar(sc);
    mesh.castShadow = mesh.receiveShadow = true;
    const name = `saltbush-${bushes.list.length}`;
    mesh.name = name;
    scene.add(mesh);
    bushes.add({ name, x, y, z, radius: r, height: ex.height * sc, rim: ex.rim * sc, mesh });
    // Its woody base is solid.
    const half = BUSH_BASE.height / 2;
    const collider = world.createCollider(RAPIER.ColliderDesc.cylinder(half, BUSH_BASE.radius).setTranslation(x, y + half - 0.02, z).setFriction(0.9));
    const base = new THREE.Mesh(new THREE.BufferGeometry(), material());
    base.visible = false;
    obstacles.push({ name: `${name}-base`, kind: 'tree', position: new THREE.Vector3(x, y, z), height: BUSH_BASE.height, radius: BUSH_BASE.radius, mesh: base, collider });
    placed++;
  }

  // Eggshells: the lizard's own, in its burrow, and a few at burrows that hatched before it.
  const shells: THREE.Matrix4[][] = [[], []];
  const shellAt = (x: number, z: number, yaw: number) => {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, terrainHeight(x, z) - 0.002, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(range(-0.3, 0.3), yaw, range(-0.4, 0.4))),
      new THREE.Vector3(1, 1, 1).multiplyScalar(range(0.85, 1.1)),
    );
    shells[Math.floor(rand() * 2)].push(m);
  };
  const nest = BURROWS[0];
  shellAt(nest.x - Math.sin(nest.yaw) * -0.01 + 0.012, nest.z + 0.02, range(0, 6));
  shellAt(nest.x + 0.03, nest.z - 0.035, range(0, 6));
  for (const b of BURROWS.slice(1)) {
    if (rand() > 0.35) continue;
    // Out on the spoil in front of the mouth.
    const back = -0.12;
    shellAt(b.x + Math.sin(b.yaw) * back + range(-0.03, 0.03), b.z + Math.cos(b.yaw) * back + range(-0.03, 0.03), range(0, 6));
  }
  shells.forEach((list, i) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(need(`eggshell_${i}`), material(), list.length);
    list.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.computeBoundingSphere();
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = `eggshells-${i}`;
    scene.add(mesh);
  });

  // Shell and coral grit over the sand, thicker toward the shore.
  const grit: THREE.Matrix4[][] = [[], [], [], []];
  const g = rng(SEED + 5);
  for (let i = 0; i < 26000 && grit.reduce((n, l) => n + l.length, 0) < 7000; i++) {
    const x = -EDGE + g() * 2 * EDGE;
    const z = -EDGE + g() * 2 * EDGE;
    const shore = THREE.MathUtils.smoothstep(x, -2.5, 1.8);
    if (g() > 0.25 + 0.75 * shore || duneSand(x, z) < 0.9) continue;
    const y = terrainHeight(x, z);
    if (y < WATER_Y + 0.004) continue;
    grit[Math.floor(g() * 4)].push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler((g() - 0.5) * 0.6, g() * 6.3, (g() - 0.5) * 0.6)),
        new THREE.Vector3(1, 1, 1).multiplyScalar(0.6 + g() * 0.9),
      ),
    );
  }
  grit.forEach((list, i) => {
    const mesh = new THREE.InstancedMesh(need(`shell_${i}`), material(), list.length);
    list.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.computeBoundingSphere();
    mesh.receiveShadow = true;
    mesh.name = `grit-${i}`;
    scene.add(mesh);
  });

  return { obstacles, bushes };
}

const Y = new THREE.Vector3(0, 1, 0);
