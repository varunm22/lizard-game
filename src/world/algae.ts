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
 * with an id: grazers find what's in reach (`near`), bite it down (`bite`) and take it away
 * (`remove`); the rest of the game never holds on to a patch. Now and then a new patch sprouts on a
 * bare site on the rocks and grows in (`sprout`).
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
 * of view; each is one instanced mesh, where `slots[i]` is the patch drawn by instance i. A batch has
 * room for every site in its tile, bare ones included, so patches can sprout there later.
 */
const TILE = 1;

/** Besides the first patches, this many spare sites per boulder and on the floor where new ones can sprout. */
const SPARE_PER_ROCK = 6;
const SPARE_FLOOR = 90;
const SPARE_SEED = 54;
/** A new patch sprouts on a bare site every so often (s, from-to), and grows in over this long (s). */
const SPROUT_GAP = [10, 30] as const;
const GROW_TIME = 40;
/** Never closer than this to a patch already growing (m). */
const SPROUT_GAP_M = 0.025;
/** A bitten patch shrinks, down to this share of its size just before the last bite takes it. */
const BITTEN_MIN = 0.35;

interface Site extends Placement {
  batch: Batch;
  /** The patch growing here, if any. */
  patch: AlgaePatch | null;
}

interface Entry {
  patch: AlgaePatch;
  site: Site;
  /** How far it has grown in (0 to 1), and how much of it is left uneaten (0 to 1). */
  grown: number;
  left: number;
}

interface Batch {
  mesh: THREE.InstancedMesh;
  slots: Entry[];
}

export class Algae {
  private byId = new Map<number, Entry>();
  private sites: Site[] = [];
  private growing = new Set<Entry>();
  private nextId = 1;
  private rand = rng(SEED + 2);
  private nextSprout: number;

  private uniforms = { uTime: { value: 0 } };
  private m = new THREE.Matrix4();
  private s = new THREE.Vector3();
  private c = new THREE.Color();

