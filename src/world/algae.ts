import * as THREE from 'three';
import { toonGradient } from '../render/toon';
import { rng } from './noise';
import { shoreDistance } from './layout';
import { rockyShore, WATER_Y } from './shore';
import { terrainHeight } from './terrain';
import type { Obstacle } from './obstacles';

/**
 * Seaweed on the rocky shore, the marine iguana's food: red turf on the lava at and just below the
 * waterline, sea lettuce further down, on the boulders and on the rough sea floor off the lava.
 * Drawn, not simulated: no colliders, the lizard swims through it. Every patch is its own entity
 * with an id, so a later eating mechanic can find what's in reach (`near`) and take a patch away
 * (`remove`); the rest of the game never holds on to a patch.
 */
export type AlgaeKind = 'green' | 'red';

export interface AlgaePatch {
  readonly id: number;
  readonly kind: AlgaeKind;
  /** Where it grows (its holdfast), world metres. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Algae grow from this far above the surface (spray-wetted lava) down to this deep (m). */
const SPLASH_ZONE = 0.015;
const MAX_DEPTH = 0.42;
/** At most this many patches on any one boulder, and roughly this many per square metre of its top. */
const PER_ROCK_MAX = 10;
const PER_ROCK_DENSITY = 1600;
/** Patches on the open lava sea floor and the ledge above it. */
const FLOOR_PATCHES = 140;
const SEED = 53;

/** Which kind grows at a depth (m below the surface): mostly red turf in the shallows, mostly sea lettuce deeper. */
const kindAt = (depth: number, r: number): AlgaeKind => (r < (depth < 0.1 ? 0.7 : 0.3) ? 'red' : 'green');

/**
 * Batches are per kind and per TILE of shore (m), so the camera and the shadow box skip the ones out
 * of view; each is one instanced mesh, where `slots[i]` is the patch drawn by instance i.
 */
const TILE = 1;

interface Batch {
  mesh: THREE.InstancedMesh;
  slots: AlgaePatch[];
}

export class Algae {
  private byId = new Map<number, { patch: AlgaePatch; batch: Batch }>();

  private uniforms = { uTime: { value: 0 } };
  private m = new THREE.Matrix4();

  /** `rocks` are the obstacles algae may grow on; only their tops near or under the water get any. */
  constructor(scene: THREE.Scene, geometry: Record<AlgaeKind, THREE.BufferGeometry>, rocks: readonly Obstacle[]) {
    const placements = place(rocks);
    const material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient(), side: THREE.DoubleSide });
    this.sway(material);
    const groups = new Map<string, Placement[]>();
    for (const p of placements) {
      const key = `${p.kind},${Math.floor(p.position.x / TILE)},${Math.floor(p.position.z / TILE)}`;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    let nextId = 1;
    const tint = new THREE.Color();
    for (const [key, group] of groups) {
      const kind = group[0].kind;
      const mesh = new THREE.InstancedMesh(geometry[kind], material, group.length);
      mesh.name = `algae-${key}`;
      mesh.receiveShadow = true;
      const batch: Batch = { mesh, slots: [] };
      group.forEach((p, i) => {
        const patch: AlgaePatch = { id: nextId++, kind, x: p.position.x, y: p.position.y, z: p.position.z };
        mesh.setMatrixAt(i, p.matrix);
        mesh.setColorAt(i, tint.setScalar(p.shade));
        batch.slots.push(patch);
        this.byId.set(patch.id, { patch, batch });
      });
      mesh.computeBoundingSphere();
      scene.add(mesh);
    }
  }

  /** Every patch still growing. */
  all(): AlgaePatch[] {
    return [...this.byId.values()].map((e) => e.patch);
  }

  /** The patch with this id, if it hasn't been removed. */
  get(id: number): AlgaePatch | undefined {
    return this.byId.get(id)?.patch;
  }

  /** Patches whose holdfast is within `r` of (x, y, z), nearest first. */
  near(x: number, y: number, z: number, r: number): AlgaePatch[] {
    const d = (p: AlgaePatch) => (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2;
    return this.all()
      .filter((p) => d(p) < r * r)
      .sort((a, b) => d(a) - d(b));
  }

  /**
   * Take a patch away for good (eaten). Its instance is replaced by the batch's last one, so drawing
   * stays one packed instanced mesh. Returns false if there was no such patch.
   */
  remove(id: number): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    const { batch, patch } = entry;
    const { mesh, slots } = batch;
    const i = slots.indexOf(patch);
    const last = slots.length - 1;
    if (i !== last) {
      mesh.getMatrixAt(last, this.m);
      mesh.setMatrixAt(i, this.m);
      if (mesh.instanceColor) {
        const c = new THREE.Color();
        mesh.getColorAt(last, c);
        mesh.setColorAt(i, c);
        mesh.instanceColor.needsUpdate = true;
      }
      slots[i] = slots[last];
    }
    slots.pop();
    mesh.count = slots.length;
    mesh.instanceMatrix.needsUpdate = true;
    this.byId.delete(id);
    return true;
  }

