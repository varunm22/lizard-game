import * as THREE from 'three';
import { rng } from '../world/noise';

/** Dust motes and feathers per strike. */
const DUST = 22;
const FEATHERS = 4;
/** Dust is thrown out this fast (m/s, from-to), mostly up and along the blow; feathers drift slower. */
const DUST_SPEED = [0.15, 0.45] as const;
const FEATHER_SPEED = [0.08, 0.2] as const;
/** Dust radius (m, from-to); a feather's length and width (m). */
const DUST_SIZE = [0.0006, 0.0014] as const;
const FEATHER = { length: 0.006, width: 0.0018 };
/** Lifetimes (s, from-to). */
const DUST_LIFE = [0.35, 0.7] as const;
const FEATHER_LIFE = [1.2, 1.8] as const;
/** Dust falls and stops fast; feathers barely fall and tumble. */
const GRAVITY = { dust: 1.2, feather: 0.12 };
const DRAG = { dust: 5, feather: 4 };

interface Bit {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  rot: THREE.Euler;
  age: number;
  life: number;
  size: number;
}

/**
 * The puff where the hawk's talons hit: a burst of dust kicked up off the lizard and the ground, and a
 * few of the hawk's feathers that tumble down after it. Drawn only.
 */
export class StrikePuff {
  private dust: THREE.InstancedMesh;
  private feathers: THREE.InstancedMesh;
  private motes: Bit[] = [];
  private plumes: Bit[] = [];
  private rand = rng(53);
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.dust = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0xc9b9a0 }), DUST * 2);
    const feather = new THREE.PlaneGeometry(FEATHER.width, FEATHER.length);
    this.feathers = new THREE.InstancedMesh(feather, new THREE.MeshLambertMaterial({ color: 0x5a4636, side: THREE.DoubleSide }), FEATHERS * 2);
    for (const mesh of [this.dust, this.feathers]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(mesh);
    }
  }

  /** Bits in the air now. */
  get live() {
    return this.motes.length + this.plumes.length;
  }

  /** A strike landing at `at`, the blow travelling along `dir` (unit, level). */
  burst(at: THREE.Vector3, dir: THREE.Vector3) {
    const r = () => this.rand() * 2 - 1;
    const between = (range: readonly [number, number]) => range[0] + (range[1] - range[0]) * this.rand();
    const bit = (speed: number, along: number, size: number, life: number): Bit => ({
      pos: at.clone().add(new THREE.Vector3(r(), 0, r()).multiplyScalar(0.006)),
      vel: new THREE.Vector3(r(), 0.6 + 0.6 * this.rand(), r()).normalize().addScaledVector(dir, along).normalize().multiplyScalar(speed),
      spin: new THREE.Vector3(r(), r(), r()).multiplyScalar(12),
      rot: new THREE.Euler(r() * 3, r() * 3, r() * 3),
      age: 0,
      life,
      size,
    });
    this.motes = this.motes.slice(-DUST);
    this.plumes = this.plumes.slice(-FEATHERS);
    for (let i = 0; i < DUST; i++) this.motes.push(bit(between(DUST_SPEED), 0.8, between(DUST_SIZE), between(DUST_LIFE)));
    for (let i = 0; i < FEATHERS; i++) this.plumes.push(bit(between(FEATHER_SPEED), 0.3, 1, between(FEATHER_LIFE)));
  }

  update(dt: number) {
    this.motes = this.motes.filter((b) => (b.age += dt) < b.life);
    this.plumes = this.plumes.filter((b) => (b.age += dt) < b.life);
    const move = (b: Bit, gravity: number, drag: number) => {
      b.vel.multiplyScalar(Math.exp(-drag * dt));
      b.vel.y -= gravity * dt;
      b.pos.addScaledVector(b.vel, dt);
    };
    this.motes.forEach((b, i) => {
      move(b, GRAVITY.dust, DRAG.dust);
      this.s.setScalar(b.size * Math.sqrt(1 - b.age / b.life));
      this.dust.setMatrixAt(i, this.m.compose(b.pos, this.q.identity(), this.s));
    });
    this.plumes.forEach((b, i) => {
      move(b, GRAVITY.feather, DRAG.feather);
      // Tumbling, slowing as it settles into a drift.
      const spin = Math.exp(-1.5 * b.age) * dt;
      b.rot.set(b.rot.x + b.spin.x * spin, b.rot.y + b.spin.y * spin + 2 * dt, b.rot.z + b.spin.z * spin);
      const fade = Math.min(1, 4 * (1 - b.age / b.life));
      this.s.setScalar(fade);
      this.feathers.setMatrixAt(i, this.m.compose(b.pos, this.q.setFromEuler(b.rot), this.s));
    });
    this.dust.count = this.motes.length;
    this.feathers.count = this.plumes.length;
    this.dust.instanceMatrix.needsUpdate = true;
    this.feathers.instanceMatrix.needsUpdate = true;
  }
}
