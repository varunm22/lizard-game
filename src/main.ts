import RAPIER from '@dimforge/rapier3d-compat';
import { startLoop } from './loop';
import { createScene } from './render/scene';
import { buildTestScene, interpolatePoses, snapshotPoses } from './testScene';
import type { GameTestHooks } from './debug/testHooks';
import { LizardModel } from './player/lizardModel';
import { createShowcase } from './debug/lizardShowcase';
import lizardUrl from './assets/lizard.glb?url';
import * as THREE from 'three';

async function main() {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  const { renderer, scene, camera } = createScene(document.body);
  const synced = buildTestScene(scene, world);

  const lizard = await LizardModel.load(lizardUrl);
  const lizardSpot = new THREE.Vector3(0.35, 0, 0.3);
  lizard.root.position.copy(lizardSpot);
  scene.add(lizard.root);
  const updateShowcase = createShowcase(lizard, camera, lizardSpot);

  const hooks: GameTestHooks = {
    ready: false,
    physicsSteps: 0,
    bodies: () => synced.map((s) => s.body.translation()),
    lizard: () => ({ clips: lizard.clipNames, current: lizard.current }),
  };
  window.__game = hooks;

  startLoop({
    step(dt) {
      snapshotPoses(synced);
      world.timestep = dt;
      world.step();
      hooks.physicsSteps++;
    },
    render(alpha, frameDt) {
      updateShowcase(frameDt);
      interpolatePoses(synced, alpha);
      renderer.render(scene, camera);
      hooks.ready = true;
    },
  });
}

main();
