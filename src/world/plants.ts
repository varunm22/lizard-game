import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadGltf } from '../render/gltf';
import { toonGradient } from '../render/toon';
import { bendPlants, plantUniforms } from '../render/plantBend';
import { stepPlant, type PlantBody, type Pusher } from './plantSpring';
import { PLANT_STEM_GROUP, terrainHeight, TERRAIN_SIZE } from './terrain';
import { rng, smoothstep } from './noise';
import { forestCover, lavaCover, sandCover } from './layout';
import { WATER_Y, waterDepth } from './shore';

/**
 * How each kind (a mesh in assets-src/plants.py) sways: spring frequency (Hz) and damping ratio,
 * how far from its stem a body is pushed clear (m, before scaling), how far over it can lean, and
 * how much it holds the lizard back at its centre (`drag`). Damping above 1 means no bounce: a
 * pushed plant creeps back upright over a couple of seconds. Big plants (`solid`) have a solid stem
 * the lizard has to go around, and only give a little. Small ones have none: the lizard walks
 * straight through them, pressing them flat under its body, and they only slow it down.
 */
const KINDS = {
  grass: { hz: 0.4, zeta: 1.2, radius: 0.012, maxTilt: 1.1, drag: 1.2, solid: false },
  fern: { hz: 0.35, zeta: 1.3, radius: 0.03, maxTilt: 0.25, drag: 1.5, solid: true },
  lecocarpus: { hz: 0.45, zeta: 1.1, radius: 0.005, maxTilt: 0.4, drag: 0.4, solid: true },
  cotton: { hz: 0.4, zeta: 1.1, radius: 0.006, maxTilt: 0.4, drag: 0.4, solid: true },
  sesuvium: { hz: 0.5, zeta: 1.3, radius: 0.02, maxTilt: 0.9, drag: 1.0, solid: false },
  tomato: { hz: 0.4, zeta: 1.2, radius: 0.02, maxTilt: 0.3, drag: 1.0, solid: true },
  ipomoea: { hz: 0.5, zeta: 1.3, radius: 0.025, maxTilt: 1.0, drag: 0.6, solid: false },
  tiquilia: { hz: 0.5, zeta: 1.4, radius: 0.015, maxTilt: 0.8, drag: 0.5, solid: false },
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
 * Solid stems are never closer than this (m), so the lizard (2.4 cm wide, plus the controller's
 * 8 mm skin each side) can always squeeze between two of them. Any other two plants keep
 * SOFT_SPACING apart, only so they don't grow into each other.
 */
const MIN_SPACING = 0.05;
const SOFT_SPACING = 0.028;
/** However thick the vegetation, the lizard keeps at least this fraction of its speed. */
const MIN_SPEED_SCALE = 0.35;
export type PlantKind = keyof typeof KINDS;

/** Whether two plants, one of `kind` at (x, z), would stand too close (see MIN_SPACING). */
function crowds(kind: PlantKind, x: number, z: number, p: { kind: PlantKind; x: number; z: number }) {
  const gap = KINDS[kind].solid && KINDS[p.kind].solid ? MIN_SPACING : SOFT_SPACING;
  return Math.abs(p.x - x) < gap && Math.abs(p.z - z) < gap && Math.hypot(p.x - x, p.z - z) < gap;
}

/** Springs advance in steps no longer than this, so a slow frame can't blow them up (s). */
const MAX_SUBSTEP = 1 / 90;
const SEED = 23;
/** No pusher is bigger than this (m). */
const MAX_PUSHER = 0.05;

/**
 * Trampled by something heavy (the tortoise), a plant lies this far over (radians), stays down most
 * of about CRUSH_TIME seconds and lifts back up over the last CRUSH_LIFT of it, so a well-used route
 * stays a flattened trail. While it's mostly flat (above STEM_BACK) its stem isn't solid either.
 */
const FLAT_TILT = 1.3;
const CRUSH_TIME = 60;
const CRUSH_LIFT = 0.35;
const STEM_BACK = 0.3;
/** A sprouted plant grows from a seedling to full size over this long (s); its stem is solid from half grown. */
const GROW_TIME = 30;
const SEEDLING = 0.05;
/** Room for sprouted plants of each kind at once (the tortoise's meadow starts out as sprouts too). */
const SPROUT_CAP = 96;

export interface Plant extends PlantBody {
  kind: PlantKind;
  /** A big plant, with a solid stem the lizard goes around; a small one it walks through. */
  solid: boolean;
  drag: number;
  yaw: number;
  scale: number;
  /** Full-grown stem height and push radius (m); `height` and `radius` are these times `growth`. */
  fullHeight: number;
  fullRadius: number;
  /** 0 (seedling) to 1 (full size). */
  growth: number;
  /** How trampled, 1 (flat) easing to 0 (recovered), over `crushTime` seconds; it lies toward (crushX, crushZ). */
  crush: number;
  crushTime: number;
  crushX: number;
  crushZ: number;
  eaten: boolean;
  /** Its solid stem (null for a small plant, or until a big one has grown enough to have one). */
  stem: RAPIER.Collider | null;
  patch: Patch;
  slot: number;
}

/** One kind's plants within one tile of the ground, drawn as a single instanced mesh. */
interface Patch {
  mesh: THREE.InstancedMesh;
  plants: Plant[];
  bend: THREE.InstancedBufferAttribute;
  /** Sprout patches: slots freed by eaten plants, to reuse. */
  free: number[];
}

interface KindDraw {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  depth: THREE.Material;
  height: number;
  sprouts: Patch;
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
  /** Every plant still growing (eaten ones leave). */
  readonly all: Plant[] = [];
  private time = 0;
  private dir = new THREE.Vector3();
  private kinds = new Map<PlantKind, KindDraw>();
  /** Plants that are trampled or still growing, which change every frame. */
  private changing = new Set<Plant>();
  private rand = rng(SEED + 1);
  private matrix = new THREE.Matrix4();

  private constructor(private world: RAPIER.World) {}

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
    const plants = new Plants(world);
    const placed = scatter(open, clear);
    for (const name of Object.keys(KINDS) as PlantKind[]) {
      const src = gltf.scene.getObjectByName(name) as THREE.Mesh | undefined;
      if (!src) throw new Error(`plants.glb has no ${name}`);
      const geometry = src.geometry;
      geometry.computeBoundingBox();
      const height = geometry.boundingBox!.max.y;
      const list = placed.filter((p) => p.kind === name).map((p) => plants.makePlant(p, height, 1));
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
      // New plants come up anywhere, so their batch isn't tied to a tile (and isn't culled).
      const sprouts = makePatch(scene, `plants-${name}-sprouts`, geometry, material, depth, [], SPROUT_CAP);
      plants.patches.push(sprouts);
      plants.kinds.set(name, { geometry, material, depth, height, sprouts });
    }
    for (const p of plants.all) plants.growStem(p);
    return plants;
  }

  private makePlant(p: Placement, height: number, growth: number): Plant {
    const k = KINDS[p.kind];
    return {
      ...p,
      y: terrainHeight(p.x, p.z),
      fullHeight: height * p.scale,
      fullRadius: k.radius * p.scale,
      height: height * p.scale * growth,
      radius: k.radius * p.scale * growth,
      growth,
      maxTilt: k.maxTilt,
      drag: k.drag,
      solid: k.solid,
      omega: 2 * Math.PI * k.hz,
      zeta: k.zeta,
      tx: 0,
      tz: 0,
      restX: 0,
      restZ: 0,
      vx: 0,
      vz: 0,
      awake: false,
      crush: 0,
      crushTime: CRUSH_TIME,
      crushX: 0,
      crushZ: 0,
      eaten: false,
      stem: null,
      patch: undefined as unknown as Patch, // set by makePatch or sprout
      slot: 0,
    };
  }

  /** Give a big plant its thin solid stem (full-grown height); small ones have none. */
  private growStem(p: Plant) {
    if (!KINDS[p.kind].solid) return;
    const half = Math.min(p.fullHeight, STEM_TOP) / 2;
    p.stem = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(Math.max(half - STEM_RADIUS, 0.001), STEM_RADIUS)
        .setTranslation(p.x, p.y + half, p.z)
        .setCollisionGroups((PLANT_STEM_GROUP << 16) | 0xffff),
    );
    p.stem.setEnabled(p.crush < STEM_BACK);
  }

  /** The nearest plant to (x, z) within r that is at least `minGrowth` grown, or null. */
  nearest(x: number, z: number, r: number, minGrowth = 0): Plant | null {
    let best: Plant | null = null;
    let bestD = r;
    for (const p of this.all) {
      if (p.growth < minGrowth || Math.abs(p.x - x) > r || Math.abs(p.z - z) > r) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD) [best, bestD] = [p, d];
    }
    return best;
  }

  /**
   * Something heavy passes over every plant within r of (x, z), heading (dx, dz): each one is pressed
   * flat, lying the way it was walked over and a little out from the middle, and its stem stops
   * being solid. It stays down for about a minute (a little more or less each), then lifts back.
   */
  trample(x: number, z: number, r: number, dx: number, dz: number) {
    for (const p of this.all) {
      if (p.growth < 0.3 || Math.abs(p.x - x) > r || Math.abs(p.z - z) > r) continue;
      const ox = p.x - x;
      const oz = p.z - z;
      const d = Math.hypot(ox, oz);
      if (d > r) continue;
      if (p.crush === 0) {
        const lx = dx + (d > 1e-4 ? (0.5 * ox) / d : 0);
        const lz = dz + (d > 1e-4 ? (0.5 * oz) / d : 0);
        const l = Math.hypot(lx, lz) || 1;
        p.crushX = lx / l;
        p.crushZ = lz / l;
        p.crushTime = CRUSH_TIME * (0.85 + 0.3 * this.rand());
      }
      p.crush = 1;
      p.awake = true;
      p.stem?.setEnabled(false);
      this.changing.add(p);
    }
  }

  /** Eat a plant: it's gone, stem and all. */
  eat(p: Plant) {
    if (p.eaten) return;
    p.eaten = true;
    this.all.splice(this.all.indexOf(p), 1);
    this.changing.delete(p);
    if (p.stem) this.world.removeCollider(p.stem, false);
    p.stem = null;
    this.place(p);
    if (p.patch.free) p.patch.free.push(p.slot);
  }

  /**
   * A new plant comes up at (x, z) as a seedling (or full grown) and grows, unless that's too close
   * to another plant or this kind has no room left. Returns it, or null.
   */
  sprout(kind: PlantKind, x: number, z: number, grown = false): Plant | null {
    if (this.all.some((p) => crowds(kind, x, z, p))) return null;
    const draw = this.kinds.get(kind)!;
    const patch = draw.sprouts;
    const slot = patch.free.pop() ?? (patch.plants.length < SPROUT_CAP ? patch.plants.length : -1);
    if (slot < 0) return null;
    const p = this.makePlant({ kind, x, z, yaw: this.rand() * 2 * Math.PI, scale: 0.8 + 0.35 * this.rand() }, draw.height, grown ? 1 : SEEDLING);
    p.patch = patch;
    p.slot = slot;
    patch.plants[slot] = p;
    patch.mesh.count = Math.max(patch.mesh.count, slot + 1);
    patch.bend.setXY(slot, 0, 0);
    patch.bend.needsUpdate = true;
    this.place(p);
    this.all.push(p);
    if (grown) this.growStem(p);
    else this.changing.add(p);
    return p;
  }

  /** Write a plant's instance matrix: its spot, turn and size (none once eaten). */
  private place(p: Plant) {
    const s = p.eaten ? 0 : p.scale * p.growth;
    this.matrix.compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion().setFromAxisAngle(Y, p.yaw), new THREE.Vector3(s, s, s));
    p.patch.mesh.setMatrixAt(p.slot, this.matrix);
    p.patch.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Advance trampled plants back up and seedlings toward full size. */
  private recover(dt: number) {
    for (const p of this.changing) {
      if (p.crush > 0) {
        p.crush = Math.max(0, p.crush - dt / p.crushTime);
        const flat = FLAT_TILT * smoothstep(0, CRUSH_LIFT, p.crush);
        p.restX = p.crushX * flat;
        p.restZ = p.crushZ * flat;
        p.awake = true;
        if (p.crush < STEM_BACK && p.stem && !p.stem.isEnabled()) p.stem.setEnabled(true);
      }
      if (p.growth < 1) {
        p.growth = Math.min(1, p.growth + dt / GROW_TIME);
        p.height = p.fullHeight * p.growth;
        p.radius = p.fullRadius * p.growth;
        this.place(p);
        if (p.growth >= 0.5 && !p.stem) this.growStem(p);
      }
      if (p.crush === 0 && p.growth >= 1) this.changing.delete(p);
    }
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
        // A flattened plant is a trail, and a seedling is underfoot: neither holds the lizard back much.
        const drag = p.drag * (1 - p.crush) * p.growth;
        const dx = p.x - sx;
        const dz = p.z - sz;
        if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
        const d = Math.hypot(dx, dz);
        if (d < reach) sum += (drag * (1 - d / reach)) / DRAG_SAMPLES.length;
      }
    }
    return Math.max(MIN_SPEED_SCALE, 1 / (1 + sum));
  }

  /** Advance every plant by `dt`, pushed by `pushers`. */
  update(pushers: readonly Pusher[], dt: number) {
    this.time += dt;
    plantUniforms.uTime.value = this.time;
    this.recover(dt);
    const n = Math.ceil(Math.min(dt, 0.1) / MAX_SUBSTEP);
    const h = Math.min(dt, 0.1) / n;
    for (const k of this.patches) {
      let changed = false;
      k.plants.forEach((p, i) => {
        if (p.eaten) return;
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
  capacity = plants.length,
): Patch {
  // Share the kind's vertex data; only the per-instance bend is the patch's own.
  const geometry = new THREE.BufferGeometry();
  for (const [attr, data] of Object.entries(source.attributes)) geometry.setAttribute(attr, data);
  geometry.setIndex(source.index);
  const bend = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
  bend.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aBend', bend);

  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.count = plants.length;
  mesh.name = name;
  mesh.customDepthMaterial = depth;
  mesh.castShadow = mesh.receiveShadow = true;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const patch: Patch = { mesh, plants, bend, free: [] };
  plants.forEach((p, i) => {
    p.patch = patch;
    p.slot = i;
    m.compose(new THREE.Vector3(p.x, p.y, p.z), q.setFromAxisAngle(Y, p.yaw), new THREE.Vector3(p.scale, p.scale, p.scale));
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (plants.length) {
    // Bent plants reach outside their upright bounds by up to a stem's height.
    mesh.computeBoundingSphere();
    mesh.boundingSphere!.radius += Math.max(...plants.map((p) => p.height));
  } else mesh.frustumCulled = false;
  scene.add(mesh);
  return patch;
}

interface Placement {
  kind: PlantKind;
  x: number;
  z: number;
  yaw: number;
  scale: number;
}

/**
 * Lay the island's plants out, Galapagos lowland style: in the dry clearing, bunchgrass in patches
 * with odd tufts between, mats of carpetweed (Sesuvium), and Lecocarpus, Darwin's cotton and
 * Galapagos tomato in little groups; under the trees, ferns thick on the ground among grass; at the
 * back of the beach carpetweed, and morning glory running out over the open sand; grey Tiquilia
 * mounds on the bare lava. Nothing grows in the sea, on a rock, log or tree, past the edge, or right
 * where the lizard spawns; only morning glory grows on open sand and only Tiquilia on the lava. A few
 * flowers and grass stand between the spawn and the log so they're the first thing to walk through.
 */
function scatter(open: (x: number, z: number) => boolean, clear: { x: number; z: number }): Placement[] {
  const rand = rng(SEED);
  const out: Placement[] = [];
  const edge = TERRAIN_SIZE / 2 - 0.1;
  const range = (a: number, b: number) => a + (b - a) * rand();
  const ok = (kind: PlantKind, x: number, z: number) => {
    if (Math.abs(x) > edge || Math.abs(z) > edge) return false;
    if (Math.hypot(x - clear.x, z - clear.z) < 0.1) return false;
    if (waterDepth({ x, y: terrainHeight(x, z) + 0.004, z }) > 0) return false;
    // Open sand and lava run down to the sea: keep off the wet strip at its edge.
    if ((kind === 'ipomoea' || kind === 'tiquilia') && terrainHeight(x, z) < WATER_Y + 0.01) return false;
    if (lavaCover(x, z) > 0.4 && kind !== 'tiquilia') return false;
    if (sandCover(x, z) > 0.75 && kind !== 'ipomoea') return false;
    return open(x, z);
  };
  const add = (kind: PlantKind, x: number, z: number, scale: number) => {
    if (ok(kind, x, z) && !out.some((p) => crowds(kind, x, z, p))) out.push({ kind, x, z, yaw: range(0, 2 * Math.PI), scale });
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
  const openSand = (x: number, z: number) => (sandCover(x, z) > 0.6 && lavaCover(x, z) < 0.3 && waterDepth({ x, y: terrainHeight(x, z) + 0.004, z }) <= 0 ? 1 : 0);
  const bareLava = (x: number, z: number) => (lavaCover(x, z) > 0.5 && waterDepth({ x, y: terrainHeight(x, z) + 0.004, z }) <= 0 ? 1 : 0);

  // The first patch you meet: between the spawn and the log, a little off the straight line.
  for (const [kind, x, z, s] of [
    ['cotton', 0.16, -0.22, 1],
    ['lecocarpus', 0.1, -0.28, 1],
    ['lecocarpus', 0.2, -0.3, 0.9],
    ['grass', 0.05, -0.2, 1],
    ['grass', 0.13, -0.17, 0.9],
    ['grass', 0.22, -0.25, 1.1],
    ['tomato', 0.185, -0.158, 0.9],
    ['sesuvium', 0.3, -0.12, 1],
  ] as const) add(kind, x, z, s);

  // The clearing.
  for (let i = 0; i < 70; i++) {
    const [cx, cz] = somewhere(clearing);
    const r = range(0.06, 0.16);
    const n = Math.round(range(5, 13));
    for (let j = 0; j < n; j++) add('grass', ...around(cx, cz, r), range(0.75, 1.2));
  }
  for (let i = 0; i < 160; i++) add('grass', ...somewhere(clearing), range(0.7, 1.1));
  for (let i = 0; i < 18; i++) {
    const [cx, cz] = somewhere(clearing);
    const n = Math.round(range(3, 7));
    for (let j = 0; j < n; j++) add('sesuvium', ...around(cx, cz, 0.1), range(0.8, 1.3));
  }
  for (let i = 0; i < 24; i++) {
    const kind = i % 2 ? 'lecocarpus' : 'cotton';
    const [cx, cz] = somewhere(clearing);
    const n = Math.round(range(2, 5));
    for (let j = 0; j < n; j++) add(kind, ...around(cx, cz, 0.08), range(0.8, 1.15));
  }
  for (let i = 0; i < 14; i++) {
    const [cx, cz] = somewhere(clearing);
    const n = Math.round(range(1, 4));
    for (let j = 0; j < n; j++) add('tomato', ...around(cx, cz, 0.1), range(0.8, 1.2));
  }
  // The forest floor: ferns everywhere, grass in the lighter gaps.
  for (let i = 0; i < 70; i++) {
    const [cx, cz] = somewhere(forestCover);
    const n = Math.round(range(2, 5));
    for (let j = 0; j < n; j++) add('fern', ...around(cx, cz, 0.25), range(0.8, 1.25));
  }
  for (let i = 0; i < 55; i++) {
    const [cx, cz] = somewhere(forestCover);
    for (let j = 0; j < 6; j++) add('grass', ...around(cx, cz, 0.12), range(0.8, 1.2));
  }
  // The back of the beach: mats of carpetweed, and morning glory running out over the sand.
  for (let i = 0; i < 70; i++) add('sesuvium', ...somewhere(sandEdge), range(0.6, 1.1));
  for (let i = 0; i < 25; i++) {
    const [cx, cz] = somewhere(openSand);
    const n = Math.round(range(3, 8));
    for (let j = 0; j < n; j++) add('ipomoea', ...around(cx, cz, 0.15), range(0.8, 1.2));
  }
  // The lava: Tiquilia in scattered mounds.
  for (let i = 0; i < 30; i++) {
    const [cx, cz] = somewhere(bareLava);
    const n = Math.round(range(2, 6));
    for (let j = 0; j < n; j++) add('tiquilia', ...around(cx, cz, 0.12), range(0.7, 1.3));
  }
  return out;
}
