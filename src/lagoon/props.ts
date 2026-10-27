import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { loadGltf } from '../render/gltf';
import { toonGradient } from '../render/toon';
import { rng } from '../world/noise';
import { WATER_Y } from '../world/shore';
import { CACTUS_GROUP, PLANT_STEM_GROUP, terrainHeight } from '../world/terrain';
import { covers, hull, type Obstacle } from '../world/obstacles';
import {
  acrossChannel, depthAt, FINISH, FRINGE, HERON_HAUNTS, inChannel, ISLETS, JAM, LAGOON_EDGE, lagoonLava, SAFE_POINTS, STANDS, START, westCoastX,
} from './layout';

/**
 * Scatters the lagoon's props: red mangroves on the mud hummocks and along the channel's west bank,
 * each standing on a cage of prop roots that are solid, one collider per root (`PLANT_STEM_GROUP`:
 * they stop the lizard and the herons but aren't ground to climb onto, and the camera sees through
 * them); young mangroves in the shallows; black mangroves at the back of the hummocks with their
 * breathing roots poking out of the mud round them; fallen propagules floating and stuck in the mud;
 * lava boulders on the knobs, the coast and the field; lava cactus on the field. More mangroves
 * stand outside the walls, drawn only, so the lagoon is walled in by forest.
 */
const SEED = 47;
const BASALT = 0x6c6763;
const DRIFTWOOD = 0xd9d4cc;
/** Mangrove trunks are solid this high (m): higher, nothing reaches them. */
const TRUNK_SOLID = 0.7;
const EDGE = LAGOON_EDGE;

export interface Kit {
  geometry: Map<string, THREE.BufferGeometry>;
  extras: Map<string, Record<string, unknown>>;
}

export async function loadKit(urls: string[]): Promise<Kit> {
  const kit: Kit = { geometry: new Map(), extras: new Map() };
  for (const url of urls) {
    const gltf = await loadGltf(url);
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.computeBoundingBox();
      kit.geometry.set(mesh.name, mesh.geometry);
      kit.extras.set(mesh.name, (mesh.userData ?? {}) as Record<string, unknown>);
    });
  }
  return kit;
}

/** A red mangrove as placed: where it stands, how far its roots reach (m) and its size. */
export interface Mangrove {
  name: string;
  x: number;
  y: number;
  z: number;
  reach: number;
  sapling: boolean;
}

export interface LagoonProps {
  obstacles: Obstacle[];
  mangroves: Mangrove[];
  /** Root colliders by handle, for sight lines that roots block. */
  roots: Set<number>;
  /** The drawn mangroves (instanced), which shade what's under them. */
  crowns: THREE.Object3D[];
}

const Y = new THREE.Vector3(0, 1, 0);
const UP = new THREE.Vector3(0, 1, 0);

