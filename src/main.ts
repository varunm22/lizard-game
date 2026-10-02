import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { startLoop } from './loop';
import { createScene, followSun } from './render/scene';
import { buildTerrain, terrainHeight } from './world/terrain';
import { buildObstacles } from './world/obstacles';
import { Input, type InputState } from './input';
import { PlayerController } from './player/controller';
import { MovementStateMachine } from './player/state';
import { LizardModel } from './player/lizardModel';
import { LizardVisual } from './player/visual';
import { FollowCamera } from './camera/followCamera';
import { createHud } from './hud';
import type { GameTestHooks } from './debug/testHooks';
import lizardUrl from './assets/lizard.glb?url';

/** Spawn on open ground, facing the log and the big rock. */
const SPAWN = { x: 0.1, z: 0.05, yaw: Math.PI };

async function main() {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  const { renderer, scene, camera, sun } = createScene(document.body);
  buildTerrain(scene, world);
  const obstacles = buildObstacles(scene, world);

  const player = new PlayerController(world, new THREE.Vector3(SPAWN.x, terrainHeight(SPAWN.x, SPAWN.z), SPAWN.z));
  player.yaw = player.prevYaw = SPAWN.yaw;
  const states = new MovementStateMachine();

  const lizard = await LizardModel.load(lizardUrl);
  scene.add(lizard.root);
  const visual = new LizardVisual(lizard, player, world);

  const followCam = new FollowCamera(camera, world, player.body);
  followCam.yaw = SPAWN.yaw;

  const input = new Input(renderer.domElement);
  const hud = createHud();
  // Tests can override the live input; null hands control back to the keyboard and gamepad.
  let forcedInput: Partial<InputState> | null = null;
  let forcedSteps = 0;
  let frameInput: InputState = input.read(0);
  let lastState = states.state;
  const feet = new THREE.Vector3();

  const hooks: GameTestHooks = {
    ready: false,
    physicsSteps: 0,
    terrainHeight,
    obstacles: () => obstacles.map((o) => ({ name: o.name, ...o.position, height: o.height })),
    groundAt: (x, z) => {
      const hit = world.castRay(new RAPIER.Ray({ x, y: 5, z }, { x: 0, y: -1, z: 0 }), 10, true, undefined, undefined, undefined, player.body);
      return hit ? 5 - hit.timeOfImpact : null;
    },
    lizard: () => ({ clips: lizard.clipNames, current: lizard.current }),
    player: () => {
      const f = player.feetAt(1, new THREE.Vector3());
      return { x: f.x, y: f.y, z: f.z, yaw: player.yaw, speed: player.horizontalSpeed, grounded: player.grounded, state: states.state };
    },
    camera: () => ({ ...camera.position, yaw: followCam.yaw, pitch: followCam.pitch, arm: followCam.arm, distance: followCam.distance }),
    setInput: (i, forSteps = 0) => {
      forcedInput = i;
      forcedSteps = forSteps;
    },
    teleport: (x, z, yaw) => {
      player.setFeet(new THREE.Vector3(x, terrainHeight(x, z), z));
      player.yaw = player.prevYaw = yaw;
      followCam.yaw = yaw;
    },
  };
  window.__game = hooks;

  startLoop({
    step(dt) {
      player.step(dt, forcedInput ? { ...frameInput, ...forcedInput } : frameInput, followCam.yaw);
      if (forcedSteps > 0 && --forcedSteps === 0) forcedInput = null;
      const state = states.update(
        {
          grounded: player.grounded,
          jumped: player.jumped,
          landed: player.landed,
          verticalSpeed: player.velocity.y,
          horizontalSpeed: player.horizontalSpeed,
        },
        dt,
      );
      if (state !== lastState && state !== 'idle') hud.hideHint();
      lastState = state;
      world.timestep = dt;
      world.step();
      hooks.physicsSteps++;
    },
    render(alpha, frameDt) {
      // Input is read once per frame, before the physics steps that frame owes.
      frameInput = input.read(frameDt);
      followCam.applyInput(frameInput);

      visual.update(states.state, alpha, frameDt);
      player.feetAt(alpha, feet);
      followCam.update(feet, frameDt);
      followSun(sun, feet);
      renderer.render(scene, camera);
      hooks.ready = true;
    },
  });
}

main();
