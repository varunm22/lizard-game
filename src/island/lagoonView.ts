import * as THREE from 'three';
import { loadGltf } from '../render/gltf';
import { toonGradient } from '../render/toon';
import { rng } from '../world/noise';
import { WATER_Y } from '../world/shore';
import { terrainHeight } from '../world/terrain';
import { BASIN, basinDip } from './basin';
import lagoonUrl from '../assets/lagoon.glb?url';

/** Its own random numbers, so it moves nothing else. */
const SEED = 91;
/** Red mangroves out in the water and black mangroves up on the banks either side. */
const REDS = 16;
const BLACKS = 7;
/** Open water kept straight ahead of the way out, this far either side of the basin's middle and this far out (m), so the lagoon shows between the trees. */
const VIEW = { half: 0.35, to: -5.6 };
/** Calm, tea-green lagoon water, as in the lagoon stage (`water.ts`). */
const WATER = 0x5f9a82;

/**
 * The mangrove lagoon seen from the island's west bank at the end of the run: red mangroves on
 * their prop roots standing in still water, black mangroves on the mud of the banks either side,
 * the lagoon stage's own trees (lagoon.glb). It's out past the walls and only drawn once the lizard
 * is over the crack (`visible`), so it costs nothing while the island is played.
 */
export class LagoonView {
  readonly group = new THREE.Group();

  constructor(scene: THREE.Scene) {
    this.group.name = 'lagoon-view';
    this.group.visible = false;
    scene.add(this.group);
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 2 * BASIN.half + 0.6).rotateX(-Math.PI / 2),
      new THREE.MeshToonMaterial({ color: WATER, gradientMap: toonGradient(), transparent: true, opacity: 0.85, depthWrite: false }),
    );
    water.position.set(BASIN.x0 - 3, WATER_Y, BASIN.z);
    water.renderOrder = 1;
    this.group.add(water);
  }

  /** Load the trees (in the background: nothing waits on it). */
  async load() {
    const gltf = await loadGltf(lagoonUrl);
    const kit = new Map<string, THREE.BufferGeometry>();
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) kit.set(mesh.name, mesh.geometry);
    });
    const rand = rng(SEED);
    const range = (a: number, b: number) => a + (b - a) * rand();
    const material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });
    const placed: { x: number; z: number }[] = [];
    const plant = (names: string[], count: number, ok: (x: number, z: number) => boolean, spacing: number) => {
      const lists = new Map<string, THREE.Matrix4[]>();
      for (let i = 0, n = 0; i < 2000 && n < count; i++) {
        const x = range(BASIN.x0 - 0.3, -8);
        const z = range(BASIN.z - BASIN.half, BASIN.z + BASIN.half);
        if (!ok(x, z) || placed.some((p) => Math.hypot(p.x - x, p.z - z) < spacing)) continue;
        const name = names[Math.floor(rand() * names.length)];
        const s = range(0.85, 1.2);
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(x, terrainHeight(x, z), z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), range(0, 2 * Math.PI)),
          new THREE.Vector3(s, s, s),
        );
        lists.set(name, [...(lists.get(name) ?? []), m]);
        placed.push({ x, z });
        n++;
      }
      for (const [name, list] of lists) {
        const geometry = kit.get(name);
        if (!geometry) continue;
        const mesh = new THREE.InstancedMesh(geometry, material, list.length);
        list.forEach((m, k) => mesh.setMatrixAt(k, m));
        mesh.computeBoundingSphere();
        mesh.name = `lagoon-view-${name}`;
        this.group.add(mesh);
      }
    };
    const ahead = (x: number, z: number) => Math.abs(z - BASIN.z) < VIEW.half + 0.15 * (BASIN.x1 - x) && x > VIEW.to;
    // Red mangroves in the water, thicker toward the sides, leaving the view straight out open.
    plant(['red_mangrove_0', 'red_mangrove_1', 'red_mangrove_2', 'sapling'], REDS, (x, z) => basinDip(x, z) > 0.85 && !ahead(x, z), 0.45);
    // Black mangroves up on the mud of the banks.
    plant(['black_mangrove'], BLACKS, (x, z) => basinDip(x, z) > 0.25 && basinDip(x, z) < 0.75 && x < BASIN.x0 - 0.2, 0.5);
  }
}
