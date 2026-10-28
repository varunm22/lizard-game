import * as THREE from 'three';
import { algaeSite, type Placement } from '../world/algae';
import { rng } from '../world/noise';
import { WATER_Y } from '../world/shore';
import { terrainHeight } from '../world/terrain';
import { ISLETS, lagoonLava, westCoastX } from './layout';
import type { LagoonProps } from './props';

/** Gutweed grows on lava this deep under the surface (m): just awash down to a hand deep. */
const GUTWEED_DEPTH = [0.003, 0.07] as const;
/** Patches keep at least this far apart (m). */
const SPACING = 0.045;
const SEED = 97;

/**
 * Where the lagoon's algae grow, for `Algae` (`src/world/algae.ts`) to draw, regrow and be eaten by
 * the lizard. Not the open coast's red turf and sea lettuce but what a sheltered mangrove lagoon
 * has: gutweed (Ulva intestinalis), the green tube weed of calm brackish shallows, on the lava
 * where it runs down into the water (the knobs and the colony's coast), and Bostrychia, the dark
 * red-purple moss-like alga that fringes mangrove prop roots where they enter the water. About half
 * of each grow at the start; the other sites are bare, for new patches to sprout on.
 */
export function lagoonAlgaeSites(props: Pick<LagoonProps, 'rootWaterline'>): { first: Placement[]; spare: Placement[] } {
  const rand = rng(SEED);
  const first: Placement[] = [];
  const spare: Placement[] = [];
  const taken: THREE.Vector3[] = [];
  const add = (kind: 'gutweed' | 'bostrychia', position: THREE.Vector3, normal: THREE.Vector3) => {
    if (taken.some((p) => p.distanceToSquared(position) < SPACING * SPACING)) return;
    taken.push(position);
    (rand() < 0.55 ? first : spare).push(algaeSite(() => kind, position, normal, rand));
  };

  // About every other root, so the moss stays a find rather than a ring on every root.
  for (const r of props.rootWaterline) if (rand() < 0.45) add('bostrychia', r.position.clone(), r.normal.clone());

  const e = 0.01;
  const onLava = (x: number, z: number) => {
    const y = terrainHeight(x, z);
    const depth = WATER_Y - y;
    if (depth < GUTWEED_DEPTH[0] || depth > GUTWEED_DEPTH[1] || lagoonLava(x, z) < 0.12) return;
    const n = new THREE.Vector3(terrainHeight(x - e, z) - terrainHeight(x + e, z), 2 * e, terrainHeight(x, z - e) - terrainHeight(x, z + e)).normalize();
    add('gutweed', new THREE.Vector3(x, y - 0.001, z), n);
  };
  // Round the knobs' skirts.
  for (const k of ISLETS) {
    for (let i = 0; i < 60; i++) {
      const a = rand() * 2 * Math.PI;
      const d = k.r - 0.02 + rand() * 0.1;
      onLava(k.x + Math.sin(a) * d, k.z + Math.cos(a) * d);
    }
  }
  // Along the colony's lava coast, where it runs into the lagoon.
  for (let i = 0; i < 400; i++) {
    const z = -5.4 + 10.8 * rand();
    onLava(westCoastX(z) - 0.03 + rand() * 0.14, z);
  }
  return { first, spare };
}
