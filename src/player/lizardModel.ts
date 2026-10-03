import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { toonify } from '../render/toon';
import type { Point, SpineRig } from './spineFit';

/** Animation clips baked by assets-src/lizard.py. */
export const LIZARD_CLIPS = ['idle', 'walk', 'run', 'jump', 'fall', 'land', 'swim'] as const;
export type LizardClip = (typeof LIZARD_CLIPS)[number];

/**
 * Body speed (m/s) each gait clip matches at playback rate 1, from the stride and cycle length in
 * assets-src/lizard.py. Scale playback by groundSpeed / this so the feet don't skate.
 */
export const LIZARD_GAIT_SPEED = { walk: 0.09, run: 0.18 } as const;
/** The swim clip's tail beat at playback rate 1 (one cycle per 0.67 s) suits this swimming speed. */
export const LIZARD_SWIM_SPEED = 0.14;

const ONE_SHOT: LizardClip[] = ['jump', 'land'];
/** How a head turn splits between the neck and head bones. */
const HEAD_TURN_SPLIT = { neck: 0.6, head: 0.4 } as const;
const BONE_Z = new THREE.Vector3(0, 0, 1);
/** Bones the spine fit pitches, parents before children. */
export const BENT_BONES = ['chest', 'neck', 'head', 'tail1', 'tail2', 'tail3', 'tail4'] as const;
export type BentBone = (typeof BENT_BONES)[number];
/**
 * Points the rig has no joint for, in model space (+Z forward, Y up): the snout tip, the tail tip,
 * and where the hind and front feet stand. A model can carry its own as glTF extras on the armature
 * (assets-src/marine_iguana.py does); these defaults are assets-src/lizard.py's, from its PROFILE.
 */
const DEFAULT_POINTS = { snout: [0, 0.008, 0.064], tail_tip: [0, 0.0036, -0.092], hind_foot_z: -0.014, front_foot_z: 0.026 };
type RigPoints = typeof DEFAULT_POINTS;

/** The visual lizard: the skinned GLB plus its animation mixer. It never moves itself; callers place it. */
export class LizardModel {
  readonly root: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<LizardClip, THREE.AnimationAction>();
  current: LizardClip | undefined;
  /** Sideways head turn layered over the clips (radians, positive turns the head to the lizard's right). */
  headTurn = 0;
  private turnBones: { bone: THREE.Object3D; rest: THREE.Quaternion; share: number }[] = [];
  private q = new THREE.Quaternion();
  /**
   * Pitch layered over the clips for each bent bone, relative to its parent (radians, positive
   * raises the bone's forward end). Set by the spine fit.
   */
  readonly bend: Record<BentBone, number> = { chest: 0, neck: 0, head: 0, tail1: 0, tail2: 0, tail3: 0, tail4: 0 };
  /** Rest positions of the spine joints and feet, side-on (s forward, y up), for the spine fit. */
  readonly rig: SpineRig;
  private bentBones: { bone: THREE.Object3D; name: BentBone; rest: THREE.Quaternion; axis: THREE.Vector3 }[] = [];
  /** For each leg, the skinned vertices that make up the sole of its foot. */
  readonly soles = new Map<string, { mesh: THREE.SkinnedMesh; index: number }[]>();

