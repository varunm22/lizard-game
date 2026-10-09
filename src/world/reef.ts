import * as THREE from 'three';
import { loadGltf } from '../render/gltf';
import { toonGradient } from '../render/toon';
import { rng } from './noise';
import { coralShare, rockyShore, WATER_Y } from './shore';
import { TERRAIN_SIZE, terrainHeight } from './terrain';
import { covers, type Obstacle } from './obstacles';

/**
 * Corals, urchins and sea stars on the sea floor, from assets-src/reef.py. The shallows are the
 * algae's (`algae.ts`); coral comes in below them and thickens with depth (`SEA_ZONES`, with a band
 * where the two mix): cauliflower coral (Pocillopora) and lobe coral (Porites) bushes and domes, sea
 * fans standing broadside to the swell, and orange sun corals at the foot of sunken boulders. Pencil
 * urchins and cushion stars live at any depth, among the algae too, on the bottom and the rocks.
 * Most of it is on the rocky bottom off the lava, a little off the beach. Drawn, not simulated, like the algae: no colliders, the lizard swims
 * through them. Deterministic, from their own random numbers, so nothing else on the island moves.
 */
export type CoralKind = 'coral_cauliflower' | 'coral_lobe' | 'sea_fan' | 'sun_coral' | 'urchin' | 'sea_star';

export interface Coral {
  kind: CoralKind;
  x: number;
  y: number;
  z: number;
  /** Height of its top (m). */
  top: number;
}

const SEED = 71;
/** Batches per kind and per TILE of sea (m), so the camera skips those out of view. */
const TILE = 2;
/** Sea fans tinted per fan: purple, orange, yellow, red, as Pacifigorgia comes. */
const FAN_TINTS = [0xa050b0, 0xe87a3a, 0xe8c048, 0xc8404a, 0x9a48a8];

interface Rule {
  kind: CoralKind;
  count: number;
  /** Footprint radius at scale 1 (m), to keep apart, and the shallowest water it grows in below its top (m). */
  radius: number;
  clearance: number;
  /** Chance to keep a spot off the sandy beach rather than the rocky shore. */
  onSand: number;
  /** Coral keeps to the deep (`coralShare`); urchins and sea stars live in the shallows too. */
  deep: boolean;
}

const FLOOR: Rule[] = [
  { kind: 'coral_cauliflower', count: 75, radius: 0.04, clearance: 0.04, onSand: 0.35, deep: true },
  { kind: 'coral_lobe', count: 36, radius: 0.05, clearance: 0.05, onSand: 0.2, deep: true },
  { kind: 'sea_fan', count: 36, radius: 0.025, clearance: 0.03, onSand: 0.3, deep: true },
  { kind: 'urchin', count: 30, radius: 0.015, clearance: 0.03, onSand: 0, deep: false },
  { kind: 'sea_star', count: 22, radius: 0.02, clearance: 0.03, onSand: 0.5, deep: false },
];
const SUN_CORALS = 36;
const ROCK_URCHINS = 24;

const UP = new THREE.Vector3(0, 1, 0);

/** Every mesh in reef.glb by name, with its glTF extras: the corals here and the fish in `creatures/fish.ts`. */
export async function loadReefKit(url: string) {
  const gltf = await loadGltf(url);
  const geometry = new Map<string, THREE.BufferGeometry>();
  const extras = new Map<string, Record<string, number>>();
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometry.set(mesh.name, mesh.geometry);
    extras.set(mesh.name, (mesh.userData ?? {}) as Record<string, number>);
  });
  return { geometry, extras };
}

export const CORAL_KINDS: readonly CoralKind[] = ['coral_cauliflower', 'coral_lobe', 'sea_fan', 'sun_coral', 'urchin', 'sea_star'];

export class Reef {
  readonly corals: Coral[] = [];
  private uniforms = { uTime: { value: 0 } };

