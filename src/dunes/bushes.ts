import * as THREE from 'three';

/** One saltbush: where it stands, how far its canopy reaches, how high its top and its rim stand. */
export interface Bush {
  name: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  rim: number;
  mesh: THREE.Mesh;
}

/** Opacity of a bush in the way of the view, and how fast it fades (per second, exponential). */
const FADED = 0.3;
const FADE_RATE = 10;
/** Under this share of its reach from the middle, something is in the bush's shade and hidden. */
const HIDDEN = 0.85;

/**
 * The saltbushes: shrubs open underneath, the lizard walks in under them and is out of sight of the
 * snakes there. Their canopies aren't solid (only the woody base is, an obstacle in `props.ts`), so
 * their own sight test is an ellipsoid round the canopy; and they turn see-through while they hide
 * the lizard from the camera, as the rocks do.
 */
export class Bushes {
  readonly list: Bush[] = [];
  private opacity = new Map<Bush, number>();
  private d = new THREE.Vector3();
  private o = new THREE.Vector3();

  add(b: Bush) {
    this.list.push(b);
    this.opacity.set(b, 1);
  }

  /** The bush (x, z) is under, if any. */
  over(x: number, z: number): Bush | null {
    for (const b of this.list) if ((x - b.x) ** 2 + (z - b.z) ** 2 < (b.radius * HIDDEN) ** 2) return b;
    return null;
  }

  /** Whether some canopy lies across the straight line from `a` to `b`. */
  blocks(a: THREE.Vector3, b: THREE.Vector3): boolean {
    for (const bush of this.list) if (this.crosses(bush, a, b)) return true;
    return false;
  }

  /**
   * Whether the segment a-b passes through the canopy: an ellipsoid over the bush from its rim to
   * its top, scaled to a unit sphere for the test.
   */
  private crosses(bush: Bush, a: THREE.Vector3, b: THREE.Vector3): boolean {
    const half = (bush.height - bush.rim) / 2;
    const cy = bush.y + bush.rim + half;
    const r = bush.radius;
    // Quick reject on the ground plane.
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minZ = Math.min(a.z, b.z);
    const maxZ = Math.max(a.z, b.z);
    if (bush.x + r < minX || bush.x - r > maxX || bush.z + r < minZ || bush.z - r > maxZ) return false;
    this.o.set((a.x - bush.x) / r, (a.y - cy) / half, (a.z - bush.z) / r);
    this.d.set((b.x - a.x) / r, (b.y - a.y) / half, (b.z - a.z) / r);
    const A = this.d.lengthSq();
    const B = 2 * this.o.dot(this.d);
    const C = this.o.lengthSq() - 1;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return false;
    const s = Math.sqrt(disc);
    const t0 = (-B - s) / (2 * A);
    const t1 = (-B + s) / (2 * A);
    return t1 >= 0 && t0 <= 1;
  }

  /** Fade the bushes between the camera and the lizard (or round the camera). */
  fade(camera: THREE.Vector3, target: THREE.Vector3, dt: number) {
    const k = 1 - Math.exp(-FADE_RATE * dt);
    for (const b of this.list) {
      const goal = this.crosses(b, camera, target) ? FADED : 1;
      let a = this.opacity.get(b)!;
      a = Math.abs(goal - a) < 0.01 ? goal : a + (goal - a) * k;
      this.opacity.set(b, a);
      const m = b.mesh.material as THREE.Material;
      const see = a < 1;
      if (m.transparent !== see) {
        m.transparent = see;
        m.depthWrite = !see;
        b.mesh.receiveShadow = !see;
        m.needsUpdate = true;
      }
      m.opacity = a;
    }
  }

  /** Bushes now see-through (for tests). */
  get faded(): string[] {
    return this.list.filter((b) => this.opacity.get(b)! < 1).map((b) => b.name);
  }
}
