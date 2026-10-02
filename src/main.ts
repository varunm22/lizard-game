import RAPIER from '@dimforge/rapier3d-compat';
import { startLoop } from './loop';
import { createScene } from './render/scene';
import { buildTerrain, terrainHeight } from './world/terrain';
import { buildObstacles } from './world/obstacles';
import type { GameTestHooks } from './debug/testHooks';
import { LizardModel } from './player/lizardModel';
import { createShowcase } from './debug/lizardShowcase';
import lizardUrl from './assets/lizard.glb?url';
import * as THREE from 'three';

async function main() {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  const { renderer, scene, camera } = createScene(document.body);
  buildTerrain(scene, world);
  const obstacles = buildObstacles(scene, world);

  const lizard = await LizardModel.load(lizardUrl);
  const lizardSpot = new THREE.Vector3(0.1, 0, 0.1);
  lizardSpot.y = terrainHeight(lizardSpot.x, lizardSpot.z);
  lizard.root.position.copy(lizardSpot);
  scene.add(lizard.root);
  const updateShowcase = createShowcase(lizard, camera, lizardSpot);

  const hooks: GameTestHooks = {
    ready: false,
    physicsSteps: 0,
    terrainHeight,
    obstacles: () => obstacles.map((o) => ({ name: o.name, ...o.position, height: o.height })),
    groundAt: (x, z) => {
      const hit = world.castRay(new RAPIER.Ray({ x, y: 5, z }, { x: 0, y: -1, z: 0 }), 10, true);
      return hit ? 5 - hit.timeOfImpact : null;
    },
    lizard: () => ({ clips: lizard.clipNames, current: lizard.current }),
  };
  window.__game = hooks;

  startLoop({
    step(dt) {
      world.timestep = dt;
      world.step();
      hooks.physicsSteps++;
    },
    render(_alpha, frameDt) {
      updateShowcase(frameDt);
      renderer.render(scene, camera);
      hooks.ready = true;
    },
  });
}

main();
