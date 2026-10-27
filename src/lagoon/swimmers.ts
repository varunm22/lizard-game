import * as THREE from 'three';
import { wrapAngle } from '../math/angles';
import { toonGradient } from '../render/toon';
import { rng } from '../world/noise';
import { WATER_Y } from '../world/shore';
import type { HeronPrey } from './herons';
import { depthAt, POOLS } from './layout';

/**
 * Blacktip reef shark pups and golden cownose rays cruising the deeper pools, as in the real
 * mangrove nurseries. Each keeps to its own pool, wandering between random points deep enough to swim
 * over. They have no colliders: drawn and steered here, the body wave (sharks) and the wing flap
 * (rays) done in the vertex shader from each one's own phase, speed and turn.
 *
 * A shark pup is curious about a lizard swimming in its pool: now and then it comes over and circles
 * it, closer as it gets bolder, and once in a while, out of mild aggression, it tenses and darts in to
 * bite. A lizard that suddenly turns to swim straight at a pup close by startles it into a bite; one
 * that swims at it steadily just makes it bolt. A bite takes health, like a heron's stab.
 *
 * The rays gather into loose schools that form and break up again (each ray drifts between keeping
 * company and going its own way) and veer off from a swimming lizard heading at them close.
 */

type Kind = 'shark' | 'ray';
export type SharkState = 'cruise' | 'curious' | 'tense' | 'bite' | 'bolt';
export type RayState = 'solo' | 'school' | 'shy';

/** Shark pup tuning: distances in m, speeds in m/s, times in s, rates per second. */
export const SHARK = {
  cruise: 0.09,
  /** Circling a lizard: its speed, the circle's radius at first and at its boldest. */
  curious: 0.1,
  orbit: [0.42, 0.2] as const,
  /** How near a swimming lizard draws a pup over, the chance per second it does, and how long it stays. */
  interest: 1.1,
  takeInterest: 0.35,
  stay: [7, 13] as const,
  /** While circling, the chance per second of a bite out of mild aggression, once closer than this. */
  nip: 0.07,
  nipRange: 0.32,
  /** Tensing before a bite, the dart, and the bite's reach from the snout. */
  tense: 0.3,
  dart: 0.45,
  dartTime: 0.7,
  bite: 0.045,
  /** A lizard swimming at it within this, and turning this much in the last half second, startles it. */
  startle: 0.3,
  sudden: 0.7,
  /** Bolting off, and how long before it takes an interest again. */
  bolt: 0.35,
  boltTime: 1.4,
  cool: [5, 10] as const,
  coolFed: 20,
  turn: 1.1,
};

/** Ray tuning. */
export const RAY = {
  speed: 0.065,
  /** Neighbours within this school; closer than `space` they spread out. */
  near: 0.55,
  space: 0.13,
  /** Seconds between changes of mind about keeping company (random between). */
  mood: [4, 11] as const,
  /** A swimming lizard heading at a ray within `shy`, or anywhere within `close`, sends it off. */
  shy: 0.36,
  close: 0.15,
  flee: 0.2,
  turn: 1.5,
};

/** Only water deeper than this is swum through (m). */
const MIN_DEPTH = 0.1;

export interface Swimmer {
  kind: Kind;
  pool: number;
  state: SharkState | RayState;
  pos: THREE.Vector3;
  yaw: number;
  speed: number;
  /** Turn rate (radians/s), smoothed: the body curves (sharks) or banks (rays) into it. */
  turning: number;
  goal: { x: number; z: number };
  mesh: THREE.Mesh;
  prev: THREE.Vector3;
  prevYaw: number;
  timer: number;
  /** Seconds before a shark takes an interest again; a ray's time to its next change of mind. */
  cool: number;
  /** Which way a shark circles (1 or -1), and how bold it has grown (0 to 1). */
  orbit: number;
  bold: number;
  /** The vertex shader's inputs: beat or flap phase, its size, the curve into a turn. */
  uniforms: { phase: { value: number }; amp: { value: number }; bend: { value: number } };
  /** Rays: a beat of gliding between bouts of flapping (0 flapping to 1 gliding). */
  glide: number;
  bites: number;
}

