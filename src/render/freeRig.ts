import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadGltf } from './gltf';
import { toonify } from './toon';

/**
 * A creature from one of the generators whose bones are unparented joints the game places itself
 * (assets-src/owl.py, whitetip.py, sealion.py): its scene and the joints written on its armature
 * (creature space: Y up, +Z forward), plus anything else the generator wrote there.
 */
export interface FreeRigKit {
  scene: THREE.Object3D;
  joints: Record<string, THREE.Vector3>;
  extras: Record<string, unknown>;
}

export async function loadFreeRigKit(url: string, rigName: string): Promise<FreeRigKit> {
  const gltf = await loadGltf(url);
  toonify(gltf.scene);
  const rig = gltf.scene.getObjectByName(rigName);
  const extras = (rig?.userData ?? {}) as Record<string, unknown>;
  const raw = extras.joints as Record<string, number[]> | undefined;
  if (!raw) throw new Error(`${url} is missing its joints`);
  const joints: Record<string, THREE.Vector3> = {};
  for (const [k, v] of Object.entries(raw)) joints[k] = new THREE.Vector3(v[0], v[1], v[2]);
  return { scene: gltf.scene, joints, extras };
}

const ONE = new THREE.Vector3(1, 1, 1);

/**
 * One posed copy of a FreeRigKit. Place the creature (`place`), then move each part rigidly
 * (`part`): its rest geometry turned about its joint and the joint put somewhere in creature space.
 */
export class FreeRig {
  readonly root: THREE.Object3D;
  readonly joints: Record<string, THREE.Vector3>;
  private bones = new Map<string, THREE.Bone>();
  private bind = new Map<string, THREE.Matrix4>();
  private parentInverse = new Map<string, THREE.Matrix4>();
  private world = new THREE.Matrix4();
  private m = new THREE.Matrix4();
  private t = new THREE.Matrix4();
  private s = new THREE.Vector3();

  constructor(kit: FreeRigKit) {
    this.root = clone(kit.scene);
    this.joints = kit.joints;
    this.root.updateMatrixWorld(true);
    for (const name of Object.keys(kit.joints)) {
      const bone = this.root.getObjectByName(name) as THREE.Bone | undefined;
      if (!bone) throw new Error(`no bone ${name}`);
      this.bones.set(name, bone);
      this.bind.set(name, bone.matrixWorld.clone());
      this.parentInverse.set(name, bone.parent!.matrixWorld.clone().invert());
    }
    this.root.traverse((o) => {
      // Skinned to bones placed anywhere in the level: the rest-pose bounds mean nothing.
      if ((o as THREE.Mesh).isMesh) o.frustumCulled = false;
    });
  }

  /** Where the creature is (world) and how it's turned and scaled. */
  place(at: THREE.Vector3, rotation: THREE.Quaternion, scale = 1) {
    this.world.compose(at, rotation, this.s.setScalar(scale));
  }

  /** Creature space to world for the current placement, into `out`. */
  toWorld(p: THREE.Vector3, out: THREE.Vector3) {
    return out.copy(p).applyMatrix4(this.world);
  }

  /**
   * Pose part `name`: its rest geometry turned by `rotation` about its joint, the joint moved to
   * `to` (creature space; the rest joint if omitted), and scaled by `scale` about it (0.001 hides it).
   */
  part(name: string, rotation: THREE.Quaternion, to?: THREE.Vector3, scale = 1) {
    const j = this.joints[name];
    this.m.compose(to ?? j, rotation, scale === 1 ? ONE : this.s.setScalar(scale));
    this.m.multiply(this.t.makeTranslation(-j.x, -j.y, -j.z));
    this.m.premultiply(this.world).multiply(this.bind.get(name)!);
    this.m.premultiply(this.parentInverse.get(name)!);
    const bone = this.bones.get(name)!;
    this.m.decompose(bone.position, bone.quaternion, bone.scale);
    return this;
  }

  /** Where part `name`'s point `p` (creature space, at rest) is after `rotation` about its joint moved to `to`. */
  partPoint(name: string, p: THREE.Vector3, rotation: THREE.Quaternion, to: THREE.Vector3, out: THREE.Vector3) {
    const j = this.joints[name];
    return out.copy(p).sub(j).applyQuaternion(rotation).add(to);
  }

  get placement() {
    return this.world;
  }
}