  /** `rocks` are the obstacles (boulders out in the water get sun corals and urchins); `taken` says where algae already grow. */
  constructor(scene: THREE.Scene, kit: Map<string, THREE.BufferGeometry>, rocks: readonly Obstacle[], taken: (x: number, z: number) => boolean) {
    const geometry = {} as Record<CoralKind, THREE.BufferGeometry>;
    for (const kind of CORAL_KINDS) {
      const g = kit.get(kind);
      if (!g) throw new Error(`reef.glb has no ${kind}`);
      geometry[kind] = g;
    }
    const rand = rng(SEED);
    const range = (a: number, b: number) => a + (b - a) * rand();
    const placed: { x: number; z: number; r: number }[] = [];
    const edge = TERRAIN_SIZE / 2 - 0.15;
    const free = (x: number, z: number, r: number) =>
      Math.abs(x) < edge && Math.abs(z) < edge && placed.every((p) => Math.hypot(p.x - x, p.z - z) > p.r + r) && !rocks.some((o) => covers(o, x, z, r)) && !taken(x, z);
    const items = new Map<string, { kind: CoralKind; matrix: THREE.Matrix4; tint: THREE.Color }[]>();
    const add = (kind: CoralKind, position: THREE.Vector3, normal: THREE.Vector3, yaw: number, scale: number, tint: THREE.Color) => {
      const q = new THREE.Quaternion()
        .setFromUnitVectors(UP, normal.clone().lerp(UP, 0.5).normalize())
        .multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
      const matrix = new THREE.Matrix4().compose(position, q, new THREE.Vector3(scale, scale, scale));
      const key = `${kind},${Math.floor(position.x / TILE)},${Math.floor(position.z / TILE)}`;
      const list = items.get(key) ?? [];
      list.push({ kind, matrix, tint });
      items.set(key, list);
      const box = geometry[kind].boundingBox!;
      this.corals.push({ kind, x: position.x, y: position.y, z: position.z, top: position.y + box.max.y * scale });
    };
    for (const g of Object.values(geometry)) g.computeBoundingBox();
    const normalAt = (x: number, z: number) => {
      const e = 0.01;
      return new THREE.Vector3(terrainHeight(x - e, z) - terrainHeight(x + e, z), 2 * e, terrainHeight(x, z - e) - terrainHeight(x, z + e)).normalize();
    };

    // On the sea floor.
    for (const rule of FLOOR) {
      const height = geometry[rule.kind].boundingBox!.max.y;
      for (let i = 0, n = 0; i < rule.count * 60 && n < rule.count; i++) {
        const x = range(1.4, edge);
        const z = range(-edge, edge);
        const s = range(0.75, 1.25);
        const y = terrainHeight(x, z);
        if (WATER_Y - y < height * s + rule.clearance) continue;
        if (rule.deep && rand() > coralShare(WATER_Y - y)) continue;
        if (rockyShore(z) < 0.5 && rand() > rule.onSand) continue;
        if (!free(x, z, rule.radius * s)) continue;
        placed.push({ x, z, r: rule.radius * s });
        // Sea fans stand broadside to the swell rolling in from the east.
        const yaw = rule.kind === 'sea_fan' ? Math.PI / 2 + range(-0.35, 0.35) : range(0, 2 * Math.PI);
        const tint = rule.kind === 'sea_fan' ? new THREE.Color(FAN_TINTS[Math.floor(rand() * FAN_TINTS.length)]) : new THREE.Color().setScalar(range(0.85, 1.1));
        add(rule.kind, new THREE.Vector3(x, y - 0.002, z), normalAt(x, z), yaw, s, tint);
        n++;
      }
    }

    // Out in the water: sun corals at the foot of boulders, urchins on their tops.
    const wet = rocks.filter((o) => o.kind === 'rock' && WATER_Y - terrainHeight(o.position.x, o.position.z) > 0.06);
    if (wet.length) {
      for (let i = 0, n = 0; i < SUN_CORALS * 30 && n < SUN_CORALS; i++) {
        const o = wet[Math.floor(rand() * wet.length)];
        const a = range(0, 2 * Math.PI);
        const x = o.position.x + Math.cos(a) * o.radius * 0.95;
        const z = o.position.z + Math.sin(a) * o.radius * 0.95;
        const y = terrainHeight(x, z);
        const s = range(0.8, 1.3);
        if (rand() > coralShare(WATER_Y - y) || taken(x, z) || placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + 0.015)) continue;
        placed.push({ x, z, r: 0.015 * s });
        // Leaning out from the rock's flank.
        const out = new THREE.Vector3(Math.cos(a), 0.6, Math.sin(a)).normalize();
        add('sun_coral', new THREE.Vector3(x, y - 0.001, z), out, range(0, 2 * Math.PI), s, new THREE.Color().setScalar(range(0.9, 1.1)));
        n++;
      }
      const ray = new THREE.Raycaster();
      ray.ray.direction.set(0, -1, 0);
      const nm = new THREE.Matrix3();
      for (let i = 0, n = 0; i < ROCK_URCHINS * 30 && n < ROCK_URCHINS; i++) {
        const o = wet[Math.floor(rand() * wet.length)];
        const a = range(0, 2 * Math.PI);
        const d = o.radius * 0.7 * Math.sqrt(rand());
        ray.ray.origin.set(o.position.x + Math.cos(a) * d, 5, o.position.z + Math.sin(a) * d);
        o.mesh.updateMatrixWorld();
        const hit = ray.intersectObject(o.mesh, false)[0];
        if (!hit?.face || WATER_Y - hit.point.y < 0.035 || taken(hit.point.x, hit.point.z)) continue;
        const n2 = hit.face.normal.clone().applyMatrix3(nm.getNormalMatrix(o.mesh.matrixWorld)).normalize();
        if (n2.y < 0.4 || placed.some((p) => Math.hypot(p.x - hit.point.x, p.z - hit.point.z) < p.r + 0.015)) continue;
        placed.push({ x: hit.point.x, z: hit.point.z, r: 0.015 });
        add('urchin', hit.point.clone(), n2, range(0, 2 * Math.PI), range(0.8, 1.2), new THREE.Color().setScalar(range(0.85, 1.1)));
        n++;
      }
    }

    const material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient(), side: THREE.DoubleSide });
    const fanMaterial = material.clone();
    this.sway(fanMaterial);
    for (const [key, list] of items) {
      const kind = list[0].kind;
      const mesh = new THREE.InstancedMesh(geometry[kind], kind === 'sea_fan' ? fanMaterial : material, list.length);
      mesh.name = `reef-${key}`;
      list.forEach((item, i) => {
        mesh.setMatrixAt(i, item.matrix);
        mesh.setColorAt(i, item.tint);
      });
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }

  update(dt: number) {
    this.uniforms.uTime.value += dt;
  }

  /** Sea fans rock gently to and fro across their face with the swell, more toward the top. */
  private sway(material: THREE.Material) {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
          #ifdef USE_INSTANCING
          vec3 root = instanceMatrix[3].xyz;
          float phase = root.x * 9.0 + root.z * 5.0;
          transformed.z += transformed.y * transformed.y * 1.5 * sin(uTime * 1.1 + phase);
          #endif`,
        );
    };
  }
}