/** A toon material that bends its mesh: a wave down the shark's body, the ray's wings flapping in a wave and its tail trailing. */
function swimMaterial(kind: Kind, uniforms: Swimmer['uniforms'], length: number, nose: number, span: number) {
  const m = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float phase;\nuniform float amp;\nuniform float bend;')
      .replace(
        '#include <begin_vertex>',
        kind === 'shark'
          ? /* glsl */ `#include <begin_vertex>
            // Along the body from the snout (0) to the tail tip (1): a wave travelling back, small at
            // the head and growing to the tail, and the whole body curved into a turn.
            float back = clamp((${nose.toFixed(4)} - transformed.z) / ${length.toFixed(4)}, 0.0, 1.0);
            transformed.x += amp * (0.12 + 0.88 * back * back) * sin(phase - back * 5.2);
            transformed.x += bend * transformed.z * transformed.z * 0.5;`
          : /* glsl */ `#include <begin_vertex>
            // The wings rise and fall in a wave running back along them; the body banks into a turn
            // and the tail swings out behind it.
            float wing = min(1.0, abs(transformed.x) / ${span.toFixed(4)});
            transformed.y += amp * pow(wing, 1.5) * sin(phase + transformed.z * ${(2.4 / span).toFixed(2)});
            transformed.y -= bend * 0.18 * transformed.x;
            float tail = max(0.0, ${(nose - length * 0.75).toFixed(4)} - transformed.z);
            transformed.x -= bend * 4.0 * tail * tail;`,
      );
  };
  // Shark and ray shaders differ, though the hook's source is the same.
  m.customProgramCacheKey = () => `swim-${kind}`;
  return m;
}

export class Swimmers {
  readonly list: Swimmer[] = [];
  paused = false;
  /** The lizard, set once the run has made it; nothing bites or shies away before. */
  prey: HeronPrey | null = null;
  /** Called as a shark pup bites the lizard. */
  onBite: ((s: Swimmer) => void) | null = null;
  private rand = rng(91);
  /** Whether the lizard is beside a shark pup, and among the rays, this step (goals). */
  nearShark = false;
  nearRay = false;
  /** How much the lizard has turned lately (radians, fading over half a second): a sudden turn startles a pup. */
  turned = 0;
  private lastYaw: number | null = null;
  /** Each kind's snout ahead of its middle (m). */
  private nose: Record<Kind, number> = { shark: 0, ray: 0 };
  private feet = new THREE.Vector3();

  constructor(geometry: Map<string, THREE.BufferGeometry>, scene: THREE.Scene) {
    const centre = (g: THREE.BufferGeometry) => {
      const c = g.clone();
      c.computeBoundingBox();
      const b = c.boundingBox!;
      // Nose at z = 0, the body behind: put the middle of the body on the origin.
      c.translate(0, -b.min.y, -(b.min.z + b.max.z) / 2 + (b.max.z - b.min.z) * 0.08);
      c.computeBoundingBox();
      // Bent in the shader: pad the bounds so it isn't culled while flexing.
      c.computeBoundingSphere();
      c.boundingSphere!.radius += 0.05;
      return c;
    };
    const shark = centre(geometry.get('shark_pup')!);
    const ray = centre(geometry.get('golden_ray')!);
    this.nose.shark = shark.boundingBox!.max.z;
    this.nose.ray = ray.boundingBox!.max.z;
    const length = (g: THREE.BufferGeometry) => g.boundingBox!.max.z - g.boundingBox!.min.z;
    // Which pool each lives in: shark pups in the big pools, rays in little schools.
    const plan: [Kind, number][] = [
      ['shark', 0], ['shark', 1], ['shark', 4],
      ['ray', 0], ['ray', 0], ['ray', 0], ['ray', 0], ['ray', 0],
      ['ray', 1], ['ray', 1], ['ray', 1], ['ray', 1], ['ray', 1],
      ['ray', 4], ['ray', 4], ['ray', 4],
      ['ray', 3], ['ray', 3],
    ];
    plan.forEach(([kind, pool], i) => {
      const uniforms = { phase: { value: 0 }, amp: { value: 0 }, bend: { value: 0 } };
      const g = kind === 'shark' ? shark : ray;
      const mesh = new THREE.Mesh(g, swimMaterial(kind, uniforms, length(g), this.nose[kind], g.boundingBox!.max.x));
      mesh.name = `${kind}-${i}`;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      scene.add(mesh);
      const goal = this.pick(pool);
      const s: Swimmer = {
        kind, pool, state: kind === 'shark' ? 'cruise' : this.rand() < 0.6 ? 'school' : 'solo', pos: new THREE.Vector3(goal.x, 0, goal.z), yaw: this.rand() * Math.PI * 2,
        speed: kind === 'shark' ? SHARK.cruise : RAY.speed, turning: 0, goal: this.pick(pool), mesh, prev: new THREE.Vector3(), prevYaw: 0,
        timer: 0, cool: 0, orbit: 1, bold: 0, uniforms, glide: 0, bites: 0,
      };
      uniforms.phase.value = this.rand() * 10;
      s.cool = kind === 'shark' ? 2 + this.rand() * 4 : RAY.mood[0] + this.rand() * (RAY.mood[1] - RAY.mood[0]);
      s.pos.y = this.swimY(s);
      s.prev.copy(s.pos);
      s.prevYaw = s.yaw;
      this.list.push(s);
    });
    this.update(1, 0);
  }

