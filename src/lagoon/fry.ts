import * as THREE from 'three';
import { swimMaterial } from '../creatures/fish';
import { rng } from '../world/noise';
import { WATER_Y } from '../world/shore';
import { depthAt } from './layout';
import type { LagoonProps } from './props';

/**
 * Juvenile fish in the mangrove roots, the lagoon's nursery: little shoals of mullet fry and young
 * snapper, each at home among one stand's prop roots where they stand in the water. Drawn, not
 * simulated: no colliders. A fry hangs nearly still, then darts: a quick burst to a new spot by a
 * root or in the gap between two, gliding to a stop, and shoal-mates close by often dart after it.
 * They slide round the roots (`rootPosts`) rather than through them, keep to water deep enough, and
 * stay just under the surface. Anything big coming close (the lizard, a shark pup) sends the ones it
 * nears darting off into the roots on the far side. Stepped at the fixed rate with their own random
 * numbers, drawn interpolated; cheap, so tests leave them swimming.
 */
export type FrySpecies = 'mullet' | 'snapper';

const SPECIES: Record<FrySpecies, { mesh: string; dart: number }> = {
  mullet: { mesh: 'fry_mullet', dart: 0.38 },
  snapper: { mesh: 'fry_snapper', dart: 0.32 },
};

export const FRY = {
  /** Shoals at most, fry in each (from-to), and how far apart their homes keep (m). */
  shoals: 12,
  size: [6, 10] as const,
  apart: 0.5,
  /** A home needs this many roots in the water within `range` of it (m), and fry swim this far from it. */
  roots: 4,
  range: 0.28,
  /** Water shallower than this isn't swum into (m); they keep this far under the surface and over the bed. */
  shallowest: 0.022,
  surface: 0.006,
  bed: 0.006,
  /** Rest between darts (s, from-to), how long a dart's burst lasts (s), and the glide's drag (1/s). */
  rest: [0.6, 3] as const,
  burst: [0.06, 0.14] as const,
  drag: 5,
  /** Shoal-mates this near (m) may dart after one that darts, with this chance. */
  follow: 0.1,
  followChance: 0.45,
  /** How near a threat comes before they bolt (m, level), and how much faster than a dart. */
  fear: 0.17,
  bolt: 1.4,
  /** Room kept from a root's bark (m), and from shoal-mates. */
  clear: 0.006,
  spacing: 0.014,
};

const SEED = 89;

interface Post {
  x: number;
  z: number;
  r: number;
}

interface Shoal {
  species: FrySpecies;
  home: THREE.Vector3;
  posts: Post[];
  fish: Fry[];
}

export interface Fry {
  shoal: Shoal;
  length: number;
  scale: number;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  prevYaw: number;
  /** Its own height under the surface (m). */
  depth: number;
  phase: number;
  /** Time until its next dart (s), and how much of a dart's burst is left (s). */
  rest: number;
  burst: number;
  /** Where it's darting to. */
  target: THREE.Vector3;
  /** It's bolting from a threat (s left). */
  scared: number;
}

interface Batch {
  mesh: THREE.InstancedMesh;
  swim: THREE.InstancedBufferAttribute;
  fish: Fry[];
}

export class Fries {
  readonly list: Fry[] = [];
  readonly shoals: Shoal[] = [];
  /** Darts so far, all fry together. */
  darts = 0;
  paused = false;
  private batches: Batch[] = [];
  private rand = rng(SEED + 1);
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');

