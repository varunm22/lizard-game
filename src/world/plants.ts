import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadGltf } from '../render/gltf';
import { toonGradient } from '../render/toon';
import { bendPlants, plantUniforms } from '../render/plantBend';
import { stepPlant, type PlantBody, type Pusher } from './plantSpring';
import { PLANT_STEM_GROUP, terrainHeight, TERRAIN_SIZE } from './terrain';
import { rng } from './noise';
import { forestCover, lavaCover, sandCover } from './layout';
import { waterDepth } from './shore';

/**
 * How each kind (a mesh in assets-src/plants.py) sways: spring frequency (Hz) and damping ratio,
 * how far from its stem a body is pushed clear (m, before scaling), how far over it can lean, and
 * how much it holds the lizard back at its centre (`drag`). Damping above 1 means no bounce: a
 * pushed plant creeps back upright over a couple of seconds. They only give a little; a body
 * pushing through brushes past and through the stems rather than flattening them.
 */
const KINDS = {
  grass: { hz: 0.4, zeta: 1.2, radius: 0.012, maxTilt: 0.35, drag: 1.2 },
  fern: { hz: 0.35, zeta: 1.3, radius: 0.03, maxTilt: 0.25, drag: 1.5 },
  daisy: { hz: 0.45, zeta: 1.1, radius: 0.005, maxTilt: 0.4, drag: 0.4 },
  poppy: { hz: 0.4, zeta: 1.1, radius: 0.006, maxTilt: 0.4, drag: 0.4 },
} as const;
/**
 * A plant slows the lizard while its body line is within this much of the plant's own radius (m):
 * the body's half-width plus the controller's skin, the closest a body can get to a solid stem.
 * More the closer it is to the stem.
 */
const DRAG_REACH = 0.03;
/** Where along the body (m from the physics centre, + toward the snout) vegetation is felt. */
const DRAG_SAMPLES = [-0.03, 0, 0.04];
/**
 * Each plant's very centre is solid: a thin upright capsule of this radius (m) the body can't pass
 * through, so the lizard goes around stems instead of through them. It only reaches STEM_TOP high,
 * low enough to hop over, and its rounded top gives nothing to perch on.
 */
const STEM_RADIUS = 0.002;
const STEM_TOP = 0.05;
/**
 * Plant centres are never closer than this (m), so the lizard (2.4 cm wide, plus the controller's
 * 8 mm skin each side) can always squeeze between two of them.
 */
const MIN_SPACING = 0.05;
/** However thick the vegetation, the lizard keeps at least this fraction of its speed. */
const MIN_SPEED_SCALE = 0.35;
export type PlantKind = keyof typeof KINDS;

/** Springs advance in steps no longer than this, so a slow frame can't blow them up (s). */
const MAX_SUBSTEP = 1 / 90;
const SEED = 23;
/** No pusher is bigger than this (m). */
const MAX_PUSHER = 0.05;

export interface Plant extends PlantBody {
  kind: PlantKind;
  drag: number;
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
 * Plants scattered over the meadow that give a little as the lizard pushes through, slow it down,
 * and creep back upright once it has passed. Mostly not physical: they don't block movement, the
 * camera or the surface checks, except for a thin solid core at each stem that the body has to go
 * around. The slowing is a speed multiplier (`speedScale`). Each kind is drawn as instanced meshes bent in the vertex shader; each
 * plant's lean is a CPU damped spring (`plantSpring.ts`) pushed by spheres along the drawn body.
 */
export class Plants {
  private patches: Patch[] = [];
  readonly all: Plant[] = [];
  private time = 0;
  private dir = new THREE.Vector3();

  /**
   * `open(x, z)` says whether a plant may grow at a ground point (false where a rock or log sits).
   * `clear` is a spot kept bare (the spawn point). Each plant's solid centre goes into `world`.
   */
  static async load(
    url: string,
    scene: THREE.Scene,
    world: RAPIER.World,
    open: (x: number, z: number) => boolean,
    clear: { x: number; z: number },
  ) {
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
    for (const p of plants.all) {
      const half = Math.min(p.height, STEM_TOP) / 2;
      world.createCollider(
        RAPIER.ColliderDesc.capsule(Math.max(half - STEM_RADIUS, 0.001), STEM_RADIUS)
          .setTranslation(p.x, p.y + half, p.z)
          .setCollisionGroups((PLANT_STEM_GROUP << 16) | 0xffff),
      );
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
      drag: k.drag,
      omega: 2 * Math.PI * k.hz,
      zeta: k.zeta,
      tx: 0,
      tz: 0,
      vx: 0,
      vz: 0,
      awake: false,
    };
  }

