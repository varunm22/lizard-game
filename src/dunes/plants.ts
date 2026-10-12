import { crowds, type PlantKind, type Placement } from '../world/plants';
import { WATER_Y } from '../world/shore';
import { rng, smoothstep, valueNoise } from '../world/noise';
import { terrainHeight } from '../world/terrain';
import { BURROWS, COLONY, cove, duneBelt, duneLava, duneRidges, duneSand, duneShoreX, NEST, RACER_HOMES } from './layout';

const SEED = 88;
const EDGE = 3.85;
const shape = { hump: 0, lee: 0 };

/**
 * Lay out the nesting dunes' plants, the way the back of a Galapagos nesting beach grows: salt
 * grass (bunchgrass here, small) in tussocks binding the dune crests and their lee slopes, beach
 * morning glory running out across the hollows in long runners, carpetweed in red-green mats along
 * the strand line and in damp hollows near the sea, and grey Tiquilia mounds on the lava. The sand
 * is patchy, not covered: wide bare lanes stay open between the clumps, where the snakes see
 * everything that moves. Nothing grows in a burrow mouth, round the nest, over a snake's coil or
 * among the adults.
 */
export function dunePlants(open: (x: number, z: number) => boolean, _clear: { x: number; z: number }): Placement[] {
  const rand = rng(SEED);
  const out: Placement[] = [];
  const range = (a: number, b: number) => a + (b - a) * rand();
  /** Plants already placed, by 10 cm cell, so spacing checks stay cheap. */
  const cells = new Map<number, Placement[]>();
  const key = (x: number, z: number) => Math.floor(x / 0.1 + 100) * 1000 + Math.floor(z / 0.1 + 100);
  const ok = (kind: PlantKind, x: number, z: number) => {
    if (Math.abs(x) > EDGE || Math.abs(z) > EDGE) return false;
    if (terrainHeight(x, z) < WATER_Y + 0.012) return false;
    if (Math.hypot(x - NEST.x, z - NEST.z) < 0.2 || Math.hypot(x - COLONY.x, z - COLONY.z) < COLONY.r + 0.15) return false;
    if (RACER_HOMES.some((h) => Math.hypot(x - h.x, z - h.z) < 0.2)) return false;
    if (BURROWS.some((b) => Math.hypot(x - b.x, z - b.z) < 0.12)) return false;
    const lava = duneLava(x, z);
    if (kind === 'tiquilia' ? lava < 0.6 : lava > 0.3) return false;
    return open(x, z);
  };
  const add = (kind: PlantKind, x: number, z: number, scale: number) => {
    if (!ok(kind, x, z)) return;
    const cx = Math.floor(x / 0.1);
    const cz = Math.floor(z / 0.1);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const near = cells.get(key((cx + i) * 0.1 + 0.05, (cz + j) * 0.1 + 0.05));
      if (near?.some((p) => crowds(kind, x, z, p))) return;
    }
    const p = { kind, x, z, yaw: range(0, 2 * Math.PI), scale };
    out.push(p);
    const k = key(x, z);
    cells.set(k, [...(cells.get(k) ?? []), p]);
  };
  const around = (x: number, z: number, r: number) => {
    const a = range(0, 2 * Math.PI);
    const d = r * Math.sqrt(rand());
    return [x + Math.cos(a) * d, z + Math.sin(a) * d] as const;
  };
  const somewhere = (where: (x: number, z: number) => number) => {
    for (let i = 0; i < 2000; i++) {
      const x = range(-EDGE, EDGE);
      const z = range(-EDGE, EDGE);
      if (rand() < where(x, z)) return [x, z] as const;
    }
    return [99, 99] as const;
  };
  /** Patches of growth and bare lanes between them, a few metres across. */
  const patchy = (x: number, z: number) => smoothstep(-0.25, 0.35, valueNoise(x / 0.9 + 11, z / 0.9 - 4, 61));
  const s = (x: number, z: number) => x - duneShoreX(z);

  // On the dunes: tussocks on the crests and down their lee slopes.
  const dune = (x: number, z: number) => {
    duneRidges(x, z, shape);
    return duneSand(x, z) * duneBelt(x) * Math.max(shape.hump, shape.lee) * (0.3 + 0.7 * patchy(x, z));
  };
  for (let i = 0; i < 150; i++) {
    const [cx, cz] = somewhere(dune);
    const n = Math.round(range(4, 11));
    for (let j = 0; j < n; j++) add('grass', ...around(cx, cz, range(0.05, 0.13)), range(0.55, 0.9));
  }
  // Odd tufts over the flats, the nesting flat too.
  const flat = (x: number, z: number) => duneSand(x, z) * (s(x, z) < -0.5 ? 1 : 0) * patchy(x, z) * 0.6;
  for (let i = 0; i < 260; i++) add('grass', ...somewhere(flat), range(0.5, 0.8));
  // Morning glory runners: out across the hollows and the lower slopes, from the back of the beach.
  const runners = (x: number, z: number) => {
    duneRidges(x, z, shape);
    const hollow = 1 - Math.max(shape.hump, shape.lee) * duneBelt(x);
    return duneSand(x, z) * hollow * smoothstep(-3.2, -2, x) * patchy(x, z) * (s(x, z) < -0.25 ? 1 : 0);
  };
  for (let i = 0; i < 70; i++) {
    let [x, z] = somewhere(runners);
    // A runner trails off in one direction, a vine's length, leaves every few cm.
    const dir = range(0, 2 * Math.PI);
    const len = range(0.2, 0.55);
    for (let d = 0; d < len; d += 0.035) {
      x += Math.sin(dir + 0.4 * Math.sin(d * 9)) * 0.035;
      z += Math.cos(dir + 0.4 * Math.sin(d * 9)) * 0.035;
      add('ipomoea', x + range(-0.015, 0.015), z + range(-0.015, 0.015), range(0.75, 1.15));
    }
  }
  // Carpetweed: along the strand line and in the damp hollows behind it, and round the cove.
  const strand = (x: number, z: number) => {
    const d = -s(x, z);
    return duneSand(x, z) * smoothstep(0.08, 0.2, d) * smoothstep(0.9, 0.45, d) * (0.4 + 0.6 * cove(z));
  };
  for (let i = 0; i < 90; i++) {
    const [cx, cz] = somewhere(strand);
    const n = Math.round(range(4, 10));
    for (let j = 0; j < n; j++) add('sesuvium', ...around(cx, cz, 0.1), range(0.7, 1.2));
  }
  // Tiquilia on the lava, in scattered grey mounds.
  const lava = (x: number, z: number) => (duneLava(x, z) > 0.7 && s(x, z) < -0.1 ? 1 : 0);
  for (let i = 0; i < 80; i++) {
    const [cx, cz] = somewhere(lava);
    const n = Math.round(range(2, 6));
    for (let j = 0; j < n; j++) add('tiquilia', ...around(cx, cz, 0.12), range(0.7, 1.3));
  }
  return out;
}