  /** `threats` are what they bolt from (live positions). */
  constructor(
    scene: THREE.Scene,
    geometry: Map<string, THREE.BufferGeometry>,
    extras: Map<string, Record<string, number>>,
    props: Pick<LagoonProps, 'rootPosts'>,
    private threats: readonly THREE.Vector3[],
  ) {
    const rand = rng(SEED);
    const range = (a: number, b: number) => a + (b - a) * rand();
    const posts = props.rootPosts.filter((p) => depthAt(p.x, p.z) > FRY.shallowest);
    // Homes: in the water among the roots, where enough of them stand close together.
    const order = posts.map((p) => ({ p, k: rand() })).sort((a, b) => a.k - b.k).map((o) => o.p);
    const byKind: Record<FrySpecies, Fry[]> = { mullet: [], snapper: [] };
    for (const p of order) {
      if (this.shoals.length >= FRY.shoals) break;
      const near = posts.filter((o) => Math.hypot(o.x - p.x, o.z - p.z) < FRY.range);
      if (near.length < FRY.roots) continue;
      const home = new THREE.Vector3(near.reduce((a, o) => a + o.x, 0) / near.length, 0, near.reduce((a, o) => a + o.z, 0) / near.length);
      if (depthAt(home.x, home.z) < FRY.shallowest * 1.3) continue;
      if (this.shoals.some((s) => Math.hypot(s.home.x - home.x, s.home.z - home.z) < FRY.apart)) continue;
      const species: FrySpecies = this.shoals.length % 3 === 2 ? 'snapper' : 'mullet';
      const shoal: Shoal = { species, home, posts: posts.filter((o) => Math.hypot(o.x - home.x, o.z - home.z) < FRY.range + 0.15), fish: [] };
      const length = extras.get(SPECIES[species].mesh)?.length ?? 0.026;
      const n = Math.round(range(FRY.size[0], FRY.size[1] + 0.99) - 0.49);
      for (let i = 0; i < n; i++) {
        const pos = home.clone();
        for (let k = 0; k < 20; k++) {
          const a = range(0, 2 * Math.PI);
          const r = range(0, FRY.range * 0.7);
          pos.set(home.x + Math.cos(a) * r, 0, home.z + Math.sin(a) * r);
          if (this.swimmable(shoal, pos.x, pos.z)) break;
          pos.copy(home);
        }
        const yaw = range(0, 2 * Math.PI);
        const f: Fry = {
          shoal, length, scale: range(0.8, 1.15), pos, prev: pos.clone(), vel: new THREE.Vector3(), yaw, prevYaw: yaw,
          depth: range(0.008, 0.02), phase: range(0, 2 * Math.PI), rest: range(...FRY.rest), burst: 0, target: pos.clone(), scared: 0,
        };
        pos.y = this.height(f, pos.x, pos.z);
        f.prev.copy(pos);
        shoal.fish.push(f);
        byKind[species].push(f);
        this.list.push(f);
      }
      this.shoals.push(shoal);
    }
    for (const species of Object.keys(SPECIES) as FrySpecies[]) {
      const fish = byKind[species];
      const g = geometry.get(SPECIES[species].mesh);
      if (!g) throw new Error(`lagoon.glb has no ${SPECIES[species].mesh}`);
      if (!fish.length) continue;
      const mesh = new THREE.InstancedMesh(g, swimMaterial(`fry-${species}`, g), fish.length);
      mesh.name = `fry-${species}`;
      // Spread over the lagoon's roots: never cull the batch as one.
      mesh.frustumCulled = false;
      const swim = new THREE.InstancedBufferAttribute(new Float32Array(fish.length * 2), 2);
      swim.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aSwim', swim);
      scene.add(mesh);
      this.batches.push({ mesh, swim, fish });
    }
    this.update(1);
  }