  /** A random point in pool `i` deep enough to swim to. */
  private pick(i: number): { x: number; z: number } {
    const p = POOLS[i];
    for (let k = 0; k < 40; k++) {
      const a = this.rand() * Math.PI * 2;
      const r = Math.sqrt(this.rand()) * p.r * 0.75;
      const x = p.x + Math.sin(a) * r;
      const z = p.z + Math.cos(a) * r;
      if (depthAt(x, z) > MIN_DEPTH + 0.03) return { x, z };
    }
    return { x: p.x, z: p.z };
  }

  private between(r: readonly [number, number]) {
    return r[0] + (r[1] - r[0]) * this.rand();
  }

  /** Swimming height: rays low over the bed, sharks mid-water (up by the surface when after the lizard), never out of it. */
  private swimY(s: Swimmer) {
    const d = depthAt(s.pos.x, s.pos.z);
    if (s.kind === 'ray') return WATER_Y - d + Math.min(0.025, d * 0.3);
    const up = s.state === 'curious' || s.state === 'tense' || s.state === 'bite';
    return WATER_Y - Math.min(d - 0.02, Math.max(up ? 0.035 : 0.045, d * (up ? 0.25 : 0.45)));
  }

  /** The snout (world, at its swimming height). */
  snout(s: Swimmer, out: THREE.Vector3) {
    return out.set(s.pos.x + Math.sin(s.yaw) * this.nose[s.kind], s.pos.y + 0.012, s.pos.z + Math.cos(s.yaw) * this.nose[s.kind]);
  }

  /** Put swimmer `i` at (x, z) facing `yaw`, cruising (tests). */
  place(i: number, x: number, z: number, yaw: number) {
    const s = this.list[i];
    s.pos.set(x, 0, z);
    s.yaw = yaw;
    s.state = s.kind === 'shark' ? 'cruise' : 'solo';
    s.timer = 0;
    s.pos.y = this.swimY(s);
    s.prev.copy(s.pos);
    s.prevYaw = yaw;
  }

  /** Every swimmer to its start of a run: sharks calm. */
  calm() {
    for (const s of this.list) {
      if (s.kind !== 'shark') continue;
      s.state = 'cruise';
      s.cool = this.between(SHARK.cool);
      s.bold = 0;
    }
  }

