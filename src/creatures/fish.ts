import * as THREE from 'three';
import { toonGradient } from '../render/toon';
import { rng } from '../world/noise';
import { OCEAN_X0, WATER_Y } from '../world/shore';
import { TERRAIN_SIZE } from '../world/terrain';
import type { Obstacle } from '../world/obstacles';
import type { SeaBed } from '../world/seaBed';

/**
 * Reef fish, from assets-src/reef.py: shoals of black-striped salema out in open water, little
 * schools of sergeant majors round the sunken boulders, yellowtail surgeonfish grazing along the
 * bottom, and king angelfish in pairs by the rocks. Drawn, not simulated: no colliders. Each school
 * drifts round its home on a slowly wandering heading, its fish keeping together and apart like a
 * real school, at its own height over the bottom (`SeaBed`), and never into the shallows, a rock or
 * out of the water. Anything big swimming at them (the lizard, another iguana) scatters them: each
 * fish within its kind's `fear` darts away and slows again once clear. But a lizard that keeps still
 * under water a while (`CALM_TIME`) only scares fish that all but touch it, and now and then one comes
 * over to look at it, hovering just off its snout for a few seconds: a quick bite then can touch it
 * (`touch`, the "Touch a fish" goal). Every bite startles the fish round the mouth. Bodies wave side to side in
 * the vertex shader, faster when they swim faster. Stepped at the fixed rate with their own random
 * numbers, drawn interpolated. They cost little, so tests leave them swimming.
 */
export type FishSpecies = 'salema' | 'sergeant' | 'surgeon' | 'angel';

interface Kind {
  mesh: string;
  /** Schools of how many fish. */
  schools: number;
  size: number;
  /** Cruising and darting speed (m/s). */
  cruise: number;
  dash: number;
  /** How high over the bottom the school swims, from-to (m). */
  band: readonly [number, number];
  /** It wanders this far from home before turning back (m). */
  leash: number;
  /** How close neighbours keep (m), and how near a threat may come before it darts (m). */
  spacing: number;
  fear: number;
  /** Where it lives: out over open water, or by a sunken boulder. */
  home: 'open' | 'rock';
}

const KINDS: Record<FishSpecies, Kind> = {
  salema: { mesh: 'fish_salema', schools: 4, size: 18, cruise: 0.07, dash: 0.4, band: [0.06, 0.25], leash: 0.45, spacing: 0.024, fear: 0.22, home: 'open' },
  sergeant: { mesh: 'fish_sergeant', schools: 4, size: 8, cruise: 0.045, dash: 0.35, band: [0.025, 0.12], leash: 0.25, spacing: 0.035, fear: 0.17, home: 'rock' },
  surgeon: { mesh: 'fish_surgeon', schools: 3, size: 6, cruise: 0.05, dash: 0.4, band: [0.018, 0.05], leash: 0.5, spacing: 0.06, fear: 0.2, home: 'rock' },
  angel: { mesh: 'fish_angel', schools: 3, size: 2, cruise: 0.035, dash: 0.3, band: [0.03, 0.09], leash: 0.2, spacing: 0.07, fear: 0.16, home: 'rock' },
};

const SEED = 83;
/** Keep this far under the surface, and the body this share of its length clear of the bottom. */
const SURFACE_GAP = 0.012;
const BED_GAP = 0.35;
/** Water shallower than this isn't swum into (m). */
const SHALLOWEST = 0.05;
/** A fish that darted stays quick this long after (s). */
const PANIC = 1.2;
/** How hard a fish looks ahead for shallows (s of travel). */
const LOOK_AHEAD = 0.6;
const EDGE = TERRAIN_SIZE / 2 - 0.1;
/** A threat moving slower than this (m/s) for this long (s) is calm: it only scares fish within CALM_FEAR (m) of its middle. */
const STILL_SPEED = 0.01;
const CALM_TIME = 2;
const CALM_FEAR = 0.05;
/**
 * A calm lizard under water draws a curious fish from within CURIOUS_RANGE (m) now and then (chance
 * per second); it swims over (giving up after APPROACH seconds), hovers facing it, its nose HOVER (m) ahead of the snout and a little below it for
 * INSPECT seconds (from-to), then goes back to its school and won't come again for REST seconds.
 */
