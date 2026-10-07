import * as THREE from 'three';
import { toonify } from '../render/toon';
import { loadGltf } from '../render/gltf';
import type { Point, SpineRig } from './spineFit';

/** Animation clips baked by assets-src/lizard.py. */
export const LIZARD_CLIPS = ['idle', 'walk', 'run', 'jump', 'fall', 'land', 'swim', 'collapse'] as const;
export type LizardClip = (typeof LIZARD_CLIPS)[number];

/**
 * Body speed (m/s) each gait clip matches at playback rate 1, from the stride and cycle length in
 * assets-src/lizard.py. Scale playback by groundSpeed / this so the feet don't skate.
 */
export const LIZARD_GAIT_SPEED = { walk: 0.15, run: 0.3 } as const;
/** The swim clip's tail beat at playback rate 1 (one cycle per 0.67 s) suits this swimming speed. */
export const LIZARD_SWIM_SPEED = 0.14;

const ONE_SHOT: LizardClip[] = ['jump', 'land', 'collapse'];
/**
 * The bite clip moves only the neck, head and jaw, and is layered over the body's clip. Its jaws
 * snap shut this far into it (s): frame 10 of `BITE` in assets-src/lizard.py.
 */
const BITE_CLIP = 'bite';
export const BITE_SNAP = 10 / 30;
/**
 * Clips layered over the body's clip (additively, against their first frame, the rest pose), and
 * the bones each moves: the bite, and the flinch when the hawk strikes (one per side struck).
 */
const LAYERED: Record<string, string[]> = {
  [BITE_CLIP]: ['neck', 'head', 'jaw'],
  flinch_left: ['root', 'chest', 'neck', 'head', 'tail1', 'tail2', 'tail3', 'tail4'],
  flinch_right: ['root', 'chest', 'neck', 'head', 'tail1', 'tail2', 'tail3', 'tail4'],
};
/** How a head turn splits between the neck and head bones. */
const HEAD_TURN_SPLIT = { neck: 0.6, head: 0.4 } as const;
/** How a nod splits between the neck and head bones. */
const NOD_SPLIT: Partial<Record<string, number>> = { neck: 0.4, head: 0.6 };
const BONE_Z = new THREE.Vector3(0, 0, 1);
/** Bones the spine fit pitches, parents before children. */
export const BENT_BONES = ['chest', 'neck', 'head', 'tail1', 'tail2', 'tail3', 'tail4'] as const;
export type BentBone = (typeof BENT_BONES)[number];
/**
 * Points the rig has no joint for, in model space (+Z forward, Y up): the snout tip, the tail tip,
 * and where the hind and front feet stand. assets-src/lizard.py writes them as glTF extras on the armature.
 */
interface RigPoints {
  snout: [number, number, number];
  tail_tip: [number, number, number];
  hind_foot_z: number;
  front_foot_z: number;
}
/** Spheres roughly filling the body around each spine joint (radius, m), snout to tail tip: what pushes plants aside. */
const BODY_SPHERES = { snout: 0.004, head: 0.009, neck: 0.008, chest: 0.011, hips: 0.011, tail1: 0.006, tail2: 0.0045, tail3: 0.0035, tail4: 0.0025 };

