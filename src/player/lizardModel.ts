import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { toonify } from '../render/toon';

/** Animation clips baked by assets-src/lizard.py. */
export const LIZARD_CLIPS = ['idle', 'walk', 'run', 'jump', 'fall', 'land'] as const;
export type LizardClip = (typeof LIZARD_CLIPS)[number];

/**
 * Body speed (m/s) each gait clip matches at playback rate 1, from the stride and cycle length in
 * assets-src/lizard.py. Scale playback by groundSpeed / this so the feet don't skate.
 */
export const LIZARD_GAIT_SPEED = { walk: 0.09, run: 0.18 } as const;

const ONE_SHOT: LizardClip[] = ['jump', 'land'];
/** How a head turn splits between the neck and head bones. */
const HEAD_TURN_SPLIT = { neck: 0.6, head: 0.4 } as const;
const BONE_Z = new THREE.Vector3(0, 0, 1);

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

  private constructor(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.root = root;
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
    this.mixer.update(dt);
    // The rig bends sideways about each bone's local Z (see assets-src/lizard.py).
    for (const t of this.turnBones) t.bone.quaternion.multiply(this.q.setFromAxisAngle(BONE_Z, this.headTurn * t.share));
  }
}

function dataUrlToBuffer(url: string): ArrayBuffer {
  const bytes = atob(url.slice(url.indexOf(',') + 1));
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return buf.buffer;
}