  step(dt: number) {
    if (this.paused) return;
    const rand = this.rand;
    for (const shoal of this.shoals) {
      for (const f of shoal.fish) {
        f.prev.copy(f.pos);
        f.prevYaw = f.yaw;
        const { pos, vel } = f;
        // A threat close by: bolt, away and round into the roots beyond.
        let fx = 0;
        let fz = 0;
        for (const t of this.threats) {
          const dx = pos.x - t.x;
          const dz = pos.z - t.z;
          const d = Math.hypot(dx, dz);
          if (d > FRY.fear || d < 1e-6 || Math.abs(t.y - pos.y) > 0.12) continue;
          fx += dx / d;
          fz += dz / d;
        }
        if ((fx || fz) && f.scared <= 0) {
          const l = Math.hypot(fx, fz);
          this.hide(f, fx / l, fz / l);
          this.dart(f, FRY.bolt);
          f.scared = 0.6;
        }
        f.scared = Math.max(0, f.scared - dt);
        // Resting, it hangs nearly still, fins going; rested, it darts somewhere new.
        if (f.burst <= 0 && (f.rest -= dt) <= 0) {
          this.pick(f);
          this.dart(f, 1);
          // Its shoal-mates close by often go too, after a moment.
          for (const o of shoal.fish) {
            if (o === f || o.burst > 0 || o.scared > 0 || o.pos.distanceToSquared(pos) > FRY.follow * FRY.follow) continue;
            if (rand() < FRY.followChance) {
              o.rest = Math.min(o.rest, 0.03 + rand() * 0.12);
              o.target.set(f.target.x + (rand() - 0.5) * 0.05, 0, f.target.z + (rand() - 0.5) * 0.05);
              if (!this.swimmable(shoal, o.target.x, o.target.z)) o.target.copy(f.target);
            }
          }
        }
        if (f.burst > 0) {
          // Driving hard toward the target.
          f.burst -= dt;
          const dx = f.target.x - pos.x;
          const dz = f.target.z - pos.z;
          const d = Math.hypot(dx, dz);
          const top = SPECIES[shoal.species].dart * (f.scared > 0 ? FRY.bolt : 1);
          if (d > 0.004) {
            vel.x += ((dx / d) * top - vel.x) * Math.min(1, dt * 30);
            vel.z += ((dz / d) * top - vel.z) * Math.min(1, dt * 30);
          }
        } else {
          // Gliding to a stop, drifting a little, kept from crowding.
          const k = Math.exp(-FRY.drag * dt);
          vel.x = vel.x * k + (rand() - 0.5) * dt * 0.05;
          vel.z = vel.z * k + (rand() - 0.5) * dt * 0.05;
          for (const o of shoal.fish) {
            if (o === f) continue;
            const dx = pos.x - o.pos.x;
            const dz = pos.z - o.pos.z;
            const d2 = dx * dx + dz * dz;
            if (d2 > FRY.spacing * FRY.spacing || d2 < 1e-10) continue;
            const d = Math.sqrt(d2);
            vel.x += (dx / d) * (FRY.spacing - d) * dt * 30;
            vel.z += (dz / d) * (FRY.spacing - d) * dt * 30;
          }
        }
        pos.x += vel.x * dt;
        pos.z += vel.z * dt;
        // Round the roots, not through them: slide along the bark.
        for (const p of shoal.posts) {
          const dx = pos.x - p.x;
          const dz = pos.z - p.z;
          const min = p.r + FRY.clear + f.length * 0.2;
          const d2 = dx * dx + dz * dz;
          if (d2 >= min * min) continue;
          const d = Math.sqrt(d2) || 1e-6;
          pos.x = p.x + (dx / d) * min;
          pos.z = p.z + (dz / d) * min;
          const into = (vel.x * dx + vel.z * dz) / d;
          if (into < 0) {
            vel.x -= (dx / d) * into;
            vel.z -= (dz / d) * into;
          }
        }
        // Never into the shallows.
        if (depthAt(pos.x, pos.z) < FRY.shallowest) {
          pos.x = f.prev.x;
          pos.z = f.prev.z;
          vel.x *= -0.2;
          vel.z *= -0.2;
          f.burst = 0;
        }
        pos.y += (this.height(f, pos.x, pos.z) - pos.y) * Math.min(1, dt * 6);
        // Face the way it swims, snapping round as it darts; beat the tail with its speed.
        const speed = Math.hypot(vel.x, vel.z);
        if (speed > 0.01) f.yaw = turnToward(f.yaw, Math.atan2(vel.x, vel.z), dt * (f.burst > 0 ? 40 : 6));
        f.phase += dt * 2 * Math.PI * Math.min(16, 3 + (1.2 * speed) / f.length);
      }
    }
  }