/** The visual lizard: the skinned GLB plus its animation mixer. It never moves itself; callers place it. */
export class LizardModel {
  readonly root: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<LizardClip, THREE.AnimationAction>();
  current: LizardClip | undefined;
  /** Sideways head turn layered over the clips (radians, positive turns the head to the lizard's right). */
  headTurn = 0;
  /** Nod layered over the clips and the spine fit (radians, positive raises the snout). */
  nod = 0;
  private turnBones: { bone: THREE.Object3D; share: number }[] = [];
  private biteAction: THREE.AnimationAction | undefined;
  /** Other layered clips (the flinches), by name. */
  private layers = new Map<string, THREE.AnimationAction>();
  /** Called as the jaws snap shut on the bite under way. */
  private onSnap: (() => void) | null = null;
  /**
   * Every bone's rotation as the clips alone leave it, last frame. The mixer only writes a bone when
   * its clip value changes, so a bone the code turns after the mixer (bends, head turn, leg reach,
   * clearance) is put back to this first: back to its rest pose instead, it stayed there for every
   * frame a clip held still (the tail snapped straight for a few frames at each end of its sway), and
   * left alone the turns would pile up frame on frame.
   */
  private clipPose: { bone: THREE.Object3D; q: THREE.Quaternion }[] = [];
  private q = new THREE.Quaternion();
  /**
   * Pitch layered over the clips for each bent bone, relative to its parent (radians, positive
   * raises the bone's forward end). Set by the spine fit.
   */
  readonly bend: Record<BentBone, number> = { chest: 0, neck: 0, head: 0, tail1: 0, tail2: 0, tail3: 0, tail4: 0 };
  /** Rest positions of the spine joints and feet, side-on (s forward, y up), for the spine fit. */
  readonly rig: SpineRig;
  private bentBones: { bone: THREE.Object3D; name: BentBone; axis: THREE.Vector3 }[] = [];
  /** For each leg, the skinned vertices that make up the sole of its foot. */
  readonly soles = new Map<string, { mesh: THREE.SkinnedMesh; index: number }[]>();
  /** For each leg, its upper and lower bones and the centre of its sole in the lower bone's frame, at rest. */
  readonly legs: { leg: string; upper: THREE.Object3D; lower: THREE.Object3D; foot: THREE.Vector3 }[] = [];
  /** The tail tip in model space (the rig has no joint there). */
  readonly tailTip: [number, number, number];
  /** The body as spheres in world space, refreshed by `updateBodySpheres`. */
  readonly bodySpheres: { x: number; y: number; z: number; r: number }[];
  private sphereBones: THREE.Object3D[];
  /** The snout tip in the head bone's own frame (the rig has no joint there). */
  private snoutInHead: THREE.Vector3;
  private v = new THREE.Vector3();

