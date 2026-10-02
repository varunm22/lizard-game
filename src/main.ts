import RAPIER from '@dimforge/rapier3d-compat';
import { startLoop } from './loop';
import { createScene } from './render/scene';
import { buildTestScene, interpolatePoses, snapshotPoses } from './testScene';
import type { GameTestHooks } from './debug/testHooks';

async function main() {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  const { renderer, scene, camera } = createScene(document.body);
  const synced = buildTestScene(scene, world);

  const hooks: GameTestHooks = {
    ready: false,
    physicsSteps: 0,
    bodies: () => synced.map((s) => s.body.translation()),
  };
  window.__game = hooks;

  startLoop({
    step(dt) {
      snapshotPoses(synced);
      world.timestep = dt;
      world.step();
      hooks.physicsSteps++;
    },
    render(alpha) {
      interpolatePoses(synced, alpha);
      renderer.render(scene, camera);
      hooks.ready = true;
    },
  });
}

main();
