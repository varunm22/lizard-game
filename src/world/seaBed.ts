import { OCEAN_X0, WATER_Y } from './shore';
import { TERRAIN_SIZE, terrainHeight } from './terrain';
import type { Obstacle } from './obstacles';

/**
 * Height of whatever is under the water at a point: the sea floor, or the top of a rock on it, from
 * a grid made once at load so swimmers that aren't simulated (the fish) can keep off the bottom and
 * out of the rocks with one lookup. A rock is taken as a dome over its footprint, up to its top.
 */
const CELL = 0.025;
const X0 = OCEAN_X0;
const X1 = TERRAIN_SIZE / 2;
const Z0 = -TERRAIN_SIZE / 2;

export class SeaBed {
  private nx = Math.ceil((X1 - X0) / CELL) + 1;
  private nz = Math.ceil(TERRAIN_SIZE / CELL) + 1;
  private heights = new Float32Array(this.nx * this.nz);

  constructor(obstacles: readonly Obstacle[]) {
    const { nx, nz, heights } = this;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) heights[j * nx + i] = terrainHeight(X0 + i * CELL, Z0 + j * CELL);
    for (const o of obstacles) {
      if (o.kind !== 'rock' || o.position.x + o.radius < X0) continue;
      const top = terrainHeight(o.position.x, o.position.z) + o.height;
      const i0 = Math.max(0, Math.floor((o.position.x - o.radius - X0) / CELL));
      const i1 = Math.min(nx - 1, Math.ceil((o.position.x + o.radius - X0) / CELL));
      const j0 = Math.max(0, Math.floor((o.position.z - o.radius - Z0) / CELL));
      const j1 = Math.min(nz - 1, Math.ceil((o.position.z + o.radius - Z0) / CELL));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const d2 = ((X0 + i * CELL - o.position.x) ** 2 + (Z0 + j * CELL - o.position.z) ** 2) / o.radius ** 2;
          if (d2 >= 1) continue;
          const k = j * nx + i;
          heights[k] = Math.max(heights[k], top - (top - heights[k]) * d2);
        }
      }
    }
  }

  /** Height (m) of the bottom or the rock at (x, z), bilinear between grid points; above the water on land. */
  at(x: number, z: number): number {
    const fx = Math.min(this.nx - 1.001, Math.max(0, (x - X0) / CELL));
    const fz = Math.min(this.nz - 1.001, Math.max(0, (z - Z0) / CELL));
    if (x < X0) return WATER_Y + 1;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const h = this.heights;
    const k = j * this.nx + i;
    const a = h[k] + (h[k + 1] - h[k]) * tx;
    const b = h[k + this.nx] + (h[k + this.nx + 1] - h[k + this.nx]) * tx;
    return a + (b - a) * tz;
  }
}
