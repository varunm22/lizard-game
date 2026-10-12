import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { LizardModel } from '../player/lizardModel';
import { rng } from '../world/noise';
import { terrainHeight } from '../world/terrain';
import { COLONY } from './layout';

/** Adults are this many times the hatchling's size (about 0.65 m, a Fernandina adult's length). */
const SCALE = 3.4;
/** Where each lies round the colony's middle (m, x and z off it) and which way it faces. */
const SPOTS = [
  { x: 0.16, z: 0.05, yaw: -2.0, s: 1.0 },
  { x: -0.06, z: 0.28, yaw: 2.6, s: 0.92 },
  { x: 0.3, z: -0.26, yaw: -0.9, s: 1.06 },
  { x: -0.02, z: -0.34, yaw: 0.4, s: 0.88 },
  { x: 0.24, z: 0.36, yaw: -2.9, s: 0.96 },
];
/** Their darker, browner skin than a hatchling's. */
const TINT = new THREE.Color(0.62, 0.58, 0.56);

/**
 * The adult marine iguanas on the shore rocks at the end of the run, where the hatchlings are safe:
 * the racers don't go among them. They lie piled about the colony's middle, now and then turning
 * their heads. Each body is solid (a ball per spine joint), so they block the snakes' view too.
 */
export class Colony {
  readonly adults: { model: LizardModel; yaw: number; look: number; next: number }[] = [];

  private rand = rng(500);

  private constructor() {}

  static async load(url: string, scene: THREE.Scene, world: RAPIER.World) {
    const colony = new Colony();
    for (const [i, spot] of SPOTS.entries()) {
      const model = await LizardModel.load(url);
      model.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const tinted = (m: THREE.Material) => {
          const c = m.clone() as THREE.MeshToonMaterial;
          c.color?.multiply(TINT);
          return c;
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(tinted) : tinted(mesh.material);
        mesh.castShadow = true;
      });
      const x = COLONY.x + spot.x;
      const z = COLONY.z + spot.z;
      const sc = SCALE * spot.s;
      model.root.scale.setScalar(sc);
      model.root.position.set(x, terrainHeight(x, z) - 0.004 * sc, z);
      model.root.rotation.y = spot.yaw;
      model.play('idle', 0);
      model.update(0.5 + i * 0.7);
      model.updateBodySpheres();
      for (const s of model.bodySpheres) {
        world.createCollider(RAPIER.ColliderDesc.ball(s.r * sc).setTranslation(s.x, s.y, s.z));
      }
      scene.add(model.root);
      colony.adults.push({ model, yaw: spot.yaw, look: 0, next: 2 + i * 1.3 });
    }
    return colony;
  }

  update(dt: number) {
    for (const a of this.adults) {
      a.next -= dt;
      if (a.next <= 0) {
        a.look = (this.rand() - 0.5) * 1.2;
        a.next = 3 + this.rand() * 5;
      }
      a.model.headTurn += (a.look - a.model.headTurn) * Math.min(1, dt * 2);
      a.model.update(dt);
    }
  }
}
