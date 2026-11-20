import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { toonGradient } from '../render/toon';
import { rng } from '../world/noise';
import { WATER_Y } from '../world/shore';
import { ANIMAL_GROUP, terrainHeight } from '../world/terrain';
import { covers, hull, type Obstacle } from '../world/obstacles';
import { algaeSite, type Placement as AlgaePlacement } from '../world/algae';
import type { Placement as PlantPlacement } from '../world/plants';
import type { Kit } from '../lagoon/props';
import {
  BEACH_EDGE, beachLava, BULL_BEAT, COWS, CORMORANT_ROCKS, DISPLAY_ROCKS, FEMALE_SPOTS, fieldZ, PENGUIN_ROCKS, pointX, PUPS, shoreZ, START, SULK_SPOTS,
  TIDE_POOLS, westX,
} from './layout';

/**
 * The beach's props: the three display rocks on the lek (low, broad lava outcrops, their tops flat
 * enough to stand and display on), lava boulders along the west shore, the point and the field,
 * bleached driftwood along the top of the beach, saltbushes at the back of the field, and shell
 * grit over the sand. Rocks, driftwood and the bushes' woody bases are solid obstacles; the rest is
 * only drawn.
 */
const SEED = 53;
const BASALT = 0x5e5955;
const EDGE = BEACH_EDGE;
const Y = new THREE.Vector3(0, 1, 0);
const BUSH_BASE = { radius: 0.03, height: 0.06 };

export interface BeachProps {
  obstacles: Obstacle[];
  /** The display rocks' obstacles, by rock. */
  displayRocks: Obstacle[];
  /** The saltbushes' drawn crowns, which shade what's under them. */
  crowns: THREE.Object3D[];
}

/** Spots kept clear of props: where the animals lie, stand and walk. */
const KEEP = [
  ...COWS.map((c) => ({ x: c.x, z: c.z, r: 0.3 })),
  ...PUPS.map((c) => ({ x: c.x, z: c.z, r: 0.2 })),
  ...PENGUIN_ROCKS.map((c) => ({ x: c.x, z: c.z, r: 0.12 })),
  ...CORMORANT_ROCKS.map((c) => ({ x: c.x, z: c.z, r: 0.14 })),
  ...SULK_SPOTS.map((c) => ({ x: c.x, z: c.z, r: 0.25 })),
  ...FEMALE_SPOTS.map((c) => ({ x: c.x, z: c.z, r: 0.25 })),
  ...DISPLAY_ROCKS.map((c) => ({ x: c.x, z: c.z, r: c.r + 0.45 })),
  { x: START.x, z: START.z, r: START.r + 0.2 },
];

