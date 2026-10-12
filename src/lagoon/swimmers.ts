import * as THREE from 'three';
import { wrapAngle } from '../math/angles';
import { toonGradient } from '../render/toon';
import { rng } from '../world/noise';
import { WATER_Y } from '../world/shore';
import { depthAt, POOLS } from './layout';

/**
 * Blacktip reef shark pups and golden cownose rays cruising the deeper pools, as in the real
 * mangrove nurseries. Each keeps to its own pool, wandering between random points deep enough to swim
 * over, turning gently; a shark pup darts away from a lizard swimming close. They have no colliders:
 * drawn and steered here, with the tail beat (sharks) and the wing flap (rays) done in the vertex
 * shader. Nothing here touches the lizard.
 */

type Kind = 'shark' | 'ray';

/** Cruising and fleeing speeds (m/s), the turn rate (radians/s), how close the lizard spooks a shark (m). */
const SPEED: Record<Kind, number> = { shark: 0.11, ray: 0.07 };
const FLEE = 0.3;
const SPOOK = 0.3;
const TURN = 1.4;
/** Only water deeper than this is swum through (m). */
const MIN_DEPTH = 0.1;

export interface Swimmer {
  kind: Kind;
  pool: number;
  pos: THREE.Vector3;
  yaw: number;
  speed: number;
  goal: { x: number; z: number };
  mesh: THREE.Mesh;
  prev: THREE.Vector3;
  prevYaw: number;
  phase: number;
}

/** A toon material that bends its mesh: the shark's tail beat side to side, the ray's wings up and down. */
function swimMaterial(kind: Kind, time: { value: number }) {
  const m = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.time = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float time;')
      .replace(
        '#include <begin_vertex>',
        kind === 'shark'
          ? /* glsl */ `#include <begin_vertex>
            float seed = modelMatrix[3].x * 3.1 + modelMatrix[3].z * 1.7;
            float back = clamp(-transformed.z / 0.2, 0.0, 1.0);
            transformed.x += sin(time * 9.0 + seed - back * 5.0) * 0.03 * back * back;`
          : /* glsl */ `#include <begin_vertex>
            float seed = modelMatrix[3].x * 3.1 + modelMatrix[3].z * 1.7;
            float wing = abs(transformed.x) / 0.26;
            transformed.y += sin(time * 3.2 + seed + transformed.z * 9.0) * 0.022 * wing * wing;`,
      );
  };
  return m;
}

export class Swimmers {
  readonly list: Swimmer[] = [];
  paused = false;
  private rand = rng(91);
  private time = { value: 0 };
  /** Seconds the lizard has been beside a shark pup, and with a ray, this run (goals). */
  nearShark = false;
  nearRay = false;

  constructor(geometry: Map<string, THREE.BufferGeometry>, scene: THREE.Scene) {
    const centre = (g: THREE.BufferGeometry) => {
      const c = g.clone();
      c.computeBoundingBox();
      const b = c.boundingBox!;
      // Nose at z = 0, the body behind: put the middle of the body on the origin.
      return c.translate(0, -b.min.y, -(b.min.z + b.max.z) / 2 + (b.max.z - b.min.z) * 0.08);
    };
    const shark = centre(geometry.get('shark_pup')!);
    const ray = centre(geometry.get('golden_ray')!);
    const mats: Record<Kind, THREE.Material> = { shark: swimMaterial('shark', this.time), ray: swimMaterial('ray', this.time) };
    // Which pool each lives in: shark pups in the big pools, rays in pairs and alone.
    const plan: [Kind, number][] = [
      ['shark', 0], ['shark', 1], ['shark', 4],
      ['ray', 0], ['ray', 0], ['ray', 1], ['ray', 3], ['ray', 4],
    ];
    plan.forEach(([kind, pool], i) => {
      const mesh = new THREE.Mesh(kind === 'shark' ? shark : ray, mats[kind]);
      mesh.name = `${kind}-${i}`;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      scene.add(mesh);
      const goal = this.pick(pool);
      const s: Swimmer = {
        kind, pool, pos: new THREE.Vector3(goal.x, 0, goal.z), yaw: this.rand() * Math.PI * 2, speed: SPEED[kind],
        goal: this.pick(pool), mesh, prev: new THREE.Vector3(), prevYaw: 0, phase: this.rand() * 10,
      };
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

  /** Swimming height: rays low over the bed, sharks mid-water, never out of it. */
  private swimY(s: Swimmer) {
    const d = depthAt(s.pos.x, s.pos.z);
    return s.kind === 'ray' ? WATER_Y - d + Math.min(0.03, d * 0.3) : WATER_Y - Math.max(0.045, d * 0.45);
  }

  /** One physics step, with the lizard's feet and whether it's swimming. */
  step(dt: number, lizard: THREE.Vector3, swimming: boolean) {
    this.nearShark = this.nearRay = false;
    if (this.paused) return;
    for (const s of this.list) {
      s.prev.copy(s.pos);
      s.prevYaw = s.yaw;
      const lx = lizard.x - s.pos.x;
      const lz = lizard.z - s.pos.z;
      const near = Math.hypot(lx, lz);
      if (swimming && near < (s.kind === 'shark' ? 0.35 : 0.4)) {
        if (s.kind === 'shark') this.nearShark = true;
        else this.nearRay = true;
      }
      let want = Math.atan2(s.goal.x - s.pos.x, s.goal.z - s.pos.z);
      let speed = SPEED[s.kind];
      if (s.kind === 'shark' && swimming && near < SPOOK) {
        want = Math.atan2(-lx, -lz);
        speed = FLEE;
      }
      if (Math.hypot(s.goal.x - s.pos.x, s.goal.z - s.pos.z) < 0.08) s.goal = this.pick(s.pool);
      // Turn away from shallows ahead.
      const look = 0.22;
      for (const turn of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
        const a = want + turn;
        if (depthAt(s.pos.x + Math.sin(a) * look, s.pos.z + Math.cos(a) * look) > MIN_DEPTH) {
          want = a;
          break;
        }
      }
      const d = wrapAngle(want - s.yaw);
      s.yaw = wrapAngle(s.yaw + Math.max(-TURN * dt, Math.min(TURN * dt, d)) * (speed > SPEED[s.kind] ? 2.5 : 1));
      s.speed += (speed - s.speed) * Math.min(1, dt * 2);
      const nx = s.pos.x + Math.sin(s.yaw) * s.speed * dt;
      const nz = s.pos.z + Math.cos(s.yaw) * s.speed * dt;
      if (depthAt(nx, nz) > MIN_DEPTH * 0.8) s.pos.set(nx, 0, nz);
      else s.goal = this.pick(s.pool);
      s.pos.y = this.swimY(s);
    }
  }

  /** Each frame: drawn between steps, and the tail beat and wing flap. */
  update(alpha: number, frameDt: number) {
    this.time.value += frameDt;
    for (const s of this.list) {
      s.mesh.position.lerpVectors(s.prev, s.pos, alpha);
      s.mesh.rotation.y = s.prevYaw + wrapAngle(s.yaw - s.prevYaw) * alpha;
    }
  }
}
