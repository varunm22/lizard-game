import * as THREE from 'three';
import { loadGltf } from '../render/gltf';
import { toonGradient } from '../render/toon';
import { bendPlants, plantUniforms } from '../render/plantBend';
import { stepPlant, type PlantBody, type Pusher } from './plantSpring';
import { terrainHeight, TERRAIN_SIZE } from './terrain';
import { POND, WATER_Y } from './pond';

/**
 * How each kind (a mesh in assets-src/plants.py) sways: spring frequency (Hz) and damping ratio,
 * how far from its stem a body is pushed clear (m, before scaling), and how far over it can lie.
 * Light, low-damped grass and flowers whip back and wobble; reeds are slower and heavier.
 */
const KINDS = {
  grass: { hz: 3.2, zeta: 0.16, radius: 0.012, maxTilt: 1.35 },
  fern: { hz: 2.2, zeta: 0.22, radius: 0.03, maxTilt: 1.0 },
  daisy: { hz: 2.0, zeta: 0.12, radius: 0.005, maxTilt: 1.35 },
  poppy: { hz: 1.8, zeta: 0.12, radius: 0.006, maxTilt: 1.35 },
  reed: { hz: 1.4, zeta: 0.15, radius: 0.012, maxTilt: 1.2 },
} as const;
export type PlantKind = keyof typeof KINDS;

/** Springs advance in steps no longer than this, so a slow frame can't blow them up (s). */
const MAX_SUBSTEP = 1 / 90;
const SEED = 23;
/** No pusher is bigger than this (m). */
const MAX_PUSHER = 0.05;

export interface Plant extends PlantBody {
  kind: PlantKind;
  yaw: number;
  scale: number;
}

/** One kind's plants within one tile of the ground, drawn as a single instanced mesh. */
interface Patch {
  mesh: THREE.InstancedMesh;
  plants: Plant[];
  bend: THREE.InstancedBufferAttribute;
}

/**
 * Side of the ground tiles plants are batched by (m). Per-tile meshes let the camera and the sun's
 * small shadow box skip the plants they can't see, which matters most on software renderers.
 */
const TILE = 1;

/**
 * Plants scattered over the meadow that lean out of the lizard's way and spring back once it has
 * passed. They are drawn, not simulated: no physics bodies, so they never block movement, the
 * camera or the obstacle checks. Each kind is drawn as instanced meshes bent in the vertex shader; each
 * plant's lean is a CPU damped spring (`plantSpring.ts`) pushed by spheres along the drawn body.
 */
export class Plants {
  private patches: Patch[] = [];
  readonly all: Plant[] = [];
  private time = 0;
  private dir = new THREE.Vector3();

  /**
   * `open(x, z)` says whether a plant may grow at a ground point (false where a rock or log sits).
   * `clear` is a spot kept bare (the spawn point).
   */
  static async load(url: string, scene: THREE.Scene, open: (x: number, z: number) => boolean, clear: { x: number; z: number }) {
    const gltf = await loadGltf(url);
    const plants = new Plants();
    const placed = scatter(open, clear);
    for (const name of Object.keys(KINDS) as PlantKind[]) {
      const src = gltf.scene.getObjectByName(name) as THREE.Mesh | undefined;
      if (!src) throw new Error(`plants.glb has no ${name}`);
      const geometry = src.geometry;
      geometry.computeBoundingBox();
      const height = geometry.boundingBox!.max.y;
      const list = placed.filter((p) => p.kind === name).map((p) => plants.makePlant(p, height));
      plants.all.push(...list);
      const material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient(), side: THREE.DoubleSide });
      bendPlants(material, height);
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
      bendPlants(depth, height);
      const tiles = new Map<string, Plant[]>();
      for (const p of list) {
        const key = `${Math.floor(p.x / TILE)},${Math.floor(p.z / TILE)}`;
        tiles.set(key, [...(tiles.get(key) ?? []), p]);
      }
      for (const [key, tile] of tiles) {
        plants.patches.push(makePatch(scene, `plants-${name}-${key}`, geometry, material, depth, tile));
      }
    }
    return plants;
  }

  private makePlant(p: Placement, height: number): Plant {
    const k = KINDS[p.kind];
    return {
      ...p,
      y: terrainHeight(p.x, p.z),
      height: height * p.scale,
      radius: k.radius * p.scale,
      maxTilt: k.maxTilt,
      omega: 2 * Math.PI * k.hz,
      zeta: k.zeta,
      tx: 0,
      tz: 0,
      vx: 0,
      vz: 0,
      awake: false,
    };
  }

  /** Advance every plant by `dt`, pushed by `pushers`. */
  update(pushers: readonly Pusher[], dt: number) {
    this.time += dt;
    plantUniforms.uTime.value = this.time;
    const n = Math.ceil(Math.min(dt, 0.1) / MAX_SUBSTEP);
    const h = Math.min(dt, 0.1) / n;
    for (const k of this.patches) {
      let changed = false;
      k.plants.forEach((p, i) => {
        // A plant at rest only needs stepping once something comes within reach of it.
        const reach = p.height + p.radius + MAX_PUSHER;
        if (!p.awake && !pushers.some((q) => Math.abs(q.x - p.x) < reach && Math.abs(q.z - p.z) < reach)) return;
        const wasAwake = p.awake;
        for (let s = 0; s < n; s++) stepPlant(p, pushers, h);
        if (!p.awake && !wasAwake) return;
        // The shader bends in the plant's own frame: turn the world-space tilt by -yaw.
        this.dir.set(p.tx, 0, p.tz).applyAxisAngle(Y, -p.yaw);
        k.bend.setXY(i, this.dir.x, this.dir.z);
        changed = true;
      });
      if (changed) k.bend.needsUpdate = true;
    }
  }
}