export function buildBeachProps(kit: Kit, scene: THREE.Scene, world: RAPIER.World): BeachProps {
  const need = (name: string) => {
    const g = kit.geometry.get(name);
    if (!g) throw new Error(`no prop mesh ${name}`);
    return g;
  };
  const rand = rng(SEED);
  const range = (a: number, b: number) => a + (b - a) * rand();
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const material = (tint: THREE.ColorRepresentation = 0xffffff) => new THREE.MeshToonMaterial({ vertexColors: true, color: tint, gradientMap: toonGradient() });
  const obstacles: Obstacle[] = [];
  const displayRocks: Obstacle[] = [];
  const crowns: THREE.Object3D[] = [];
  const yawQ = (yaw: number) => new THREE.Quaternion().setFromAxisAngle(Y, yaw);
  const inside = (x: number, z: number, r: number) => Math.abs(x) < EDGE - r && Math.abs(z) < EDGE - r;
  const free = (x: number, z: number, r: number) =>
    KEEP.every((k) => Math.hypot(x - k.x, z - k.z) > r + k.r) && !obstacles.some((o) => covers(o, x, z, r));
  const rockVariants = [...kit.geometry.keys()].filter((n) => n.startsWith('rock_'));
  const add = (o: Obstacle) => {
    o.mesh.name = o.name;
    o.mesh.castShadow = o.mesh.receiveShadow = true;
    scene.add(o.mesh);
    obstacles.push(o);
    return o;
  };
  const lowGround = (x: number, z: number, r: number) => {
    let low = terrainHeight(x, z);
    for (let k = 0; k < 8; k++) low = Math.min(low, terrainHeight(x + Math.cos(k) * r, z + Math.sin(k) * r));
    return low;
  };

  /**
   * A lava rock of footprint radius r at (x, z), squashed to `flat` of its height, its top standing
   * `top` (m) above the ground if given. A convex hull of its own mesh, so its faceted top is flat footing.
   */
  const rock = (variant: string, x: number, z: number, r: number, yaw: number, flat = 1, top?: number) => {
    const geometry = need(variant);
    const box = geometry.boundingBox!;
    const sc = r / Math.max(box.max.x, -box.min.x, box.max.z, -box.min.z);
    // Given a top, deep enough to sink well into the ground under it.
    const sy = top === undefined ? sc * flat : Math.max(sc * flat, (top + 0.04) / (box.max.y - box.min.y));
    const rot = yawQ(yaw);
    const ground = terrainHeight(x, z);
    const low = lowGround(x, z, r * 0.7);
    const tall = (box.max.y - box.min.y) * sy;
    const y = top === undefined ? low - box.min.y * sy - 0.2 * tall : ground + top - box.max.y * sy;
    const mesh = new THREE.Mesh(geometry, material(BASALT));
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(rot);
    mesh.scale.set(sc, sy, sc);
    const scaled = geometry.clone().scale(sc, sy, sc);
    const collider = world.createCollider(hull(scaled).setTranslation(x, y, z).setRotation(rot).setFriction(0.9));
    scaled.dispose();
    return add({ name: `rock-${obstacles.length}`, kind: 'rock', position: mesh.position, height: y + box.max.y * sy - ground, radius: r, mesh, collider });
  };

  // The display rocks: broad, low lava boulders, low enough to climb straight onto.
  for (const [i, d] of DISPLAY_ROCKS.entries()) {
    const o = rock(rockVariants[(i * 2 + 1) % rockVariants.length], d.x, d.z, d.r, d.yaw, 0.55, d.top);
    o.name = o.mesh.name = `display-rock-${i}`;
    displayRocks.push(o);
    // Broken blocks heaped round its foot, so it reads as a rough outcrop rather than one stone.
    for (let k = 0; k < 5; k++) {
      const a = d.yaw + (k / 5) * 2 * Math.PI + range(-0.4, 0.4);
      const rr = d.r * range(0.28, 0.45);
      const dd = d.r * range(0.85, 1.1);
      rock(pick(rockVariants), d.x + Math.sin(a) * dd, d.z + Math.cos(a) * dd, rr, range(0, 2 * Math.PI), range(0.45, 0.8), d.top * range(0.35, 0.7));
    }
  }

  const size = (small: number, big: number) => small + (big - small) * rand() ** 2.2;
  const scatter = (count: number, tries: number, spot: () => [number, number] | null, r: () => number) => {
    for (let i = 0, placed = 0; i < tries && placed < count; i++) {
      const p = spot();
      if (!p) continue;
      const rr = r();
      if (!inside(p[0], p[1], rr) || !free(p[0], p[1], rr * 0.8)) continue;
      rock(pick(rockVariants), p[0], p[1], rr, range(0, 2 * Math.PI), range(0.6, 1));
      placed++;
    }
  };
  // Boulders tumbled along the west shore and the point, and a few out on the field.
  scatter(14, 400, () => {
    const z = range(-4.6, 4.5);
    return [westX(z) - range(-0.05, 1.2), z];
  }, () => size(0.04, 0.14));
  scatter(12, 400, () => {
    const z = range(-4.5, 1.0);
    return [pointX(z) + range(0.05, 2.6), z];
  }, () => size(0.04, 0.13));
  scatter(10, 500, () => {
    const x = range(-4, 5);
    const z = range(fieldZ(x) + 0.4, 4.6);
    return [x, z];
  }, () => size(0.04, 0.12));
  // Tide pools stay open.
  for (const p of TIDE_POOLS) KEEP.push({ x: p.x, z: p.z, r: p.r + 0.05 });

  // Driftwood thrown up at the top of the beach, bleached silver.
  for (let i = 0, placed = 0; i < 2000 && placed < 4; i++) {
    const x = range(BULL_BEAT.x0 - 0.2, BULL_BEAT.x1 + 0.4);
    const z = range(shoreZ(x) + 1.4, fieldZ(x) - 0.05);
    const variant = pick(['driftwood_0', 'driftwood_1', 'driftwood_2']);
    const ex = kit.extras.get(variant) as { radius: number; tip: number; length: number } | undefined;
    if (!ex) break;
    const { radius: r, tip, length } = ex;
    const yaw = range(-0.6, 0.6);
    const axis = new THREE.Vector3(length / 2, 0, 0).applyAxisAngle(Y, yaw);
    const ends = [-1, -0.5, 0, 0.5, 1].map((t) => [x + axis.x * t, z + axis.z * t] as const);
    if (!ends.every(([ex2, ez]) => inside(ex2, ez, r) && free(ex2, ez, r + 0.05) && beachLava(ex2, ez) < 0.2)) continue;
    const y = Math.min(...ends.map(([ex2, ez]) => terrainHeight(ex2, ez))) - 0.2 * r;
    const rot = yawQ(yaw);
    const mesh = new THREE.Mesh(need(variant), material());
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(rot);
    const shape = new THREE.CylinderGeometry(tip, r, length, 14).rotateZ(-Math.PI / 2);
    const pos = shape.attributes.position;
    for (let k = 0; k < pos.count; k++) pos.setY(k, pos.getY(k) + r + (tip - r) * (pos.getX(k) / length + 0.5));
    const collider = world.createCollider(hull(shape).setTranslation(x, y, z).setRotation(rot).setFriction(0.9));
    add({ name: `driftwood-${obstacles.length}`, kind: 'log', position: mesh.position, height: y + 2 * r - terrainHeight(x, z), radius: r, axis, mesh, collider });
    placed++;
  }

  // Saltbushes along the back of the field and up the west side, drawn with a solid woody base.
  for (let i = 0, placed = 0; i < 3000 && placed < 9; i++) {
    const x = range(-5, 5);
    const z = range(2.6, 5.2);
    const variant = pick(['saltbush_0', 'saltbush_1']);
    const ex = kit.extras.get(variant) as { radius: number } | undefined;
    if (!ex) break;
    const sc = range(0.85, 1.2);
    const r = ex.radius * sc;
    if (!inside(x, z, r) || !free(x, z, r + 0.1)) continue;
    const y = lowGround(x, z, r * 0.5) - 0.005;
    const mesh = new THREE.Mesh(need(variant), material());
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(yawQ(range(0, 2 * Math.PI)));
    mesh.scale.setScalar(sc);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = `saltbush-${placed}`;
    scene.add(mesh);
    crowns.push(mesh);
    const half = BUSH_BASE.height / 2;
    const collider = world.createCollider(RAPIER.ColliderDesc.cylinder(half, BUSH_BASE.radius).setTranslation(x, y + half - 0.02, z).setFriction(0.9));
    const base = new THREE.Mesh(new THREE.BufferGeometry(), material());
    base.visible = false;
    obstacles.push({ name: `saltbush-${placed}-base`, kind: 'tree', position: new THREE.Vector3(x, y, z), height: BUSH_BASE.height, radius: BUSH_BASE.radius, mesh: base, collider });
    placed++;
  }

  // Loose clinker over the lava: small broken stones, drawn only. Each a jittered twenty-sided
  // lump (the boulders' meshes are too many triangles for thousands of these).
  const r2 = rng(SEED + 7);
  const stones = [0, 1, 2].map(() => {
    const g = new THREE.IcosahedronGeometry(1, 0).toNonIndexed();
    const pos = g.attributes.position;
    const moved = new Map<string, THREE.Vector3>();
    for (let k = 0; k < pos.count; k++) {
      const key = `${pos.getX(k).toFixed(3)},${pos.getY(k).toFixed(3)},${pos.getZ(k).toFixed(3)}`;
      if (!moved.has(key)) moved.set(key, new THREE.Vector3(pos.getX(k), pos.getY(k), pos.getZ(k)).multiplyScalar(0.7 + 0.5 * r2()));
      const p = moved.get(key)!;
      pos.setXYZ(k, p.x, p.y, p.z);
    }
    g.computeVertexNormals();
    return g;
  });
  const clinker: THREE.Matrix4[][] = [[], [], []];
  for (let i = 0; i < 40000 && clinker.reduce((n, l) => n + l.length, 0) < 3000; i++) {
    const x = -EDGE + r2() * 2 * EDGE;
    const z = -EDGE + r2() * 2 * EDGE;
    if (beachLava(x, z) < 0.9 || !free(x, z, 0.01)) continue;
    const y = terrainHeight(x, z);
    if (y < WATER_Y - 0.01) continue;
    const size = 0.003 + 0.012 * r2() ** 2;
    clinker[Math.floor(r2() * 3)].push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, y - 0.2 * size, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(r2() * 6.3, r2() * 6.3, r2() * 6.3)),
        new THREE.Vector3(size, size * (0.5 + 0.4 * r2()), size * (0.8 + 0.4 * r2())),
      ),
    );
  }
  const clinkerMaterial = new THREE.MeshToonMaterial({ color: 0x3c3836, gradientMap: toonGradient() });
  clinker.forEach((list, i) => {
    const mesh = new THREE.InstancedMesh(stones[i], clinkerMaterial, list.length);
    list.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.computeBoundingSphere();
    mesh.receiveShadow = true;
    mesh.name = `clinker-${i}`;
    scene.add(mesh);
  });

  // Shell and coral grit over the sand, thickest along the strand line.
  const grit: THREE.Matrix4[][] = [[], [], [], []];
  const g = rng(SEED + 5);
  for (let i = 0; i < 60000 && grit.reduce((n, l) => n + l.length, 0) < 9000; i++) {
    const x = -EDGE + g() * 2 * EDGE;
    const z = -EDGE + g() * 2 * EDGE;
    const s = z - shoreZ(x);
    if (s < 0.02 || z > fieldZ(x) + 0.1 || beachLava(x, z) > 0.3) continue;
    if (g() > 0.3 + 0.7 * Math.exp(-(((s - 0.25) / 0.25) ** 2))) continue;
    const y = terrainHeight(x, z);
    if (y < WATER_Y + 0.003) continue;
    grit[Math.floor(g() * 4)].push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler((g() - 0.5) * 0.6, g() * 6.3, (g() - 0.5) * 0.6)),
        new THREE.Vector3(1, 1, 1).multiplyScalar(0.6 + g() * 0.9),
      ),
    );
  }
  grit.forEach((list, i) => {
    const geometry = kit.geometry.get(`shell_${i}`);
    if (!geometry || !list.length) return;
    const mesh = new THREE.InstancedMesh(geometry, material(), list.length);
    list.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.computeBoundingSphere();
    mesh.receiveShadow = true;
    mesh.name = `shells-${i}`;
    scene.add(mesh);
  });
  return { obstacles, displayRocks, crowns };
}