  update(dt: number) {
    this.uniforms.uTime.value += dt;
  }

  /** Fronds under water sway gently with the swell, more toward their tips; those out of it stay still. */
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
          float wet = step(root.y, ${WATER_Y.toFixed(4)});
          float phase = root.x * 13.0 + root.z * 7.0;
          transformed.xz += wet * transformed.y * 0.25 * vec2(sin(uTime * 1.6 + phase), cos(uTime * 1.2 + phase * 1.3));
          #endif`,
        );
    };
  }
}

interface Placement {
  kind: AlgaeKind;
  position: THREE.Vector3;
  matrix: THREE.Matrix4;
  shade: number;
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Where algae grow: on the upward faces of boulders in the splash zone and below, and over the
 * rough lava sea floor and the ledge at the waterline. Deterministic, like the rest of the island.
 */
function place(rocks: readonly Obstacle[]): Placement[] {
  const rand = rng(SEED);
  const out: Placement[] = [];
  const wet = (y: number) => y < WATER_Y + SPLASH_ZONE && y > WATER_Y - MAX_DEPTH;
  const add = (position: THREE.Vector3, normal: THREE.Vector3) => {
    // Lean a little toward straight up, turn at random about the surface, vary the size.
    const n = normal.clone().lerp(UP, 0.4).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(UP, n).multiply(new THREE.Quaternion().setFromAxisAngle(UP, rand() * 2 * Math.PI));
    const s = 0.8 + rand() * 0.7;
    out.push({
      kind: kindAt(WATER_Y - position.y, rand()),
      position,
      matrix: new THREE.Matrix4().compose(position, q, new THREE.Vector3(s, s, s)),
      shade: 0.8 + rand() * 0.35,
    });
  };

  // Boulders: look straight down onto each at random points of its footprint.
  const ray = new THREE.Raycaster();
  ray.ray.direction.set(0, -1, 0);
  const normal = new THREE.Matrix3();
  for (const rock of rocks) {
    if (rock.kind !== 'rock' || rock.position.y - rock.radius > WATER_Y + SPLASH_ZONE) continue;
    rock.mesh.updateMatrixWorld();
    normal.getNormalMatrix(rock.mesh.matrixWorld);
    const tries = Math.min(PER_ROCK_MAX, Math.round(Math.PI * rock.radius ** 2 * PER_ROCK_DENSITY));
    for (let k = 0; k < tries; k++) {
      const a = rand() * 2 * Math.PI;
      const d = rock.radius * 0.85 * Math.sqrt(rand());
      ray.ray.origin.set(rock.position.x + Math.cos(a) * d, 5, rock.position.z + Math.sin(a) * d);
      const hit = ray.intersectObject(rock.mesh, false)[0];
      if (!hit?.face || !wet(hit.point.y)) continue;
      const n = hit.face.normal.clone().applyMatrix3(normal).normalize();
      if (n.y < 0.3) continue;
      add(hit.point.clone(), n);
    }
  }

  // The lava sea floor, and the ledge at the waterline.
  for (let i = 0, placed = 0; i < FLOOR_PATCHES * 20 && placed < FLOOR_PATCHES; i++) {
    const z = -4 + 8 * rand();
    const x = 1 + 3 * rand();
    const s = shoreDistance(x, z);
    if (rockyShore(z) < 0.6 || s < -0.08 || s > 1.5 || Math.abs(x) > 3.85 || Math.abs(z) > 3.85) continue;
    const y = terrainHeight(x, z);
    if (!wet(y) || rocks.some((o) => Math.hypot(o.position.x - x, o.position.z - z) < o.radius * 0.8)) continue;
    const e = 0.01;
    const n = new THREE.Vector3(terrainHeight(x - e, z) - terrainHeight(x + e, z), 2 * e, terrainHeight(x, z - e) - terrainHeight(x, z + e)).normalize();
    add(new THREE.Vector3(x, y - 0.001, z), n);
    placed++;
  }
  return out;
}