const CURIOUS_RANGE = 0.8;
const CURIOUS_RATE = 0.8;
const APPROACH = 8;
const HOVER = 0.008;
/** It hangs this much lower than the snout (m), about where the bite's lunge comes down. */
const HOVER_LOW = 0.006;
const INSPECT = [3, 6] as const;
const REST = 6;
/** A bite startles every fish within this of the snout (m). */
const STARTLE = 0.15;

/** Something the fish keep away from (its middle), and, for the lizard, its snout, which a curious fish comes to look at. */
export interface Threat {
  pos: THREE.Vector3;
  snout?: { x: number; y: number; z: number };
}

interface Fish {
  species: FishSpecies;
  school: School;
  length: number;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  prevYaw: number;
  pitch: number;
  prevPitch: number;
  scale: number;
  /** Its own height in the school, above or below the school's (m). */
  lift: number;
  /** Seconds left looking at a calm lizard's snout once there (0 when it isn't), how long it has left to get there, and before it will come again. */
  inspect: number;
  approach: number;
  rest: number;
  /** Tail beat phase (radians), and how long it stays quick after a fright (s). */
  phase: number;
  panic: number;
}

interface School {
  kind: Kind;
  species: FishSpecies;
  home: THREE.Vector3;
  fish: Fish[];
  /** The way the school is heading (radians), and its height over the bottom (m). */
  heading: number;
  height: number;
  centre: THREE.Vector3;
}

interface Batch {
  mesh: THREE.InstancedMesh;
  swim: THREE.InstancedBufferAttribute;
  fish: Fish[];
}

export class Fishes {
  readonly list: Fish[] = [];
  private schools: School[] = [];
  private batches: Batch[] = [];
  private rand = rng(SEED + 1);
  /** How long each threat has kept still (s), and where it was last step. */
  private still: number[];
  private last: THREE.Vector3[];
  private hover = new THREE.Vector3();
  private snout = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private spot = new THREE.Vector3();

  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private want = new THREE.Vector3();
  private away = new THREE.Vector3();