/** Low plants: sea purslane (Sesuvium) in red mats on the field's edge and the top of the beach, and Tiquilia tufts out on the lava. */
export function beachPlants(open: (x: number, z: number) => boolean): PlantPlacement[] {
  const rand = rng(SEED + 9);
  const out: PlantPlacement[] = [];
  const range = (a: number, b: number) => a + (b - a) * rand();
  const ok = (x: number, z: number) =>
    Math.abs(x) < EDGE && Math.abs(z) < EDGE && terrainHeight(x, z) > WATER_Y + 0.02 && open(x, z) && KEEP.every((k) => Math.hypot(x - k.x, z - k.z) > k.r * 0.8) &&
    out.every((p) => Math.hypot(p.x - x, p.z - z) > 0.03);
  // Sesuvium in clumps along the top of the beach where it meets the lava.
  for (let c = 0; c < 22; c++) {
    const cx = range(-4.2, 4.6);
    const cz = fieldZ(cx) + range(-0.25, 0.5);
    for (let j = 0; j < 7; j++) {
      const a = range(0, 2 * Math.PI);
      const d = 0.12 * Math.sqrt(rand());
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      if (ok(x, z)) out.push({ kind: 'sesuvium', x, z, yaw: range(0, 2 * Math.PI), scale: range(0.7, 1.15) });
    }
  }
  for (let i = 0, n = 0; i < 2000 && n < 40; i++) {
    const x = range(-5, 5);
    const z = range(0.8, 5);
    if (beachLava(x, z) < 0.8 || !ok(x, z)) continue;
    out.push({ kind: 'tiquilia', x, z, yaw: range(0, 2 * Math.PI), scale: range(0.7, 1.1) });
    n++;
  }
  return out;
}