  /** Start a dart toward its target, `boost` times its usual speed. */
  private dart(f: Fry, boost: number) {
    f.burst = (FRY.burst[0] + (FRY.burst[1] - FRY.burst[0]) * this.rand()) * Math.min(1.5, boost);
    f.rest = FRY.rest[0] + (FRY.rest[1] - FRY.rest[0]) * this.rand();
    this.darts++;
  }

  /** A new spot to dart to: beside a root of its stand, or in the gap between two, or out a little from the shoal. */
  private pick(f: Fry) {
    const { shoal, target, pos } = f;
    const rand = this.rand;
    for (let k = 0; k < 12; k++) {
      const p = shoal.posts[Math.floor(rand() * shoal.posts.length)];
      if (rand() < 0.4) {
        const q = shoal.posts[Math.floor(rand() * shoal.posts.length)];
        const t = 0.3 + rand() * 0.4;
        target.set(p.x + (q.x - p.x) * t, 0, p.z + (q.z - p.z) * t);
      } else {
        const a = rand() * 2 * Math.PI;
        const r = p.r + FRY.clear + 0.01 + rand() * 0.04;
        target.set(p.x + Math.cos(a) * r, 0, p.z + Math.sin(a) * r);
      }
      const d = Math.hypot(target.x - pos.x, target.z - pos.z);
      if (d > 0.02 && d < 0.2 && Math.hypot(target.x - shoal.home.x, target.z - shoal.home.z) < FRY.range && this.swimmable(shoal, target.x, target.z)) return;
    }
    target.copy(pos);
  }

  /** A spot in the roots away from a threat that lies toward (-ax, -az), for a bolting fry. */
  private hide(f: Fry, ax: number, az: number) {
    const { shoal, target, pos } = f;
    let best = -Infinity;
    for (const p of shoal.posts) {
      const dx = p.x - pos.x;
      const dz = p.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.25) continue;
      const score = (dx * ax + dz * az) / (d || 1) - d * 2;
      if (score <= best) continue;
      // Just behind that root, from the threat's side.
      const x = p.x + ax * (p.r + FRY.clear + 0.015);
      const z = p.z + az * (p.r + FRY.clear + 0.015);
      if (!this.swimmable(shoal, x, z)) continue;
      best = score;
      target.set(x, 0, z);
    }
    if (best === -Infinity) target.set(pos.x + ax * 0.12, 0, pos.z + az * 0.12);
    if (!this.swimmable(shoal, target.x, target.z)) target.set(pos.x - az * 0.08, 0, pos.z + ax * 0.08);
  }

  /** Whether a fry may be at (x, z): deep enough, and clear of every root. */
  private swimmable(shoal: Shoal, x: number, z: number) {
    return depthAt(x, z) >= FRY.shallowest && shoal.posts.every((p) => Math.hypot(x - p.x, z - p.z) > p.r + FRY.clear + 0.004);
  }

  /** Its swimming height at (x, z): its own depth under the surface, kept over the bed. */
  private height(f: Fry, x: number, z: number) {
    const bed = WATER_Y - depthAt(x, z);
    return Math.max(bed + FRY.bed, WATER_Y - FRY.surface - f.depth);
  }

  /** Draw every fry between its last two steps. */
  update(alpha: number) {
    const { m, q, v, s, e } = this;
    for (const b of this.batches) {
      b.fish.forEach((f, i) => {
        v.lerpVectors(f.prev, f.pos, alpha);
        e.set(0, f.prevYaw + wrap(f.yaw - f.prevYaw) * alpha, 0);
        q.setFromEuler(e);
        m.compose(v, q, s.setScalar(f.scale));
        b.mesh.setMatrixAt(i, m);
        const speed = Math.hypot(f.vel.x, f.vel.z);
        b.swim.setXY(i, f.phase, f.length * clamp(0.05 + speed * 0.4, 0.05, 0.16));
      });
      b.mesh.instanceMatrix.needsUpdate = true;
      b.swim.needsUpdate = true;
    }
  }
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const turnToward = (from: number, to: number, max: number) => from + clamp(wrap(to - from), -max, max);