  /**
   * `geometry` maps each kind's mesh name to its geometry, `extras` gives its length; `rocks` are where
   * the rock-dwellers make their homes; `threats` are what the fish shy from (live positions).
   */
  constructor(
    scene: THREE.Scene,
    geometry: Map<string, THREE.BufferGeometry>,
    extras: Map<string, Record<string, number>>,
    rocks: readonly Obstacle[],
    private bed: SeaBed,
    private threats: readonly Threat[],
  ) {
    this.still = threats.map(() => 0);
    this.last = threats.map((t) => t.pos.clone());
    const rand = rng(SEED);
    const range = (a: number, b: number) => a + (b - a) * rand();
    const depth = (x: number, z: number) => WATER_Y - bed.at(x, z);
    const homes: THREE.Vector3[] = [];
    const wet = rocks.filter((o) => o.kind === 'rock' && depth(o.position.x + o.radius * 1.3, o.position.z) > 0.14);
    for (const [species, kind] of Object.entries(KINDS) as [FishSpecies, Kind][]) {
      const g = geometry.get(kind.mesh);
      if (!g) throw new Error(`reef.glb has no ${kind.mesh}`);
      const length = extras.get(kind.mesh)?.length ?? 0.05;
      const fish: Fish[] = [];
      for (let k = 0; k < kind.schools; k++) {
        // One school in each stretch of the coast, north to south, so there are fish everywhere.
        const z0 = -EDGE + ((2 * EDGE) / kind.schools) * k;
        const z1 = z0 + (2 * EDGE) / kind.schools;
        let home: THREE.Vector3 | null = null;
        for (let i = 0; i < 400 && !home; i++) {
          let x: number;
          let z: number;
          if (kind.home === 'rock' && i < 300) {
            const near = wet.filter((o) => o.position.z > z0 && o.position.z < z1);
            if (!near.length) continue;
            const o = near[Math.floor(rand() * near.length)];
            const a = range(0, 2 * Math.PI);
            x = o.position.x + Math.cos(a) * (o.radius + 0.06);
            z = o.position.z + Math.sin(a) * (o.radius + 0.06);
          } else {
            x = range(1.8, EDGE - 0.2);
            z = range(z0, z1);
          }
          if (Math.abs(z) > EDGE - 0.1 || x > EDGE - 0.1 || depth(x, z) < (kind.home === 'open' ? 0.22 : 0.14)) continue;
          if (homes.some((h) => Math.hypot(h.x - x, h.z - z) < 0.35)) continue;
          home = new THREE.Vector3(x, 0, z);
        }
        if (!home) continue;
        homes.push(home);
        const school: School = { kind, species, home, fish: [], heading: range(0, 2 * Math.PI), height: range(...kind.band), centre: home.clone() };
        for (let i = 0; i < kind.size; i++) {
          const a = range(0, 2 * Math.PI);
          const r = kind.spacing * Math.sqrt(kind.size) * 0.6 * Math.sqrt(rand());
          const x = home.x + Math.cos(a) * r;
          const z = home.z + Math.sin(a) * r;
          const y = Math.min(WATER_Y - SURFACE_GAP, bed.at(x, z) + school.height);
          const pos = new THREE.Vector3(x, y, z);
          const yaw = school.heading + range(-0.3, 0.3);
          const f: Fish = {
            species, school, length, pos, prev: pos.clone(), vel: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(kind.cruise),
            yaw, prevYaw: yaw, pitch: 0, prevPitch: 0, scale: range(0.85, 1.15), lift: range(-1, 1) * kind.spacing * 1.5, phase: range(0, 2 * Math.PI), panic: 0, inspect: 0, approach: 0, rest: 0,
          };
          school.fish.push(f);
          fish.push(f);
          this.list.push(f);
        }
        this.schools.push(school);
      }
      const mesh = new THREE.InstancedMesh(g, swimMaterial(species, g), fish.length);
      mesh.name = `fish-${species}`;
      // The fish roam the whole sea: never cull the batch as one.
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
    const { want, away, hover } = this;
    this.threats.forEach((t, i) => {
      this.still[i] = t.pos.distanceTo(this.last[i]) < STILL_SPEED * dt ? this.still[i] + dt : 0;
      this.last[i].copy(t.pos);
    });
    // A calm lizard under water: now and then the nearest fish free to come looks at its snout.
    const li = this.threats.findIndex((t, i) => t.snout && t.pos.y < WATER_Y - 0.01 && this.still[i] > CALM_TIME);
    const lure = li >= 0 ? this.threats[li] : null;
    if (lure?.snout) {
      const snout = lure.snout;
      const fwd = away.set(snout.x - lure.pos.x, 0, snout.z - lure.pos.z).normalize();
      this.snout.set(snout.x, snout.y, snout.z);
      this.fwd.copy(fwd);
      hover.set(snout.x + fwd.x * HOVER, snout.y - HOVER_LOW, snout.z + fwd.z * HOVER);
      if (!this.list.some((f) => f.inspect > 0) && this.rand() < dt * CURIOUS_RATE) {
        let best: Fish | null = null;
        for (const f of this.list) {
          if (f.panic > 0 || f.rest > 0 || f.pos.distanceTo(hover) > CURIOUS_RANGE) continue;
          if (!best || f.pos.distanceTo(hover) < best.pos.distanceTo(hover)) best = f;
        }
        if (best) [best.inspect, best.approach] = [INSPECT[0] + (INSPECT[1] - INSPECT[0]) * this.rand(), APPROACH];
      }
    } else {
      for (const f of this.list) if (f.inspect > 0) [f.inspect, f.rest] = [0, REST];
    }
    for (const school of this.schools) {
      const { kind, fish, centre } = school;
      centre.set(0, 0, 0);
      for (const f of fish) centre.add(f.pos);
      centre.multiplyScalar(1 / fish.length);
      // The school wanders, and heads back round toward home once it strays past its leash.
      school.heading += (this.rand() - 0.5) * 2 * dt * 0.9;
      const hx = school.home.x - centre.x;
      const hz = school.home.z - centre.z;
      const out = Math.hypot(hx, hz) - kind.leash;
      if (out > 0) school.heading = turnToward(school.heading, Math.atan2(hx, hz), dt * Math.min(2, out * 8));
      school.height = clamp(school.height + (this.rand() - 0.5) * dt * 0.02, kind.band[0], kind.band[1]);

      for (const f of fish) {
        f.prev.copy(f.pos);
        f.prevYaw = f.yaw;
        f.prevPitch = f.pitch;
        const { pos, vel } = f;
        const floor = this.bed.at(pos.x, pos.z);
        // Cruise along the school's heading, drawn back in once it drifts off the edge of the school.
        want.set(Math.sin(school.heading), 0, Math.cos(school.heading)).multiplyScalar(kind.cruise);
        const cx = centre.x - pos.x;
        const cz = centre.z - pos.z;
        const off = Math.hypot(cx, cz);
        const loose = kind.spacing * Math.sqrt(kind.size) * 0.6;
        if (off > loose) {
          want.x += (cx / off) * (off - loose) * 1.5;
          want.z += (cz / off) * (off - loose) * 1.5;
        }
        // Keep a little room from each neighbour.
        for (const o of fish) {
          if (o === f) continue;
          const dx = pos.x - o.pos.x;
          const dy = pos.y - o.pos.y;
          const dz = pos.z - o.pos.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > kind.spacing * kind.spacing || d2 < 1e-10) continue;
          const push = (kind.spacing / Math.sqrt(d2) - 1) * kind.cruise * 1.5;
          want.x += dx * push / kind.spacing;
          want.y += dy * push / kind.spacing;
          want.z += dz * push / kind.spacing;
        }
        // Rise or sink to the school's height over the bottom, never too near the surface.
        const target = Math.min(WATER_Y - SURFACE_GAP - 0.01, floor + school.height + f.lift);
        want.y += clamp((target - pos.y) * 2, -kind.cruise * 0.6, kind.cruise * 0.6);
        f.rest = Math.max(0, f.rest - dt);
        if (f.inspect > 0) {
          // Come over and hang nose to nose with the calm lizard a while.
          const spot = this.spot.copy(hover).addScaledVector(this.fwd, (f.length / 2) * f.scale);
          if (pos.distanceTo(spot) < 0.015) f.inspect -= dt;
          else if ((f.approach -= dt) <= 0) f.inspect = 0;
          if (f.inspect <= 0) [f.inspect, f.rest] = [0, REST];
          want.subVectors(spot, pos).multiplyScalar(3);
          const l = want.length();
          if (l > kind.cruise * 1.6) want.multiplyScalar((kind.cruise * 1.6) / l);
        }
        // Dart away from anything big coming close; a calm one only from right beside it.
        let fright = 0;
        this.threats.forEach((t, i) => {
          const fear = this.still[i] > CALM_TIME ? CALM_FEAR : kind.fear;
          away.subVectors(pos, t.pos);
          const d = away.length();
          if (d > fear || d < 1e-6) return;
          away.y *= 0.4;
          away.normalize().multiplyScalar(kind.dash * (1.2 - d / fear));
          want.add(away);
          fright = 1;
        });
        if (fright) f.inspect = 0;
        if (fright) f.panic = PANIC;
        f.panic = Math.max(0, f.panic - dt);
        // Turn away from shallows, rocks breaking the surface and the edge of the world ahead.
        const ahead = Math.max(vel.length(), kind.cruise) * LOOK_AHEAD;
        const hl = Math.hypot(vel.x, vel.z) || 1;
        const ax = pos.x + (vel.x / hl) * ahead;
        const az = pos.z + (vel.z / hl) * ahead;
        if (Math.abs(az) > EDGE - 0.15 || ax > EDGE - 0.15 || this.tooShallow(ax, az, f.length) || this.bed.at(ax, az) > pos.y - f.length * BED_GAP) {
          const tx = school.home.x - pos.x;
          const tz = school.home.z - pos.z;
          const tl = Math.hypot(tx, tz) || 1;
          want.x += (tx / tl) * kind.cruise * 3;
          want.z += (tz / tl) * kind.cruise * 3;
          want.y += kind.cruise * 0.5;
        }
        // Ease toward what it wants, quicker and faster when frightened.
        const quick = f.panic > 0;
        const top = quick ? kind.dash : kind.cruise * 1.8;
        const len = want.length();
        if (len > top) want.multiplyScalar(top / len);
        vel.lerp(want, Math.min(1, dt * (quick ? 7 : 2.2)));
        pos.addScaledVector(vel, dt);
        // Hard limits: in the water, over the bottom, inside the world.
        if (this.tooShallow(pos.x, pos.z, f.length) || Math.abs(pos.z) > EDGE || pos.x > EDGE || pos.x < OCEAN_X0 + 0.1) {
          pos.x = f.prev.x;
          pos.z = f.prev.z;
          vel.x *= -0.3;
          vel.z *= -0.3;
        }
        pos.y = clamp(pos.y, this.bed.at(pos.x, pos.z) + f.length * BED_GAP, WATER_Y - SURFACE_GAP);
        // Face the way it swims, nose up or down with its climb, and beat the tail with its speed.
        const h = Math.hypot(vel.x, vel.z);
        if (f.inspect > 0 && pos.distanceTo(this.snout) < 0.08) f.yaw = turnToward(f.yaw, Math.atan2(this.snout.x - pos.x, this.snout.z - pos.z), dt * 4);
        else if (h > 0.004) f.yaw = turnToward(f.yaw, Math.atan2(vel.x, vel.z), dt * (quick ? 16 : 5));
        f.pitch += (clamp(Math.atan2(vel.y, Math.max(h, 0.01)), -0.6, 0.6) - f.pitch) * Math.min(1, dt * 4);
        f.phase += dt * 2 * Math.PI * Math.min(12, 1.5 + (1.4 * vel.length()) / f.length);
      }
    }
  }