/**
 * Where the beach's algae grow: the island's sea lettuce and red turf, on the lava where it runs
 * into the water (the west shore, the point and the reef the lizard comes in on).
 */
export function beachAlgaeSites(): { first: AlgaePlacement[]; spare: AlgaePlacement[] } {
  const rand = rng(SEED + 13);
  const first: AlgaePlacement[] = [];
  const spare: AlgaePlacement[] = [];
  const taken: THREE.Vector3[] = [];
  const e = 0.01;
  const onLava = (x: number, z: number) => {
    const y = terrainHeight(x, z);
    const depth = WATER_Y - y;
    if (depth < 0.003 || depth > 0.08 || beachLava(x, z) < 0.3) return;
    const position = new THREE.Vector3(x, y - 0.001, z);
    if (taken.some((p) => p.distanceToSquared(position) < 0.045 * 0.045)) return;
    taken.push(position);
    const n = new THREE.Vector3(terrainHeight(x - e, z) - terrainHeight(x + e, z), 2 * e, terrainHeight(x, z - e) - terrainHeight(x, z + e)).normalize();
    (rand() < 0.55 ? first : spare).push(algaeSite((r) => (r < 0.55 ? 'red' : 'green'), position, n, rand));
  };
  for (let i = 0; i < 500; i++) {
    const z = range(-4.8, 1.5);
    onLava(westX(z) + range(-0.25, 0.05), z);
  }
  for (let i = 0; i < 500; i++) {
    const z = range(-4.8, 0);
    onLava(pointX(z) + range(-0.05, 0.25), z);
  }
  for (let i = 0; i < 200; i++) {
    const a = rand() * 2 * Math.PI;
    const d = START.r + range(-0.08, 0.12);
    onLava(START.x + Math.cos(a) * d, START.z + Math.sin(a) * d);
  }
  return { first, spare };

  function range(a: number, b: number) {
    return a + (b - a) * rand();
  }
}

/** Sea lion bodies are solid animals (`ANIMAL_GROUP`, like every creature's `SolidBody`): the lizard runs into them and can climb on. */
export const SEA_LION_GROUPS = (ANIMAL_GROUP << 16) | 0xffff;