export function buildLagoonProps(kit: Kit, scene: THREE.Scene, world: RAPIER.World): LagoonProps {
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
  const mangroves: Mangrove[] = [];
  const roots = new Set<number>();
  const hidden = material();
  hidden.visible = false;
  const yawQ = (yaw: number) => new THREE.Quaternion().setFromAxisAngle(Y, yaw);
  const inside = (x: number, z: number, r: number) => Math.abs(x) < EDGE - r && Math.abs(z) < EDGE - r;
  // The first three herons' spots, kept open as the props are scattered; the later herons' spots were
  // picked in the clearings this leaves, so the scatter (and its random draws) stays as it was.
  const spots = HERON_HAUNTS.slice(0, 3).flat();
  /** Room for a footprint of radius r at (x, z): clear of what's placed and the spots kept open. */
  const free = (x: number, z: number, r: number) =>
    Math.hypot(x - START.x, z - START.z) > r + 0.35 &&
    Math.hypot(x - FINISH.x, z - FINISH.z) > r + 0.1 &&
    Math.hypot(x - JAM.x, z - JAM.z) > r + 0.6 &&
    SAFE_POINTS.every((p) => Math.hypot(x - p.x, z - p.z) > r + p.r + 0.05) &&
    spots.every((s) => Math.hypot(x - s.x, z - s.z) > r + 0.18) &&
    !obstacles.some((o) => covers(o, x, z, r)) &&
    !mangroves.some((m) => Math.hypot(x - m.x, z - m.z) < r + m.reach * 0.8);

  // Mangroves: instanced by kind, each with its own colliders.
  const instances = new Map<string, THREE.Matrix4[]>();
  const draw = (kind: string, m: THREE.Matrix4) => instances.set(kind, [...(instances.get(kind) ?? []), m]);
  const stemGroups = (PLANT_STEM_GROUP << 16) | 0xffff;
  const mangrove = (kind: string, x: number, z: number, scale: number, solid: boolean) => {
    const ex = kit.extras.get(kind) as { trunk_radius: number; trunk_bottom: number; trunk_height: number; reach: number; roots: number[][] };
    const yaw = range(0, 2 * Math.PI);
    const y = terrainHeight(x, z) - 0.005;
    const rot = yawQ(yaw);
    draw(kind, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), rot, new THREE.Vector3(scale, scale, scale)));
    if (!solid) return;
    const name = `${kind.replace(/_/g, '-')}-${mangroves.length}`;
    mangroves.push({ name, x, y, z, reach: ex.reach * scale, sapling: kind === 'sapling' });
    // The trunk, from where the roots meet it up to beyond reach.
    const bottom = ex.trunk_bottom * scale;
    const top = Math.min(ex.trunk_height * scale, TRUNK_SOLID);
    const r = ex.trunk_radius * scale;
    const half = (top - bottom) / 2;
    const trunk = world.createCollider(RAPIER.ColliderDesc.cylinder(half, r).setTranslation(x, y + bottom + half, z).setFriction(0.9).setCollisionGroups(stemGroups));
    roots.add(trunk.handle);
    obstacles.push({ name, kind: 'tree', position: new THREE.Vector3(x, y, z), height: top, radius: r, mesh: new THREE.Mesh(new THREE.BufferGeometry(), hidden), collider: trunk });
    // Each root: a capsule along every other stretch of its curve.
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const place = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), rot, new THREE.Vector3(scale, scale, scale));
    for (const root of ex.roots) {
      const n = (root.length - 2) / 3;
      const rTop = root[root.length - 2] * scale;
      const rFoot = root[root.length - 1] * scale;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < n; i++) pts.push(new THREE.Vector3(root[i * 3], root[i * 3 + 1], root[i * 3 + 2]).applyMatrix4(place));
      const idx = [0, 2, 4, n - 1].filter((v, k, arr) => v < n && arr.indexOf(v) === k);
      for (let k = 0; k + 1 < idx.length; k++) {
        a.copy(pts[idx[k]]);
        b.copy(pts[idx[k + 1]]);
        // Don't bother with stretches deep in the mud.
        if (Math.max(a.y, b.y) < terrainHeight((a.x + b.x) / 2, (a.z + b.z) / 2) - 0.005) continue;
        const len = a.distanceTo(b);
        const rad = rTop + (rFoot - rTop) * ((idx[k] + idx[k + 1]) / 2 / (n - 1));
        q.setFromUnitVectors(UP, b.clone().sub(a).normalize());
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const c = world.createCollider(
          RAPIER.ColliderDesc.capsule(len / 2, rad).setTranslation(mid.x, mid.y, mid.z).setRotation(q).setFriction(0.8).setCollisionGroups(stemGroups),
        );
        roots.add(c.handle);
      }
    }
  };
  const reds = ['red_mangrove_0', 'red_mangrove_1', 'red_mangrove_2'];
  for (const s of STANDS) for (const [dx, dz] of s.trees) mangrove(pick(reds), s.x + dx, s.z + dz, range(0.9, 1.1), true);
  for (const f of FRINGE) if (inside(f.x, f.z, 0.1)) mangrove(pick(reds), f.x, f.z, range(0.85, 1.1), true);
  // Saplings out in the shallows.
  for (let i = 0, placed = 0; i < 4000 && placed < 16; i++) {
    const x = range(-4, 2.2);
    const z = range(-5.2, 5.2);
    const d = depthAt(x, z);
    if (d < 0.0 || d > 0.05 || inChannel(x, z) || acrossChannel(x, z) > -1.2 || lagoonLava(x, z) > 0.1 || !free(x, z, 0.2)) continue;
    mangrove('sapling', x, z, range(0.8, 1.2), true);
    placed++;
  }
  // The forest walling the lagoon in, outside the square: drawn only.
  for (let i = 0; i < 70; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const z = side * range(6.1, 8.5);
    const x = range(-6, 2.2);
    mangrove(pick(reds), x, z, range(1.0, 1.4), false);
  }

  // Black mangroves at the back of the hummocks and along the north and south edges.
  const pneus: THREE.Matrix4[] = [];
  const black = (x: number, z: number, solid: boolean) => {
    const ex = kit.extras.get('black_mangrove') as { trunk_radius: number; trunk_height: number };
    const sc = range(0.85, 1.2);
    const y = terrainHeight(x, z) - 0.01;
    draw('black_mangrove', new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), yawQ(range(0, 6.3)), new THREE.Vector3(sc, sc, sc)));
    // Breathing roots poking up out of the mud and shallows all round it.
    for (let k = 0; k < 90; k++) {
      const a = range(0, 2 * Math.PI);
      const d = 0.06 + 0.65 * Math.sqrt(rand());
      const px = x + Math.cos(a) * d;
      const pz = z + Math.sin(a) * d;
      const dep = depthAt(px, pz);
      if (dep > 0.04 || lagoonLava(px, pz) > 0.2 || inChannel(px, pz)) continue;
      const h = range(0.5, 1.2);
      pneus.push(new THREE.Matrix4().compose(new THREE.Vector3(px, terrainHeight(px, pz) - 0.004, pz), yawQ(range(0, 6.3)), new THREE.Vector3(1, h, 1)));
    }
    if (!solid) return;
    const r = ex.trunk_radius * sc;
    const half = TRUNK_SOLID / 2;
    const collider = world.createCollider(RAPIER.ColliderDesc.cylinder(half, r * 1.3).setTranslation(x, y + half, z).setFriction(0.9));
    obstacles.push({ name: `black-mangrove-${obstacles.length}`, kind: 'tree', position: new THREE.Vector3(x, y, z), height: TRUNK_SOLID, radius: r * 1.3, mesh: new THREE.Mesh(new THREE.BufferGeometry(), hidden), collider });
  };
  for (let i = 0, placed = 0; i < 3000 && placed < 9; i++) {
    const s = pick(STANDS.slice(1));
    const a = range(0, 2 * Math.PI);
    const x = s.x + Math.cos(a) * s.r * 0.85;
    const z = s.z + Math.sin(a) * s.r * 0.85;
    if (depthAt(x, z) > 0.0 || !inside(x, z, 0.1) || !free(x, z, 0.15)) continue;
    black(x, z, true);
    placed++;
  }
  for (let i = 0; i < 16; i++) black(range(-5.6, 2.0), (i % 2 ? 1 : -1) * range(5.55, 5.8), true);

  const crowns: THREE.Object3D[] = [];
  for (const [kind, list] of instances) {
    const mesh = new THREE.InstancedMesh(need(kind), material(), list.length);
    crowns.push(mesh);
    list.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.computeBoundingSphere();
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = `${kind}s`;
    scene.add(mesh);
  }
  const pneuMesh = new THREE.InstancedMesh(need('pneumatophore'), material(), pneus.length);
  pneus.forEach((m, k) => pneuMesh.setMatrixAt(k, m));
  pneuMesh.computeBoundingSphere();
  pneuMesh.receiveShadow = true;
  pneuMesh.name = 'pneumatophores';
  scene.add(pneuMesh);

  // Rocks: lava boulders, each a convex hull.
  const rockVariants = [...kit.geometry.keys()].filter((n) => n.startsWith('rock_'));
  const rock = (x: number, z: number, r: number, sink = 0.2) => {
    if (!inside(x, z, r) || !free(x, z, r * 0.8)) return false;
    const geometry = need(pick(rockVariants));
    const box = geometry.boundingBox!;
    const sc = r / Math.max(box.max.x, -box.min.x, box.max.z, -box.min.z);
    const rot = yawQ(range(0, 2 * Math.PI));
    let low = terrainHeight(x, z);
    for (let k = 0; k < 8; k++) low = Math.min(low, terrainHeight(x + Math.cos(k) * r * 0.6, z + Math.sin(k) * r * 0.6));
    const y = low - box.min.y * sc - sink * (box.max.y - box.min.y) * sc;
    const mesh = new THREE.Mesh(geometry, material(BASALT));
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(rot);
    mesh.scale.setScalar(sc);
    const scaled = geometry.clone().scale(sc, sc, sc);
    const collider = world.createCollider(hull(scaled).setTranslation(x, y, z).setRotation(rot).setFriction(0.9));
    scaled.dispose();
    const o: Obstacle = { name: `rock-${obstacles.length}`, kind: 'rock', position: mesh.position, height: y + box.max.y * sc - terrainHeight(x, z), radius: r, mesh, collider };
    o.mesh.name = o.name;
    o.mesh.castShadow = o.mesh.receiveShadow = true;
    scene.add(o.mesh);
    obstacles.push(o);
    return true;
  };
  const scatter = (count: number, tries: number, spot: () => [number, number, number] | null) => {
    for (let i = 0, placed = 0; i < tries && placed < count; i++) {
      const p = spot();
      if (p && rock(...p)) placed++;
    }
  };
  const size = (small: number, big: number) => small + (big - small) * rand() ** 2.5;
  for (const k of ISLETS) scatter(3, 40, () => {
    const a = range(0, 2 * Math.PI);
    const d = k.r * Math.sqrt(rand());
    return [k.x + Math.cos(a) * d, k.z + Math.sin(a) * d, size(0.03, 0.09)];
  });
  // Along the colony's coast, some tumbled into the water.
  scatter(40, 4000, () => {
    const z = range(-5.6, 5.6);
    const x = westCoastX(z) + range(-1.4, 0.25);
    return [x, z, size(0.03, 0.12)];
  });
  // Across the lava field, kept back from the channel's lip so nothing gives a swimmer a step up.
  scatter(45, 4000, () => {
    const z = range(-5.6, 5.6);
    const x = range(3.3, 5.8);
    return acrossChannel(x, z) > 1.6 ? [x, z, size(0.03, 0.14)] : null;
  });
  // A few half sunk in the basin.
  scatter(10, 2000, () => {
    const x = range(-4, 1.8);
    const z = range(-5, 5);
    const d = depthAt(x, z);
    return d > 0.02 && d < 0.12 && acrossChannel(x, z) < -1.5 ? [x, z, size(0.03, 0.07)] : null;
  });

  // Lava cactus on the field.
  const cactusEx = kit.extras.get('lava_cactus') as { trunk_radius: number; trunk_height: number };
  for (let i = 0, placed = 0; i < 3000 && placed < 12; i++) {
    const x = range(3.4, 5.8);
    const z = range(-5.6, 5.6);
    if (acrossChannel(x, z) < 1.8 || !free(x, z, 0.08)) continue;
    const sc = range(0.85, 1.15);
    const y = terrainHeight(x, z) - 0.01;
    const mesh = new THREE.Mesh(need('lava_cactus'), material());
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(yawQ(range(0, 6.3)));
    mesh.scale.setScalar(sc);
    mesh.castShadow = mesh.receiveShadow = true;
    const half = (cactusEx.trunk_height * sc + 0.05) / 2;
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cylinder(half, cactusEx.trunk_radius * sc).setTranslation(x, y - 0.05 + half, z).setFriction(0.9).setCollisionGroups((CACTUS_GROUP << 16) | 0xffff),
    );
    const o: Obstacle = { name: `lava-cactus-${obstacles.length}`, kind: 'cactus', position: mesh.position, height: cactusEx.trunk_height * sc, radius: cactusEx.trunk_radius * sc, mesh, collider };
    mesh.name = o.name;
    scene.add(mesh);
    obstacles.push(o);
    placed++;
  }

  // Bleached driftwood stranded on the mud, here and there.
  for (let i = 0, placed = 0; i < 3000 && placed < 5; i++) {
    const x = range(-4.2, 2);
    const z = range(-5.2, 5.2);
    const variant = pick(['log_1', 'log_2']);
    const { radius: r, length } = kit.extras.get(variant) as { radius: number; length: number };
    const yaw = range(0, Math.PI);
    const axis = new THREE.Vector3(length / 2, 0, 0).applyAxisAngle(Y, yaw);
    const ends = [-1, -0.5, 0, 0.5, 1].map((t) => [x + axis.x * t, z + axis.z * t] as const);
    if (!ends.every(([ex, ez]) => inside(ex, ez, r) && free(ex, ez, r + 0.05) && depthAt(ex, ez) < -0.002 && !inChannel(ex, ez))) continue;
    const y = Math.min(...ends.map(([ex, ez]) => terrainHeight(ex, ez))) - 0.2 * r;
    const rot = yawQ(yaw);
    const mesh = new THREE.Mesh(need(variant), material(DRIFTWOOD));
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(rot);
    const shape = new THREE.CylinderGeometry(r, r, length, 14).rotateZ(Math.PI / 2).translate(0, r, 0);
    const collider = world.createCollider(hull(shape).setTranslation(x, y, z).setRotation(rot).setFriction(0.9));
    const o: Obstacle = { name: `driftwood-${obstacles.length}`, kind: 'log', position: mesh.position, height: y + 2 * r - terrainHeight(x, z), radius: r, axis, mesh, collider };
    mesh.name = o.name;
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    obstacles.push(o);
    placed++;
  }

  // Propagules: floating flat in the shallows, and stuck upright in the mud where they took root.
  const props: THREE.Matrix4[] = [];
  for (let i = 0, placed = 0; i < 6000 && placed < 90; i++) {
    const x = range(-4.2, 2.3);
    const z = range(-5.6, 5.6);
    const d = depthAt(x, z);
    if (inChannel(x, z) || lagoonLava(x, z) > 0.1 || d > 0.15) continue;
    const upright = d < 0.02 && rand() < 0.6;
    const y = upright ? terrainHeight(x, z) - 0.03 : Math.max(terrainHeight(x, z) + 0.004, WATER_Y - 0.002);
    const rot = upright
      ? new THREE.Quaternion().setFromEuler(new THREE.Euler(range(-0.15, 0.15), range(0, 6.3), range(-0.15, 0.15)))
      : new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, range(0, 6.3), 'YXZ'));
    props.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), rot, new THREE.Vector3(1, 1, 1)));
    placed++;
  }
  const propMesh = new THREE.InstancedMesh(need('propagule'), material(), props.length);
  props.forEach((m, k) => propMesh.setMatrixAt(k, m));
  propMesh.computeBoundingSphere();
  propMesh.name = 'propagules';
  scene.add(propMesh);

  return { obstacles, mangroves, roots, crowns };
}
