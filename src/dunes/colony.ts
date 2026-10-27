import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { LizardModel } from '../player/lizardModel';
import { loadGltf } from '../render/gltf';
import { toonify } from '../render/toon';
import { createAnimationActions } from '../render/animationActions';
import { SaltSpray } from '../creatures/saltSpray';
import { SNEEZE_BLOW, SNEEZE_TIME, sneezeNod } from '../creatures/iguana';
import { rng } from '../world/noise';
import { terrainHeight } from '../world/terrain';
import { COLONY } from './layout';

/** Adults are this many times the hatchling's size (about 0.65 m, a Fernandina adult's length). */
const SCALE = 3.4;
/**
 * Where each lies round the colony's middle (m, x and z off it), which way it faces and its size:
 * heaped along the shore between the water and an open lane (x = `LANE_X`) that runs south out of
 * the colony toward the island's forest edge (`grove.ts`), a couple more on its landward side.
 */
const SPOTS = [
  // Seaward of the lane, lying mostly along the shore.
  { x: 0.06, z: 0.34, yaw: 3.0, s: 0.95 },
  { x: 0.25, z: 0.2, yaw: 2.6, s: 1.0 },
  { x: 0.1, z: -0.3, yaw: 3.3, s: 1.05 },
  { x: 0.28, z: -0.2, yaw: 2.9, s: 1.0 },
  { x: 0.3, z: -0.62, yaw: 1.7, s: 0.9 },
  { x: 0.24, z: 0.55, yaw: 1.9, s: 0.92 },
  // Landward of it.
  { x: -0.46, z: -0.42, yaw: 3.6, s: 0.95 },
  { x: -0.5, z: 0.22, yaw: 2.4, s: 0.9 },
];
/** The open lane's x off the middle, and how far south (z off the middle) the walk-in follows it. */
export const LANE_X = -0.13;
export const LANE_END = -0.8;
/** As far as it goes down the lane when it came in from the south, short of a lava cactus. */
export const LANE_FAR = -0.95;
/** Sally Lightfoot crabs picking over the lava between them (m off the middle), at this size. */
const CRABS = [
  { x: 0.18, z: -0.02 },
  { x: 0.2, z: -0.86 },
  { x: -0.32, z: -0.12 },
  { x: -0.3, z: -0.95 },
];
const CRAB_SCALE = 1.8;
/** Their darker, browner skin than a hatchling's. */
const TINT = new THREE.Color(0.62, 0.58, 0.56);
/** Animals further than this from the camera (m) aren't animated: all that shows from out on the dunes is the heap. */
const ANIMATE_WITHIN = 4;

interface Adult {
  model: LizardModel;
  yaw: number;
  look: number;
  next: number;
  /** Time into a sneeze, or -1; and the wait for the next. */
  sneeze: number;
  nextSneeze: number;
}

/**
 * The adult marine iguanas on the shore rocks at the end of the run, where the hatchlings are safe:
 * the racers don't go among them. It's meant to look like the island's colony, where the hatchling is
 * headed: black lava, adults heaped together basking, now and then turning their heads or sneezing
 * out salt, and red crabs picking over the rock among them. Each body is solid (a ball per spine
 * joint), so they block the snakes' view too.
 */
export class Colony {
  readonly adults: Adult[] = [];
  readonly crabs: { root: THREE.Object3D; mixer: THREE.AnimationMixer; actions: Record<string, THREE.AnimationAction>; clip: string; next: number }[] = [];
  readonly spray: SaltSpray;
  sneezes = 0;
  private colliders: RAPIER.Collider[] = [];

  private rand = rng(500);
  private v = new THREE.Vector3();
  private dir = new THREE.Vector3();

  private constructor(scene: THREE.Scene) {
    this.spray = new SaltSpray(scene);
  }

  static async load(url: string, crabUrl: string, scene: THREE.Scene, world: RAPIER.World) {
    const colony = new Colony(scene);
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
        colony.colliders.push(world.createCollider(RAPIER.ColliderDesc.ball(s.r * sc).setTranslation(s.x, s.y, s.z)));
      }
      scene.add(model.root);
      colony.adults.push({ model, yaw: spot.yaw, look: 0, next: 2 + i * 1.3, sneeze: -1, nextSneeze: 3 + i * 1.7 });
    }

    const gltf = await loadGltf(crabUrl);
    toonify(gltf.scene);
    for (const c of CRABS) {
      const root = clone(gltf.scene);
      const x = COLONY.x + c.x;
      const z = COLONY.z + c.z;
      root.position.set(x, terrainHeight(x, z), z);
      root.rotation.y = colony.rand() * Math.PI * 2;
      root.scale.setScalar(CRAB_SCALE);
      const mixer = new THREE.AnimationMixer(root);
      const actions = createAnimationActions(mixer, gltf.animations, []);
      actions.idle.play();
      mixer.update(colony.rand() * 2);
      scene.add(root);
      colony.crabs.push({ root, mixer, actions, clip: 'idle', next: 2 + colony.rand() * 4 });
    }
    return colony;
  }

  /** Whether the adults' bodies are solid. Walking in at the end, the hatchling slips between them rather than getting stuck on a tail. */
  set solid(yes: boolean) {
    for (const c of this.colliders) c.setEnabled(yes);
  }

  /** Each frame, with the camera's position: heads turn, now and then one sneezes; the crabs graze. */
  update(dt: number, camera: THREE.Vector3) {
    this.spray.update(dt);
    const near = Math.hypot(camera.x - COLONY.x, camera.z - COLONY.z) < ANIMATE_WITHIN;
    for (const a of this.adults) {
      a.next -= dt;
      if (a.next <= 0) {
        a.look = (this.rand() - 0.5) * 1.2;
        a.next = 3 + this.rand() * 5;
      }
      a.nextSneeze -= dt;
      if (a.sneeze < 0 && a.nextSneeze <= 0) {
        a.sneeze = 0;
        a.nextSneeze = 5 + this.rand() * 9;
      }
      if (a.sneeze >= 0) {
        const before = a.sneeze;
        a.sneeze += dt;
        if (before < SNEEZE_BLOW && a.sneeze >= SNEEZE_BLOW && near) this.blow(a);
        if (a.sneeze >= SNEEZE_TIME) a.sneeze = -1;
      }
      if (!near) continue;
      a.model.headTurn += (a.look - a.model.headTurn) * Math.min(1, dt * 2);
      a.model.nod = a.sneeze >= 0 ? sneezeNod(a.sneeze) : 0;
      a.model.update(dt);
    }
    if (!near) return;
    for (const c of this.crabs) {
      c.next -= dt;
      if (c.next <= 0) {
        const clip = c.clip === 'idle' ? 'graze' : 'idle';
        c.actions[clip].reset().fadeIn(0.3).play();
        c.actions[c.clip].fadeOut(0.3);
        c.clip = clip;
        c.next = 2 + this.rand() * 5;
      }
      c.mixer.update(dt);
    }
  }

  /** A puff of salt from an adult's nostrils, out along its snout. */
  private blow(a: Adult) {
    a.model.updateBodySpheres();
    const [snout, head] = a.model.bodySpheres;
    this.dir.set(snout.x - head.x, snout.y - head.y, snout.z - head.z).normalize();
    this.spray.sneeze(this.v.set(snout.x, snout.y, snout.z), this.dir);
    this.spray.sneeze(this.v, this.dir);
    this.sneezes++;
  }
}