  private constructor(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.root = root;
    root.updateMatrixWorld(true);
    const head = root.getObjectByName('head')!;
    this.snoutInHead = head.worldToLocal(root.localToWorld(new THREE.Vector3(...rigPoints(root).snout)));
    // The snout sphere rides on the head bone.
    this.sphereBones = Object.keys(BODY_SPHERES).map((name) => root.getObjectByName(name === 'snout' ? 'head' : name)!);
    this.bodySpheres = Object.values(BODY_SPHERES).map((r) => ({ x: 0, y: 0, z: 0, r }));
    this.findSoles();
    this.findLegs();
    this.tailTip = rigPoints(root).tail_tip;
    this.rig = this.measureRig();
    for (const [name, share] of Object.entries(HEAD_TURN_SPLIT)) {
      const bone = root.getObjectByName(name);
      if (bone) this.turnBones.push({ bone, share });
    }
    root.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.clipPose.push({ bone: o, q: o.quaternion.clone() });
    });
    this.mixer = new THREE.AnimationMixer(root);
    for (const clip of clips) {
      const layered = LAYERED[clip.name];
      if (layered) {
        // Additive against its first frame, the rest pose, so it adds to whatever else is playing. Only
        // the bones it moves, on copies of their keys: the GLB shares key arrays between clips.
        const tracks = clip.tracks
          .filter((t) => layered.some((bone) => t.name === bone + '.quaternion'))
          .map((t) => new THREE.QuaternionKeyframeTrack(t.name, t.times.slice(), t.values.slice()));
        const additive = THREE.AnimationUtils.makeClipAdditive(new THREE.AnimationClip(clip.name, clip.duration, tracks));
        const action = this.mixer.clipAction(additive).setLoop(THREE.LoopOnce, 1);
        if (clip.name === BITE_CLIP) this.biteAction = action;
        else this.layers.set(clip.name, action);
        continue;
      }
      const action = this.mixer.clipAction(clip);
      if (ONE_SHOT.includes(clip.name as LizardClip)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(clip.name as LizardClip, action);
    }
  }

  static async load(url: string): Promise<LizardModel> {
    const gltf = await loadGltf(url);
    toonify(gltf.scene);
    return new LizardModel(gltf.scene, gltf.animations);
  }

  /**
   * The top of its back, as last posed: over the middle of the body, between the chest and hips
   * spheres (refreshed by `updateBodySpheres`). Where a crab stands to groom it.
   */
  back(out: THREE.Vector3): THREE.Vector3 {
    const chest = this.bodySpheres[Object.keys(BODY_SPHERES).indexOf('chest')];
    const hips = this.bodySpheres[Object.keys(BODY_SPHERES).indexOf('hips')];
    return out.set((chest.x + hips.x) / 2, (chest.y + hips.y) / 2 + (chest.r + hips.r) / 2, (chest.z + hips.z) / 2);
  }

  /** Move `bodySpheres` to the spine joints as currently posed. */
  updateBodySpheres() {
    this.root.updateMatrixWorld();
    this.sphereBones.forEach((bone, i) => {
      if (i === 0) bone.localToWorld(this.v.copy(this.snoutInHead));
      else bone.getWorldPosition(this.v);
      Object.assign(this.bodySpheres[i], { x: this.v.x, y: this.v.y, z: this.v.z });
    });
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

  /** Whether a bite is under way. */
  get biting(): boolean {
    return !!this.biteAction?.isRunning();
  }

  /**
   * Take a bite: the head lifts with the mouth open, lunges down and snaps shut, then tugs. `onSnap`
   * runs as the jaws close, which is when anything at the mouth is bitten. False if already biting.
   */
  bite(onSnap?: () => void): boolean {
    if (!this.biteAction || this.biting) return false;
    this.biteAction.reset().play();
    this.onSnap = onSnap ?? null;
    return true;
  }

  /** Jerk as if struck on that side: the body tips away from it and curls toward it, the head ducks and the tail lashes. */
  flinch(side: 'left' | 'right') {
    this.layers.get('flinch_' + side)?.reset().play();
  }

  /** Whether a flinch is under way. */
  get flinching(): boolean {
    return [...this.layers.values()].some((a) => a.isRunning());
  }

  /** Playback rate of the current clip (1 = as authored). */
  setRate(rate: number) {
    const action = this.current && this.actions.get(this.current);
    if (action) action.timeScale = rate;
  }

  update(dt: number) {
    for (const c of this.clipPose) c.bone.quaternion.copy(c.q);
    const biteBefore = this.biting ? this.biteAction!.time : Infinity;
    this.mixer.update(dt);
    const snap = this.onSnap && biteBefore < BITE_SNAP && (this.biteAction!.time >= BITE_SNAP || !this.biting) ? this.onSnap : null;
    for (const c of this.clipPose) c.q.copy(c.bone.quaternion);
    // Pitch about the body's side-to-side axis, taken into each bone's own frame at rest.
    for (const b of this.bentBones) {
      const pitch = this.bend[b.name] + this.nod * (NOD_SPLIT[b.name] ?? 0);
      b.bone.quaternion.multiply(this.q.setFromAxisAngle(b.axis, pitch));
    }
    // The rig bends sideways about each bone's local Z (see assets-src/lizard.py).
    for (const t of this.turnBones) t.bone.quaternion.multiply(this.q.setFromAxisAngle(BONE_Z, this.headTurn * t.share));
    // Fully posed now, so the snout is where it's drawn.
    if (snap) {
      this.onSnap = null;
      snap();
    }
  }

  private findLegs() {
    const v = new THREE.Vector3();
    for (const [leg, soles] of this.soles) {
      const upper = this.root.getObjectByName('upper_' + leg);
      const lower = this.root.getObjectByName('lower_' + leg);
      if (!upper || !lower) continue;
      const foot = new THREE.Vector3();
      for (const { mesh, index } of soles) foot.add(mesh.getVertexPosition(index, v).applyMatrix4(mesh.matrixWorld));
      this.legs.push({ leg, upper, lower, foot: lower.worldToLocal(foot.divideScalar(soles.length)) });
    }
  }

  private measureRig(): SpineRig {
    this.root.updateMatrixWorld(true);
    const p = rigPoints(this.root);
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
      this.bentBones.push({ bone, name, axis });
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

function rigPoints(root: THREE.Object3D): RigPoints {
  let p: RigPoints | undefined;
  root.traverse((o) => {
    if (o.userData.snout) p = o.userData as RigPoints;
  });
  if (!p) throw new Error('lizard.glb has no rig points; regenerate it with npm run assets');
  return p;
}