  private constructor(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.root = root;
    this.findSoles();
    this.rig = this.measureRig();
    for (const [name, share] of Object.entries(HEAD_TURN_SPLIT)) {
      const bone = root.getObjectByName(name);
      if (bone) this.turnBones.push({ bone, rest: bone.quaternion.clone(), share });
    }
    this.mixer = new THREE.AnimationMixer(root);
    for (const clip of clips) {
      const action = this.mixer.clipAction(clip);
      if (ONE_SHOT.includes(clip.name as LizardClip)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(clip.name as LizardClip, action);
    }
  }

  static async load(url: string): Promise<LizardModel> {
    const loader = new GLTFLoader();
    // The single-file preview build inlines the model as a data: URL. Decode it here rather than
    // fetching it, since strict Content-Security-Policies (like the claude.ai preview) block that.
    const gltf = url.startsWith('data:') ? await loader.parseAsync(dataUrlToBuffer(url), '') : await loader.loadAsync(url);
    toonify(gltf.scene);
    return new LizardModel(gltf.scene, gltf.animations);
  }

  /**
   * World position of the lowest sole vertex of each foot, as currently posed. Skinning runs on the
   * CPU here, so this is for tests and debugging, not every frame.
   */
  solePoints(): { leg: string; point: THREE.Vector3 }[] {
    this.root.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    return [...this.soles].map(([leg, verts]) => {
      let low: THREE.Vector3 | null = null;
      for (const { mesh, index } of verts) {
        mesh.getVertexPosition(index, v).applyMatrix4(mesh.matrixWorld);
        if (!low || v.y < low.y) low = v.clone();
      }
      return { leg, point: low! };
    });
  }

  get clipNames(): string[] {
    return [...this.actions.keys()];
  }

  /** Cross-fade to a clip. `fade` is in seconds. */
  play(name: LizardClip, fade = 0.2) {
    const next = this.actions.get(name);
    if (!next || name === this.current) return;
    const prev = this.current && this.actions.get(this.current);
    next.reset().setEffectiveTimeScale(1).play();
    if (prev) next.crossFadeFrom(prev, fade, false);
    this.current = name;
  }

  /** Playback rate of the current clip (1 = as authored). */
  setRate(rate: number) {
    const action = this.current && this.actions.get(this.current);
    if (action) action.timeScale = rate;
  }

  update(dt: number) {
    // Start from rest so the turn never accumulates on a bone the current clip doesn't key.
    for (const t of this.turnBones) t.bone.quaternion.copy(t.rest);
    for (const b of this.bentBones) b.bone.quaternion.copy(b.rest);
    this.mixer.update(dt);
    // Pitch about the body's side-to-side axis, taken into each bone's own frame at rest.
    for (const b of this.bentBones) b.bone.quaternion.multiply(this.q.setFromAxisAngle(b.axis, this.bend[b.name]));
    // The rig bends sideways about each bone's local Z (see assets-src/lizard.py).
    for (const t of this.turnBones) t.bone.quaternion.multiply(this.q.setFromAxisAngle(BONE_Z, this.headTurn * t.share));
  }

  private measureRig(): SpineRig {
    this.root.updateMatrixWorld(true);
    let p: RigPoints = DEFAULT_POINTS;
    this.root.traverse((o) => {
      if (o.userData.snout) p = { ...DEFAULT_POINTS, ...(o.userData as Partial<RigPoints>) };
    });
    const rootInv = this.root.matrixWorld.clone().invert();
    const at = (name: string): Point => {
      const p = this.root.getObjectByName(name)!.getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInv);
      return { s: p.z, y: p.y };
    };
    const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    for (const name of BENT_BONES) {
      const bone = this.root.getObjectByName(name);
      if (!bone) continue;
      // Raising the forward end is a rotation about the model's -X; express that axis in the bone's frame.
      const boneQ = rootQ.clone().multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
      const axis = new THREE.Vector3(-1, 0, 0).applyQuaternion(boneQ.invert());
      this.bentBones.push({ bone, name, rest: bone.quaternion.clone(), axis });
    }
    return {
      hips: at('tail1'),
      chest: at('chest'),
      neck: at('neck'),
      head: at('head'),
      snout: { s: p.snout[2], y: p.snout[1] },
      tail: [at('tail1'), at('tail2'), at('tail3'), at('tail4'), { s: p.tail_tip[2], y: p.tail_tip[1] }],
      hindFoot: { s: p.hind_foot_z, y: 0 },
      frontFoot: { s: p.front_foot_z, y: 0 },
    };
  }

  /** Sole = vertices bound mostly to a lower-leg bone and within 1.5 mm of that foot's lowest point at rest. */
  private findSoles() {
    const byLeg = new Map<string, { mesh: THREE.SkinnedMesh; index: number; y: number }[]>();
    this.root.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const pos = mesh.geometry.getAttribute('position');
      const joints = mesh.geometry.getAttribute('skinIndex');
      const weights = mesh.geometry.getAttribute('skinWeight');
      for (let i = 0; i < pos.count; i++) {
        for (let k = 0; k < 4; k++) {
          const bone = mesh.skeleton.bones[joints.getComponent(i, k)];
          if (weights.getComponent(i, k) > 0.5 && bone.name.startsWith('lower_')) {
            const leg = bone.name.slice(6);
            if (!byLeg.has(leg)) byLeg.set(leg, []);
            byLeg.get(leg)!.push({ mesh, index: i, y: pos.getY(i) });
          }
        }
      }
    });
    for (const [leg, verts] of byLeg) {
      const low = Math.min(...verts.map((v) => v.y));
      this.soles.set(leg, verts.filter((v) => v.y < low + 0.0015).map(({ mesh, index }) => ({ mesh, index })));
    }
  }
}

function dataUrlToBuffer(url: string): ArrayBuffer {
  const bytes = atob(url.slice(url.indexOf(',') + 1));
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return buf.buffer;
}
