import * as THREE from 'three';
import { LIZARD_CLIPS, type LizardClip, type LizardModel } from '../player/lizardModel';

const CLIP_SECONDS = 3;

/**
 * Temporary turntable: the camera circles the lizard while it cycles through its clips.
 * Keys 1-6 pick a clip. `?clip=walk` holds one clip and `?angle=1.2` freezes the camera (for screenshots).
 * Replaced by the follow camera and character controller in the traversal milestone.
 */
export function createShowcase(lizard: LizardModel, camera: THREE.PerspectiveCamera, centre: THREE.Vector3) {
  const params = new URLSearchParams(location.search);
  const fixedClip = params.get('clip') as LizardClip | null;
  const fixedAngle = params.has('angle') ? Number(params.get('angle')) : undefined;

  const label = document.createElement('div');
  label.style.cssText =
    'position:fixed;left:16px;bottom:16px;padding:6px 10px;border-radius:6px;background:#fffc;' +
    'font:14px system-ui,sans-serif;color:#2f3a2a';
  document.body.appendChild(label);

  let clipIndex = 0;
  let clipTime = 0;
  let angle = fixedAngle ?? 0.6;
  let held = fixedClip !== null;

  const show = (name: LizardClip) => {
    lizard.play(name);
    label.textContent = `${name}  ·  keys 1–6 change animation`;
  };
  show(fixedClip ?? LIZARD_CLIPS[0]);

  window.addEventListener('keydown', (e) => {
    const n = Number(e.key) - 1;
    if (n >= 0 && n < LIZARD_CLIPS.length) {
      held = true;
      clipIndex = n;
      show(LIZARD_CLIPS[n]);
    }
  });

  return (dt: number) => {
    clipTime += dt;
    if (!held && clipTime > CLIP_SECONDS) {
      clipTime = 0;
      clipIndex = (clipIndex + 1) % LIZARD_CLIPS.length;
      show(LIZARD_CLIPS[clipIndex]);
    }
    if (fixedAngle === undefined) angle += dt * 0.35;
    camera.position.set(centre.x + Math.sin(angle) * 0.2, centre.y + 0.07, centre.z + Math.cos(angle) * 0.2);
    camera.lookAt(centre.x, centre.y + 0.012, centre.z);
    lizard.update(dt);
  };
}