  /** One physics step. */
  step(dt: number) {
    this.nearShark = this.nearRay = false;
    const prey = this.prey;
    let swimming = false;
    let yaw = 0;
    let speed = 0;
    if (prey) {
      prey.feet(this.feet);
      swimming = prey.swimming() && prey.huntable();
      yaw = prey.facing();
      speed = prey.speed();
      this.turned = this.turned * Math.exp(-dt / 0.5) + (this.lastYaw === null ? 0 : Math.abs(wrapAngle(yaw - this.lastYaw)));
      this.lastYaw = yaw;
    }
    if (this.paused) return;
    for (const s of this.list) {
      s.prev.copy(s.pos);
      s.prevYaw = s.yaw;
      const lx = this.feet.x - s.pos.x;
      const lz = this.feet.z - s.pos.z;
      const near = prey ? Math.hypot(lx, lz) : Infinity;
      if (swimming && near < (s.kind === 'shark' ? 0.35 : 0.4)) {
        if (s.kind === 'shark') this.nearShark = true;
        else this.nearRay = true;
      }
      // Whether the lizard is swimming at it: heading its way, and closing.
      const at = swimming && speed > 0.04 && Math.abs(wrapAngle(Math.atan2(-lx, -lz) - yaw)) < 0.6;
      const steer = s.kind === 'shark' ? this.shark(s, dt, near, lx, lz, at, swimming) : this.ray(s, dt, near, lx, lz, at, swimming);
      this.swim(s, dt, steer.want, steer.speed, steer.turn, s.state === 'bite' || s.state === 'bolt' ? 14 : 4);
    }
  }

  /** A shark pup's mind: where it wants to head, how fast, how sharply it may turn. */
  private shark(s: Swimmer, dt: number, near: number, lx: number, lz: number, at: boolean, swimming: boolean) {
    const toGoal = () => Math.atan2(s.goal.x - s.pos.x, s.goal.z - s.pos.z);
    const pool = POOLS[s.pool];
    const inPool = Math.hypot(this.feet.x - pool.x, this.feet.z - pool.z) < pool.r * 1.1 && depthAt(this.feet.x, this.feet.z) > MIN_DEPTH * 0.8;
    const reachable = swimming && inPool;
    s.cool -= dt;
    // Startled: a lizard close by that suddenly turns to swim straight at it gets bitten; one swimming at it steadily, it bolts from.
    if (reachable && at && near < SHARK.startle && s.state !== 'bite' && s.state !== 'bolt') {
      if (this.turned > SHARK.sudden) this.toBite(s);
      else if (near < SHARK.startle * 0.75) this.toBolt(s, SHARK.cool);
    }
    switch (s.state) {
      case 'cruise': {
        if (Math.hypot(s.goal.x - s.pos.x, s.goal.z - s.pos.z) < 0.08) s.goal = this.pick(s.pool);
        if (reachable && near < SHARK.interest && s.cool <= 0 && this.rand() < SHARK.takeInterest * dt) {
          s.state = 'curious';
          s.timer = this.between(SHARK.stay);
          s.orbit = this.rand() < 0.5 ? 1 : -1;
          s.bold = 0;
        }
        return { want: toGoal(), speed: SHARK.cruise, turn: SHARK.turn };
      }
      case 'curious': {
        s.timer -= dt;
        if (!reachable || s.timer <= 0) {
          s.state = 'cruise';
          s.cool = this.between(SHARK.cool);
          s.goal = this.pick(s.pool);
          return { want: toGoal(), speed: SHARK.cruise, turn: SHARK.turn };
        }
        s.bold = Math.min(1, s.bold + dt / 6);
        // Round the lizard: aim for a point a little further round the circle than it is now.
        const r = SHARK.orbit[0] + (SHARK.orbit[1] - SHARK.orbit[0]) * s.bold;
        const a = Math.atan2(-lx, -lz) + s.orbit * 0.7;
        const tx = this.feet.x + Math.sin(a) * r;
        const tz = this.feet.z + Math.cos(a) * r;
        if (near < SHARK.nipRange && this.rand() < SHARK.nip * s.bold * dt) {
          s.state = 'tense';
          s.timer = SHARK.tense;
        }
        return { want: Math.atan2(tx - s.pos.x, tz - s.pos.z), speed: SHARK.curious, turn: SHARK.turn };
      }
      case 'tense': {
        // A beat of stillness turning to face it, then the dart.
        s.timer -= dt;
        if (s.timer <= 0) this.toBite(s);
        return { want: Math.atan2(lx, lz), speed: SHARK.cruise * 0.4, turn: SHARK.turn * 2.5 };
      }
      case 'bite': {
        s.timer -= dt;
        const tip = this.snout(s, new THREE.Vector3());
        const prey = this.prey!;
        // The snout, or the jaws a little behind it as the head whips round, on the lizard's head, middle or hips.
        const fx = Math.sin(prey.facing());
        const fz = Math.cos(prey.facing());
        const jx = tip.x - Math.sin(s.yaw) * 0.04;
        const jz = tip.z - Math.cos(s.yaw) * 0.04;
        const hit =
          reachable &&
          [0.06, 0, -0.05].some((k) => {
            const px = this.feet.x + fx * k;
            const pz = this.feet.z + fz * k;
            return Math.hypot(tip.x - px, tip.z - pz) < SHARK.bite || Math.hypot(jx - px, jz - pz) < SHARK.bite;
          });
        if (hit) {
          s.bites++;
          prey.struck('shark', Math.sin(s.yaw), Math.cos(s.yaw));
          this.onBite?.(s);
          this.toBolt(s, [SHARK.coolFed, SHARK.coolFed]);
        } else if (s.timer <= 0 || !reachable) this.toBolt(s, SHARK.cool);
        // Lead it a little.
        const ahead = prey.speed() * 0.15;
        const tx = this.feet.x + Math.sin(prey.facing()) * ahead;
        const tz = this.feet.z + Math.cos(prey.facing()) * ahead;
        return { want: Math.atan2(tx - s.pos.x, tz - s.pos.z), speed: SHARK.dart, turn: SHARK.turn * 7 };
      }
      case 'bolt': {
        s.timer -= dt;
        if (s.timer <= 0) {
          s.state = 'cruise';
          s.goal = this.pick(s.pool);
        }
        return { want: Math.atan2(-lx, -lz), speed: SHARK.bolt, turn: SHARK.turn * 3 };
      }
    }
    return { want: s.yaw, speed: SHARK.cruise, turn: SHARK.turn };
  }

