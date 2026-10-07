import * as THREE from 'three';

/** Build the clip lookup and configure clips that hold their final pose after playing once. */
export function createAnimationActions(
  mixer: THREE.AnimationMixer,
  clips: THREE.AnimationClip[],
  oneShots: readonly string[],
): Record<string, THREE.AnimationAction> {
  const actions = Object.fromEntries(clips.map((clip) => [clip.name, mixer.clipAction(clip)]));
  for (const name of oneShots) {
    actions[name].setLoop(THREE.LoopOnce, 1);
    actions[name].clampWhenFinished = true;
  }
  return actions;
}