  /**
   * A bite snapping shut at a sphere (centre x, y, z, radius r; m): whether it touched a fish. Every
   * fish near the mouth darts off, startled, the one touched included.
   */
  touch(x: number, y: number, z: number, r: number): boolean {
    let touched = false;
    const p = this.v.set(x, y, z);
    for (const f of this.list) {
      const d = f.pos.distanceTo(p);
      if (d > STARTLE) continue;
      // The fish as a segment snout to tail, as thick as its body.
      const half = (f.length / 2) * f.scale;
      const t = clamp((p.x - f.pos.x) * Math.sin(f.yaw) + (p.z - f.pos.z) * Math.cos(f.yaw), -half, half);
      const gap = Math.hypot(p.x - f.pos.x - Math.sin(f.yaw) * t, p.y - f.pos.y, p.z - f.pos.z - Math.cos(f.yaw) * t);
      if (gap < r + f.length * 0.25 * f.scale) touched = true;
      this.s.subVectors(f.pos, p).setY(0);
      if (this.s.lengthSq() < 1e-8) this.s.set(Math.sin(f.yaw), 0, Math.cos(f.yaw));
      f.vel.copy(this.s.normalize().multiplyScalar(KINDS[f.species].dash));
      [f.panic, f.inspect, f.rest] = [PANIC, 0, REST * 2];
    }
    return touched;
  }