  /** `rocks` are the obstacles algae may grow on; only their tops near or under the water get any. */
  constructor(scene: THREE.Scene, geometry: Record<AlgaeKind, THREE.BufferGeometry>, rocks: readonly Obstacle[]) {
    const first = place(rocks, SEED, PER_ROCK_MAX, FLOOR_PATCHES);
    const spare = place(rocks, SPARE_SEED, SPARE_PER_ROCK, SPARE_FLOOR);
    const material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient(), side: THREE.DoubleSide });
    this.sway(material);
    const key = (p: Placement) => `${p.kind},${Math.floor(p.position.x / TILE)},${Math.floor(p.position.z / TILE)}`;
    const groups = new Map<string, { first: Placement[]; spare: Placement[] }>();
    for (const [list, which] of [[first, 'first'], [spare, 'spare']] as const) {
      for (const p of list) {
        const g = groups.get(key(p)) ?? { first: [], spare: [] };
        g[which].push(p);
        groups.set(key(p), g);
      }
    }
    for (const [k, g] of groups) {
      const all = [...g.first, ...g.spare];
      const mesh = new THREE.InstancedMesh(geometry[all[0].kind], material, all.length);
      mesh.name = `algae-${k}`;
      mesh.receiveShadow = true;
      const batch: Batch = { mesh, slots: [] };
      // Bound every site, bare ones too, so a patch sprouting later is never culled.
      all.forEach((p, i) => mesh.setMatrixAt(i, p.matrix));
      mesh.computeBoundingSphere();
      for (const p of all) this.sites.push({ ...p, batch, patch: null });
      for (const site of this.sites.slice(-all.length, this.sites.length - g.spare.length)) this.grow(site, 1);
      scene.add(mesh);
    }
    this.nextSprout = this.between(SPROUT_GAP);
  }

  /** Every patch still growing. */
  all(): AlgaePatch[] {
    return [...this.byId.values()].map((e) => e.patch);
  }

  /** The patch with this id, if it hasn't been removed. */
  get(id: number): AlgaePatch | undefined {
    return this.byId.get(id)?.patch;
  }

  /** How far a patch has grown in (0 just sprouted, 1 full grown), or 0 if it's gone. */
  grown(id: number): number {
    return this.byId.get(id)?.grown ?? 0;
  }

  /** Patches whose holdfast is within `r` of (x, y, z), nearest first. */
  near(x: number, y: number, z: number, r: number): AlgaePatch[] {
    const d = (p: AlgaePatch) => (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2;
    return this.all()
      .filter((p) => d(p) < r * r)
      .sort((a, b) => d(a) - d(b));
  }

  /**
   * Take a bite of a patch: it shrinks by `share` of its full size, and the bite that leaves none
   * removes it. Returns true when that bite ate the last of it.
   */
  bite(id: number, share: number): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    entry.left -= share;
    if (entry.left <= 1e-6) return this.remove(id);
    this.write(entry.site.batch, entry.site.batch.slots.indexOf(entry));
    return false;
  }

  /**
   * Take a patch away for good (eaten). Its instance is replaced by the batch's last one, so drawing
   * stays one packed instanced mesh, and its site is bare again for a new patch to sprout on later.
   * Returns false if there was no such patch.
   */
  remove(id: number): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    const { batch } = entry.site;
    const { mesh, slots } = batch;
    const i = slots.indexOf(entry);
    const last = slots.length - 1;
    if (i !== last) {
      slots[i] = slots[last];
      this.write(batch, i);
    }
    slots.pop();
    mesh.count = slots.length;
    entry.site.patch = null;
    this.growing.delete(entry);
    this.byId.delete(id);
    return true;
  }

  /**
   * Sprout a new patch on a bare site at random, away from those already there, which then grows in
   * over a while. Happens on its own every so often; returns the new patch, or null if no site is free.
   */
  sprout(): AlgaePatch | null {
    const living = [...this.byId.values()].map((e) => e.patch);
    const free = this.sites.filter(
      (s) => !s.patch && !living.some((p) => (p.x - s.position.x) ** 2 + (p.y - s.position.y) ** 2 + (p.z - s.position.z) ** 2 < SPROUT_GAP_M ** 2),
    );
    if (!free.length) return null;
    return this.grow(free[Math.floor(this.rand() * free.length)], 0).patch;
  }

  update(dt: number) {
    this.uniforms.uTime.value += dt;
    if ((this.nextSprout -= dt) <= 0) {
      this.nextSprout = this.between(SPROUT_GAP);
      this.sprout();
    }
    for (const e of this.growing) {
      e.grown = Math.min(1, e.grown + dt / GROW_TIME);
      if (e.grown >= 1) this.growing.delete(e);
      this.write(e.site.batch, e.site.batch.slots.indexOf(e));
    }
  }

  /** Start a patch on a bare site, `grown` of the way in. */
  private grow(site: Site, grown: number): Entry {
    const p = site.position;
    const patch: AlgaePatch = { id: this.nextId++, kind: site.kind, x: p.x, y: p.y, z: p.z };
    const entry: Entry = { patch, site, grown, left: 1 };
    site.patch = patch;
    this.byId.set(patch.id, entry);
    site.batch.slots.push(entry);
    site.batch.mesh.count = site.batch.slots.length;
    if (grown < 1) this.growing.add(entry);
    this.write(site.batch, site.batch.slots.length - 1);
    return entry;
  }

  /** Draw instance i of a batch as its patch: the site's pose, scaled by how grown and how eaten it is. */
  private write(batch: Batch, i: number) {
    const e = batch.slots[i];
    const k = smooth(e.grown) * (BITTEN_MIN + (1 - BITTEN_MIN) * e.left);
    this.m.copy(e.site.matrix).scale(this.s.setScalar(Math.max(k, 0.02)));
    batch.mesh.setMatrixAt(i, this.m);
    batch.mesh.setColorAt(i, this.c.setScalar(e.site.shade));
    batch.mesh.instanceMatrix.needsUpdate = true;
    batch.mesh.instanceColor!.needsUpdate = true;
  }

  private between([a, b]: readonly [number, number]) {
    return a + (b - a) * this.rand();
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
const smooth = (x: number) => x * x * (3 - 2 * x);

/**
 * Where algae grow: on the upward faces of boulders in the splash zone and below, and over the
 * rough lava sea floor and the ledge at the waterline. Deterministic, like the rest of the island.
 */
function place(rocks: readonly Obstacle[], seed: number, perRockMax: number, floorPatches: number): Placement[] {
  const rand = rng(seed);
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
    const tries = Math.min(perRockMax, Math.round(Math.PI * rock.radius ** 2 * PER_ROCK_DENSITY));
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
  for (let i = 0, placed = 0; i < floorPatches * 20 && placed < floorPatches; i++) {
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