const Y = new THREE.Vector3(0, 1, 0);

function makePatch(
  scene: THREE.Scene,
  name: string,
  source: THREE.BufferGeometry,
  material: THREE.Material,
  depth: THREE.Material,
  plants: Plant[],
): Patch {
  // Share the kind's vertex data; only the per-instance bend is the patch's own.
  const geometry = new THREE.BufferGeometry();
  for (const [attr, data] of Object.entries(source.attributes)) geometry.setAttribute(attr, data);
  geometry.setIndex(source.index);
  const bend = new THREE.InstancedBufferAttribute(new Float32Array(plants.length * 2), 2);
  bend.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aBend', bend);

  const mesh = new THREE.InstancedMesh(geometry, material, plants.length);
  mesh.name = name;
  mesh.customDepthMaterial = depth;
  mesh.castShadow = mesh.receiveShadow = true;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  plants.forEach((p, i) => {
    m.compose(new THREE.Vector3(p.x, p.y, p.z), q.setFromAxisAngle(Y, p.yaw), new THREE.Vector3(p.scale, p.scale, p.scale));
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  // Bent plants reach outside their upright bounds by up to a stem's height.
  mesh.computeBoundingSphere();
  mesh.boundingSphere!.radius += Math.max(...plants.map((p) => p.height));
  scene.add(mesh);
  return { mesh, plants, bend };
}

interface Placement {
  kind: PlantKind;
  x: number;
  z: number;
  yaw: number;
  scale: number;
}

/** Small deterministic PRNG (mulberry32), so the meadow is the same every load. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Lay the meadow out: grass in patches with odd tufts between, ferns, flowers in little groups,
 * and reeds around the pond's waterline. Nothing grows under water (except reeds in the shallows),
 * on a rock or log, past the edge, or right where the lizard spawns. A few flowers and grass stand
 * between the spawn and the log so they're the first thing to walk through.
 */
function scatter(open: (x: number, z: number) => boolean, clear: { x: number; z: number }): Placement[] {
  const rand = rng(SEED);
  const out: Placement[] = [];
  const edge = TERRAIN_SIZE / 2 - 0.1;
  const range = (a: number, b: number) => a + (b - a) * rand();
  const ok = (kind: PlantKind, x: number, z: number) => {
    if (Math.abs(x) > edge || Math.abs(z) > edge) return false;
    if (Math.hypot(x - clear.x, z - clear.z) < 0.1) return false;
    const depth = WATER_Y - terrainHeight(x, z);
    if (kind === 'reed' ? depth > 0.03 || depth < -0.02 : depth > -0.004) return false;
    return open(x, z);
  };
  const add = (kind: PlantKind, x: number, z: number, scale: number) => {
    if (ok(kind, x, z)) out.push({ kind, x, z, yaw: range(0, 2 * Math.PI), scale });
  };
  /** A point within `r` of (x, z), denser towards the middle. */
  const around = (x: number, z: number, r: number) => {
    const a = range(0, 2 * Math.PI);
    const d = r * Math.sqrt(rand());
    return [x + Math.cos(a) * d, z + Math.sin(a) * d] as const;
  };
  /** Somewhere in the ring between radii a and b around the centre of the world. */
  const inRing = (a: number, b: number) => {
    const ang = range(0, 2 * Math.PI);
    const d = Math.sqrt(range(a * a, b * b));
    return [Math.cos(ang) * d, Math.sin(ang) * d] as const;
  };

  // The first patch you meet: between the spawn and the log, a little off the straight line.
  for (const [kind, x, z, s] of [
    ['poppy', 0.16, -0.22, 1],
    ['daisy', 0.1, -0.28, 1],
    ['daisy', 0.2, -0.3, 0.9],
    ['grass', 0.05, -0.2, 1],
    ['grass', 0.13, -0.17, 0.9],
    ['grass', 0.22, -0.25, 1.1],
    ['fern', 0.3, -0.12, 1],
  ] as const) add(kind, x, z, s);

  for (let i = 0; i < 70; i++) {
    const [cx, cz] = inRing(0.25, 2.8);
    const r = range(0.06, 0.16);
    const n = Math.round(range(5, 13));
    for (let j = 0; j < n; j++) add('grass', ...around(cx, cz, r), range(0.75, 1.2));
  }
  for (let i = 0; i < 160; i++) add('grass', ...inRing(0.2, 2.9), range(0.7, 1.1));
  for (let i = 0; i < 30; i++) add('fern', ...inRing(0.5, 2.8), range(0.8, 1.3));
  for (let i = 0; i < 28; i++) {
    const kind = i % 2 ? 'daisy' : 'poppy';
    const [cx, cz] = inRing(0.3, 2.7);
    const n = Math.round(range(2, 5));
    for (let j = 0; j < n; j++) add(kind, ...around(cx, cz, 0.08), range(0.8, 1.15));
  }
  // Reeds in clumps on the waterline: try points around the shore until enough land in the band.
  for (let i = 0; i < 18; i++) {
    const a = range(0, 2 * Math.PI);
    const r = POND.radius * range(0.85, 1.2);
    const [cx, cz] = [POND.x + Math.cos(a) * r, POND.z + Math.sin(a) * r];
    for (let j = 0; j < 6; j++) add('reed', ...around(cx, cz, 0.08), range(0.8, 1.2));
  }
  return out;
}