  private toBite(s: Swimmer) {
    s.state = 'bite';
    s.timer = SHARK.dartTime;
  }

  private toBolt(s: Swimmer, cool: readonly [number, number]) {
    s.state = 'bolt';
    s.timer = SHARK.boltTime;
    s.cool = this.between(cool);
    s.bold = 0;
  }

  /** A ray's mind: keep company or go alone, and shy off from a lizard heading at it. */
  private ray(s: Swimmer, dt: number, near: number, lx: number, lz: number, at: boolean, swimming: boolean) {
    s.cool -= dt;
    if (s.cool <= 0) {
      s.cool = this.between(RAY.mood);
      if (s.state !== 'shy') s.state = s.state === 'school' ? 'solo' : 'school';
      if (s.state === 'solo') s.goal = this.pick(s.pool);
    }
    if (swimming && (near < RAY.close || (at && near < RAY.shy))) {
      s.state = 'shy';
      s.timer = 1.2;
    }
    if (s.state === 'shy') {
      s.timer -= dt;
      if (s.timer <= 0) s.state = 'school';
      // Away from the lizard, and off to the side of where it's heading.
      return { want: Math.atan2(-lx, -lz), speed: RAY.flee, turn: RAY.turn * 2.5 };
    }
    if (Math.hypot(s.goal.x - s.pos.x, s.goal.z - s.pos.z) < 0.08) s.goal = this.pick(s.pool);
    let wx = s.goal.x - s.pos.x;
    let wz = s.goal.z - s.pos.z;
    const gl = Math.hypot(wx, wz) || 1;
    wx /= gl;
    wz /= gl;
    if (s.state === 'school') {
      // Boids among the rays of its pool keeping company: in line with them, toward their middle,
      // spread out when close; the first of them leads, the rest take up its goal.
      let n = 0;
      let ax = 0;
      let az = 0;
      let cx = 0;
      let cz = 0;
      let sx = 0;
      let sz = 0;
      let leader: Swimmer | null = null;
      for (const o of this.list) {
        if (o === s || o.kind !== 'ray' || o.pool !== s.pool || o.state === 'solo') continue;
        const dx = o.pos.x - s.pos.x;
        const dz = o.pos.z - s.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > RAY.near) continue;
        leader ??= o;
        n++;
        ax += Math.sin(o.yaw);
        az += Math.cos(o.yaw);
        cx += dx;
        cz += dz;
        if (d < RAY.space && d > 1e-4) {
          sx -= (dx / d) * (RAY.space - d) / RAY.space;
          sz -= (dz / d) * (RAY.space - d) / RAY.space;
        }
      }
      if (n > 0) {
        if (leader && this.list.indexOf(leader) < this.list.indexOf(s)) s.goal = leader.goal;
        wx = wx * 0.6 + (ax / n) * 0.8 + (cx / n) * 1.5 + sx * 3;
        wz = wz * 0.6 + (az / n) * 0.8 + (cz / n) * 1.5 + sz * 3;
      }
    }
    return { want: Math.atan2(wx, wz), speed: RAY.speed * (s.state === 'school' ? 1.1 : 1), turn: RAY.turn };
  }

  /** Swim on: turn toward `want` (away from shallows ahead), ease to `speed`, keep to water deep enough. */
  private swim(s: Swimmer, dt: number, want: number, speed: number, turn: number, snap: number) {
    const look = s.kind === 'shark' ? 0.2 : 0.16;
    for (const t of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
      const a = want + t;
      if (depthAt(s.pos.x + Math.sin(a) * look, s.pos.z + Math.cos(a) * look) > MIN_DEPTH) {
        want = a;
        break;
      }
    }
    const d = wrapAngle(want - s.yaw);
    // Ease into and out of turns: the turn rate follows what's wanted, it doesn't snap.
    const rate = Math.max(-turn, Math.min(turn, d * 2.5 * (snap > 4 ? 3 : 1)));
    s.turning += (rate - s.turning) * Math.min(1, dt * snap);
    s.yaw = wrapAngle(s.yaw + s.turning * dt);
    s.speed += (speed - s.speed) * Math.min(1, dt * (speed > s.speed ? (snap > 4 ? 8 : 3) : 1.5));
    const nx = s.pos.x + Math.sin(s.yaw) * s.speed * dt;
    const nz = s.pos.z + Math.cos(s.yaw) * s.speed * dt;
    if (depthAt(nx, nz) > MIN_DEPTH * 0.8) s.pos.set(nx, 0, nz);
    else s.goal = this.pick(s.pool);
    const y = this.swimY(s);
    s.pos.y += (y - s.pos.y) * Math.min(1, dt * 2);
  }

  /** Each frame: drawn between steps; the body wave and the wing beat. */
  update(alpha: number, frameDt: number) {
    for (const s of this.list) {
      s.mesh.position.lerpVectors(s.prev, s.pos, alpha);
      s.mesh.rotation.y = s.prevYaw + wrapAngle(s.yaw - s.prevYaw) * alpha;
      const u = s.uniforms;
      if (s.kind === 'shark') {
        // Beats quicken and widen with speed; tensing, the body flexes hard and slow.
        const tense = s.state === 'tense';
        const hz = tense ? 0.8 : 1.1 + 5 * s.speed;
        u.phase.value += frameDt * Math.PI * 2 * hz;
        const amp = tense ? 0.03 : 0.008 + 0.05 * s.speed;
        u.amp.value += (amp - u.amp.value) * Math.min(1, frameDt * 4);
        // Curved into a turn, a fraction of the path's own curve: a pup is supple, not a hoop.
        const bend = Math.max(-1.6, Math.min(1.6, (0.35 * s.turning) / Math.max(0.05, s.speed)));
        u.bend.value += (bend - u.bend.value) * Math.min(1, frameDt * 5);
      } else {
        // Bouts of flapping and gliding; quicker and deeper when fleeing.
        const hurried = s.state === 'shy';
        const gliding = !hurried && Math.sin(u.phase.value * 0.13 + s.pool) > 0.55;
        s.glide += ((gliding ? 1 : 0) - s.glide) * Math.min(1, frameDt * 1.5);
        u.phase.value += frameDt * Math.PI * 2 * (hurried ? 2.2 : 0.9 - 0.5 * s.glide);
        const amp = (hurried ? 0.016 : 0.011) * (1 - 0.75 * s.glide);
        u.amp.value += (amp - u.amp.value) * Math.min(1, frameDt * 3);
        u.bend.value += (s.turning - u.bend.value) * Math.min(1, frameDt * 3);
        // The body heaves a little against each downstroke.
        s.mesh.position.y -= Math.cos(u.phase.value) * u.amp.value * 0.15;
      }
    }
  }
}