  /**
   * Ground speed multiplier for a lizard at (x, z) facing (fx, fz): 1 in the open, lower the more
   * plants its body is among and the nearer their stems. Each plant's pull fades linearly from its
   * kind's `drag` at the stem to nothing at the edge of its reach; pulls at a few points along the
   * body are averaged and summed over plants, so a thick patch slows more than a lone stem.
   */
  speedScale(x: number, z: number, fx: number, fz: number): number {
    let sum = 0;
    for (const s of DRAG_SAMPLES) {
      const sx = x + fx * s;
      const sz = z + fz * s;
      for (const p of this.all) {
        const reach = p.radius + DRAG_REACH;
        const dx = p.x - sx;
        const dz = p.z - sz;
        if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
        const d = Math.hypot(dx, dz);
        if (d < reach) sum += (p.drag * (1 - d / reach)) / DRAG_SAMPLES.length;
      }
    }
    return Math.max(MIN_SPEED_SCALE, 1 / (1 + sum));
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

/**
 * Lay the island's plants out: in the clearing, grass in patches with odd tufts between, ferns, and
 * flowers in little groups; under the trees, ferns thick on the ground among grass; at the back of
 * the beach, a few tufts holding the sand. Nothing grows in the sea, on the bare lava or the open
 * sand, on a rock, log or tree, past the edge, or right where the lizard spawns. A few flowers and
 * grass stand between the spawn and the log so they're the first thing to walk through.
 */
function scatter(open: (x: number, z: number) => boolean, clear: { x: number; z: number }): Placement[] {
  const rand = rng(SEED);
  const out: Placement[] = [];
  const edge = TERRAIN_SIZE / 2 - 0.1;
  const range = (a: number, b: number) => a + (b - a) * rand();
  const ok = (x: number, z: number) => {
    if (Math.abs(x) > edge || Math.abs(z) > edge) return false;
    if (Math.hypot(x - clear.x, z - clear.z) < 0.1) return false;
    if (waterDepth({ x, y: terrainHeight(x, z) + 0.004, z }) > 0) return false;
    if (lavaCover(x, z) > 0.4 || sandCover(x, z) > 0.75) return false;
    return open(x, z);
  };
  const tooClose = (x: number, z: number) => out.some((p) => Math.hypot(p.x - x, p.z - z) < MIN_SPACING);
  const add = (kind: PlantKind, x: number, z: number, scale: number) => {
    if (ok(x, z) && !tooClose(x, z)) out.push({ kind, x, z, yaw: range(0, 2 * Math.PI), scale });
  };
  /** A point within `r` of (x, z), denser towards the middle. */
  const around = (x: number, z: number, r: number) => {
    const a = range(0, 2 * Math.PI);
    const d = r * Math.sqrt(rand());
    return [x + Math.cos(a) * d, z + Math.sin(a) * d] as const;
  };
  /** Somewhere on the island where `where(x, z)` (0 to 1) says it's that kind of ground, more likely the higher it is. */
  const somewhere = (where: (x: number, z: number) => number) => {
    for (;;) {
      const x = range(-edge, edge);
      const z = range(-edge, edge);
      if (rand() < where(x, z)) return [x, z] as const;
    }
  };
  const clearing = (x: number, z: number) => (1 - forestCover(x, z)) * (1 - sandCover(x, z)) * (1 - lavaCover(x, z)) * (x < 2.5 ? 1 : 0);
  const sandEdge = (x: number, z: number) => {
    const s = sandCover(x, z);
    return s > 0.15 && s < 0.7 ? 1 : 0;
  };

  // The first patch you meet: between the spawn and the log, a little off the straight line.
  for (const [kind, x, z, s] of [
    ['poppy', 0.16, -0.22, 1],
    ['daisy', 0.1, -0.28, 1],
    ['daisy', 0.2, -0.3, 0.9],
    ['grass', 0.05, -0.2, 1],
    ['grass', 0.13, -0.17, 0.9],
    ['grass', 0.22, -0.25, 1.1],
    ['grass', 0.185, -0.158, 0.9],
    ['fern', 0.3, -0.12, 1],
  ] as const) add(kind, x, z, s);

  // The clearing.
  for (let i = 0; i < 45; i++) {
    const [cx, cz] = somewhere(clearing);
    const r = range(0.06, 0.16);
    const n = Math.round(range(5, 13));
    for (let j = 0; j < n; j++) add('grass', ...around(cx, cz, r), range(0.75, 1.2));
  }
  for (let i = 0; i < 100; i++) add('grass', ...somewhere(clearing), range(0.7, 1.1));
  for (let i = 0; i < 12; i++) add('fern', ...somewhere(clearing), range(0.8, 1.3));
  for (let i = 0; i < 16; i++) {
    const kind = i % 2 ? 'daisy' : 'poppy';
    const [cx, cz] = somewhere(clearing);
    const n = Math.round(range(2, 5));
    for (let j = 0; j < n; j++) add(kind, ...around(cx, cz, 0.08), range(0.8, 1.15));
  }
  // The forest floor: ferns everywhere, grass in the lighter gaps.
  for (let i = 0; i < 55; i++) {
    const [cx, cz] = somewhere(forestCover);
    const n = Math.round(range(2, 5));
    for (let j = 0; j < n; j++) add('fern', ...around(cx, cz, 0.25), range(0.8, 1.25));
  }
  for (let i = 0; i < 40; i++) {
    const [cx, cz] = somewhere(forestCover);
    for (let j = 0; j < 6; j++) add('grass', ...around(cx, cz, 0.12), range(0.8, 1.2));
  }
  // The back of the beach: scattered tufts.
  for (let i = 0; i < 40; i++) add('grass', ...somewhere(sandEdge), range(0.6, 1));
  return out;
}
