import { rng } from '../world/noise';
import type { PlantKind, Plants } from '../world/plants';

/**
 * A closed oval walked at constant speed: positions by distance along it, from a table of points
 * spaced evenly by arc length (an ellipse's own angle doesn't advance evenly).
 */
export class Route {
  readonly length: number;
  private xs: number[] = [];
  private zs: number[] = [];

  constructor(
    readonly x: number,
    readonly z: number,
    readonly rx: number,
    readonly rz: number,
    samples = 512,
  ) {
    const raw: [number, number][] = [];
    for (let i = 0; i <= 4 * samples; i++) {
      const t = (2 * Math.PI * i) / (4 * samples);
      raw.push([x + rx * Math.cos(t), z + rz * Math.sin(t)]);
    }
    const cum = [0];
    for (let i = 1; i < raw.length; i++) cum.push(cum[i - 1] + Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]));
    this.length = cum.at(-1)!;
    let j = 0;
    for (let i = 0; i < samples; i++) {
      const s = (this.length * i) / samples;
      while (cum[j + 1] < s) j++;
      const f = (s - cum[j]) / (cum[j + 1] - cum[j]);
      this.xs.push(raw[j][0] + (raw[j + 1][0] - raw[j][0]) * f);
      this.zs.push(raw[j][1] + (raw[j + 1][1] - raw[j][1]) * f);
    }
  }

  /** The point `s` metres along (wrapping), and the unit direction of travel there. */
  at(s: number): { x: number; z: number; dx: number; dz: number } {
    const n = this.xs.length;
    const u = (((s / this.length) % 1) + 1) % 1 * n;
    const i = Math.floor(u) % n;
    const k = (i + 1) % n;
    const f = u - Math.floor(u);
    const dx = this.xs[k] - this.xs[i];
    const dz = this.zs[k] - this.zs[i];
    const l = Math.hypot(dx, dz) || 1;
    return { x: this.xs[i] + dx * f, z: this.zs[i] + dz * f, dx: dx / l, dz: dz / l };
  }

  /** How far (x, z) is from the route (m), approximately. */
  distance(x: number, z: number): number {
    let best = Infinity;
    for (let i = 0; i < this.xs.length; i++) best = Math.min(best, Math.hypot(this.xs[i] - x, this.zs[i] - z));
    return best;
  }
}

/** Every so often (seconds, from-to) a new plant comes up somewhere along the route. */
const SPROUT_EVERY = [6, 14] as const;
/** How far either side of the route it may come up (m): within the band the tortoise walks and grazes. */
const SPROUT_SPREAD = 0.07;
const SPROUT_KINDS: readonly PlantKind[] = ['grass', 'grass', 'grass', 'daisy', 'poppy'];

/** The route starts out as a strip of meadow this wide either side (m), this many tries at a plant. */
const MEADOW_SPREAD = 0.11;
const MEADOW_TRIES = 90;

/**
 * What keeps the tortoise fed: its route runs through a strip of grass and flowers, and seedlings come
 * up now and then along it (mostly grass, some flowers), so there is always something to eat on
 * the next lap.
 */
export class Regrowth {
  private rand = rng(77);
  private wait: number;

  constructor(
    private route: Route,
    private plants: Plants,
  ) {
    this.wait = this.next();
    for (let i = 0; i < MEADOW_TRIES; i++) this.plant(MEADOW_SPREAD, true);
  }

  private next() {
    return SPROUT_EVERY[0] + (SPROUT_EVERY[1] - SPROUT_EVERY[0]) * this.rand();
  }

  step(dt: number) {
    this.wait -= dt;
    if (this.wait > 0) return;
    this.wait = this.next();
    this.plant(SPROUT_SPREAD, false);
  }

  /** A plant somewhere along the route, up to `spread` to either side. */
  private plant(spread: number, grown: boolean) {
    const p = this.route.at(this.rand() * this.route.length);
    const side = (this.rand() * 2 - 1) * spread;
    const kind = SPROUT_KINDS[Math.floor(this.rand() * SPROUT_KINDS.length)];
    // Too close to another plant (or no room left for that kind): this one doesn't come up.
    this.plants.sprout(kind, p.x - p.dz * side, p.z + p.dx * side, grown);
  }
}
