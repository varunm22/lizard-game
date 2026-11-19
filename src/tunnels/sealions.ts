import * as THREE from 'three';
import { FreeRig, type FreeRigKit } from '../render/freeRig';
import { WATER_Y } from '../world/shore';
import { terrainHeight } from '../world/terrain';
import { ISLET } from './layout';

/**
 * The colony on the outer islet's beach, across the water from the cove: Galapagos sea lions
 * (assets-src/sealion.py), the bigger animals of the stage still to come. A bull, cows and pups,
 * hauled out above the waterline: each placed along the beach by x (its z found where the islet's
 * sand comes out of the water), turned to face more or less down the beach, scaled and tinted (pups
 * are born dark brown).
 */
const HERD = [
  { x: 2.6, yaw: 2.6, scale: 1.45, tint: 0.75, up: 0.8 },
  { x: 3.9, yaw: 3.5, scale: 1, tint: 1.25, up: 0.35 },
  { x: 4.6, yaw: 0.6, scale: 0.5, tint: 0.5, up: 0.6 },
  { x: 5.6, yaw: 2.1, scale: 1.05, tint: 1.3, up: 0.3 },
  { x: 6.6, yaw: 4.0, scale: 0.95, tint: 1.15, up: 0.6 },
  { x: 7.0, yaw: 1.2, scale: 0.48, tint: 0.5, up: 1.1 },
  { x: 7.9, yaw: 2.9, scale: 1, tint: 1.2, up: 0.3 },
];

const UP = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const q = new THREE.Quaternion();
const r = new THREE.Quaternion();

class SeaLion {
  readonly rig: FreeRig;
  readonly at = new THREE.Vector3();
  private time: number;

  constructor(
    kit: FreeRigKit,
    readonly yaw: number,
    readonly scale: number,
    tint: number,
    i: number,
    x: number,
    z: number,
  ) {
    this.rig = new FreeRig(kit);
    this.rig.root.name = `sealion-${i}`;
    this.at.set(x, terrainHeight(x, z), z);
    this.time = i * 2.3;
    this.rig.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Out in the daylight: not the tubes' dark fog, seen from in there.
      const own = (m: THREE.Material) => {
        const c = m.clone() as THREE.MeshToonMaterial;
        c.fog = false;
        c.color.multiplyScalar(1.5 * tint);
        return c;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
    });
  }

  /** Breathing, and now and then the head up to look about before it sinks back to sleep (each frame). */
  pose(dt: number) {
    this.time += dt;
    const t = this.time;
    const rig = this.rig;
    rig.place(this.at, q.setFromAxisAngle(UP, this.yaw), this.scale);
    const breath = 1 + 0.012 * Math.sin(t * 1.3);
    rig.part('body', q.identity(), undefined, breath);
    // Head up for a few seconds in every twenty or so, turning slowly.
    const cycle = (t % 21) / 21;
    const lift = THREE.MathUtils.smoothstep(cycle, 0.6, 0.66) * (1 - THREE.MathUtils.smoothstep(cycle, 0.85, 0.92));
    q.setFromAxisAngle(UP, 0.5 * lift * Math.sin(t * 0.7)).multiply(r.setFromAxisAngle(X, -0.75 * lift + 0.06));
    rig.part('head', q);
  }
}

export class SeaLions {
  readonly list: SeaLion[] = [];

  constructor(kit: FreeRigKit, scene: THREE.Scene) {
    HERD.forEach((h, i) => {
      // Up the beach from where the islet's north shore comes out of the sea.
      let z = ISLET.z - ISLET.r;
      while (z < ISLET.z && terrainHeight(h.x, z) < WATER_Y + 0.04) z += 0.05;
      const s = new SeaLion(kit, h.yaw, h.scale, h.tint, i, h.x, z + h.up);
      this.list.push(s);
      scene.add(s.rig.root);
      s.pose(0);
    });
  }

  pose(dt: number) {
    for (const s of this.list) s.pose(dt);
  }
}
