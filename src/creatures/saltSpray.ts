import * as THREE from 'three';
import { rng } from '../world/noise';

/** Most droplets in the air at once. */
const MAX = 160;
/** Droplets per sneeze, and how fast they leave the nostrils (m/s, from-to). */
const PER_SNEEZE = 16;
const SPEED = [0.25, 0.5] as const;
/** Sideways scatter of the spray (m/s). */
const SPREAD = 0.12;
/** Droplet radius (m, from-to) and lifetime (s, from-to). */
const SIZE = [0.0005, 0.0011] as const;
const LIFE = [0.45, 0.8] as const;
/** Mist falls slowly and the air soon stops it. */
const GRAVITY = 1.5;
const DRAG = 3;

interface Droplet {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number;
  size: number;
}

/**
 * The salty spray marine iguanas sneeze out of their nostrils: they drink sea water with their food
 * and a gland by the nose clears the salt. A sneeze puts a burst of tiny white droplets in the air in
 * front of the snout; they slow, drift down and shrink away. Drawn only.
 */
export class SaltSpray {
  private mesh: THREE.InstancedMesh;
  private drops: Droplet[] = [];
  private rand = rng(41);
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const material = new THREE.MeshBasicMaterial({ color: 0xf2f4f0 });
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), material, MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  /** Droplets in the air now. */
  get live() {
    return this.drops.length;
  }

  /** Sneeze from the nostrils at `at`, toward `dir` (a unit vector). */
  sneeze(at: THREE.Vector3, dir: THREE.Vector3) {
    const r = () => this.rand() * 2 - 1;
    for (let i = 0; i < PER_SNEEZE && this.drops.length < MAX; i++) {
      const speed = SPEED[0] + (SPEED[1] - SPEED[0]) * this.rand();
      this.drops.push({
        pos: at.clone(),
        vel: dir.clone().multiplyScalar(speed).add(new THREE.Vector3(r(), r() * 0.5, r()).multiplyScalar(SPREAD)),
        age: 0,
        life: LIFE[0] + (LIFE[1] - LIFE[0]) * this.rand(),
        size: SIZE[0] + (SIZE[1] - SIZE[0]) * this.rand(),
      });
    }
  }

  update(dt: number) {
    const drag = Math.exp(-DRAG * dt);
    this.drops = this.drops.filter((d) => (d.age += dt) < d.life);
    this.drops.forEach((d, i) => {
      d.vel.multiplyScalar(drag);
      d.vel.y -= GRAVITY * dt;
      d.pos.addScaledVector(d.vel, dt);
      this.s.setScalar(d.size * Math.sqrt(1 - d.age / d.life));
      this.mesh.setMatrixAt(i, this.m.compose(d.pos, this.q, this.s));
    });
    this.mesh.count = this.drops.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