  /** Draw every fish between its last two steps. */
  update(alpha: number) {
    const { m, q, e, v, s } = this;
    for (const b of this.batches) {
      b.fish.forEach((f, i) => {
        v.lerpVectors(f.prev, f.pos, alpha);
        e.set(-lerp(f.prevPitch, f.pitch, alpha), f.prevYaw + wrap(f.yaw - f.prevYaw) * alpha, 0);
        q.setFromEuler(e);
        m.compose(v, q, s.setScalar(f.scale));
        b.mesh.setMatrixAt(i, m);
        const speed = f.vel.length();
        b.swim.setXY(i, f.phase, f.length * clamp(0.06 + (0.5 * speed) / KINDS[f.species].dash, 0.06, 0.16));
      });
      b.mesh.instanceMatrix.needsUpdate = true;
      b.swim.needsUpdate = true;
    }
  }

  /** Whether the water at (x, z) is too shallow for a fish of this length. */
  private tooShallow(x: number, z: number, length: number) {
    return WATER_Y - this.bed.at(x, z) < Math.max(SHALLOWEST, length * (BED_GAP + 0.6) + SURFACE_GAP);
  }
}

/** Toon shading with the body waving side to side, from nothing at the snout to most at the tail. */
function swimMaterial(species: FishSpecies, geometry: THREE.BufferGeometry): THREE.Material {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient(), side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aSwim;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        float back = clamp((${box.max.z.toFixed(4)} - transformed.z) / ${(box.max.z - box.min.z).toFixed(4)}, 0.0, 1.0);
        transformed.x += aSwim.y * (0.12 + back * back) * sin(aSwim.x - back * 4.0);`,
      );
  };
  material.customProgramCacheKey = () => `fish-${species}`;
  return material;
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const turnToward = (from: number, to: number, max: number) => from + clamp(wrap(to - from), -max, max);
