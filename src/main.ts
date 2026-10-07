import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FIXED_DT, startLoop } from './loop';
import { createScene, followSun } from './render/scene';
import { buildTerrain, IGNORE_IGUANAS, PLAYER_GROUP, terrainHeight } from './world/terrain';
import { buildObstacles, covers } from './world/obstacles';
import { buildProps } from './world/props';
import { Algae } from './world/algae';
import { forestCover, SPAWN, TORTOISE_ROUTE } from './world/layout';
import { updateUnderwaterView } from './world/shore';
import { Water } from './world/water';
import { Splashes } from './world/splashes';
import { Plants } from './world/plants';
import { Route, Regrowth } from './creatures/route';
import { Tortoise } from './creatures/tortoise';
import { Crabs } from './creatures/crab';
import { Iguanas } from './creatures/iguana';
import { Hawk, PATROL } from './creatures/hawk';
import { findPerches } from './creatures/perches';
import { quarries } from './creatures/quarry';
import { StrikePuff } from './creatures/strikePuff';
import { Cover } from './world/cover';
import { MAX_HITS, Wounds } from './player/wounds';
import { Input, type InputState } from './input';
import { PlayerController } from './player/controller';
import { MovementStateMachine, movementFacts } from './player/state';
import { LizardModel } from './player/lizardModel';
import { LizardVisual } from './player/visual';
import { Feeding } from './player/feeding';
import { FollowCamera } from './camera/followCamera';
import { OccluderFade } from './camera/occluderFade';
import { createHud } from './hud';
import { createTestHooks } from './debug/createTestHooks';
import lizardUrl from './assets/lizard.glb?url';
import plantsUrl from './assets/plants.glb?url';
import propsUrl from './assets/props.glb?url';
import tortoiseUrl from './assets/tortoise.glb?url';
import crabUrl from './assets/crab.glb?url';
import hawkUrl from './assets/hawk.glb?url';

async function main() {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  const { renderer, scene, camera, sun } = createScene(document.body);
  buildTerrain(scene, world);
  const landmarks = buildObstacles(scene, world);
  const props = await buildProps(propsUrl, scene, world, landmarks);
  const obstacles = [...landmarks, ...props.obstacles];
  const algae = new Algae(scene, props.algae, obstacles);
  const water = new Water(scene);
  const splashes = new Splashes(water);
  // Plants grow anywhere a rock, log or tree (or its rim) isn't.
  const open = (x: number, z: number) => !obstacles.some((o) => covers(o, x, z, 0.015));
  const plants = await Plants.load(plantsUrl, scene, world, open, SPAWN);
  const route = new Route(TORTOISE_ROUTE.x, TORTOISE_ROUTE.z, TORTOISE_ROUTE.rx, TORTOISE_ROUTE.rz);
  const regrowth = new Regrowth(route, plants);
  const tortoise = await Tortoise.load(tortoiseUrl, scene, world, route, plants);

  const player = new PlayerController(world, new THREE.Vector3(SPAWN.x, terrainHeight(SPAWN.x, SPAWN.z), SPAWN.z), (PLAYER_GROUP << 16) | 0xffff);
  player.setFeet(player.feetAt(1, new THREE.Vector3()), SPAWN.yaw);
  player.stillGroups = IGNORE_IGUANAS;
  const states = new MovementStateMachine();

  const lizard = await LizardModel.load(lizardUrl);
  scene.add(lizard.root);
  const visual = new LizardVisual(lizard, player, world);
  const feeding = new Feeding(lizard, algae);
  const iguanas = await Iguanas.load(lizardUrl, scene, world, player, obstacles, algae, plants, water);
  const crabs = await Crabs.load(crabUrl, scene, world, algae, player, lizard, iguanas.list.map((ig) => ({ body: ig.body, model: ig.model })));

  // The hawk hunts the lizard: three strikes knock it down, and it comes back at the spawn.
  const wounds = new Wounds(player, lizard, () => {
    player.setFeet(new THREE.Vector3(SPAWN.x, terrainHeight(SPAWN.x, SPAWN.z), SPAWN.z), SPAWN.yaw);
    followCam.yaw = SPAWN.yaw;
  });
  const cover = new Cover(world, obstacles, plants);
  const prey = quarries(player, lizard, wounds, iguanas, crabs, tortoise);
  const hawk = await Hawk.load(hawkUrl, scene, (fit) => findPerches(obstacles, forestCover, PATROL, fit), cover, prey);

  const fade = new OccluderFade(world, obstacles);
  const followCam = new FollowCamera(camera, world, player.body, fade.handles);
  followCam.yaw = SPAWN.yaw;

  const input = new Input(renderer.domElement);
  const hud = createHud();
  // A strike that lands: dust and feathers fly off the lizard's back, the view jolts and reddens.
  const puff = new StrikePuff(scene);
  const struckAt = new THREE.Vector3();
  const struckDir = new THREE.Vector3();
  wounds.onStrike = (_side, dx, dz) => {
    player.feetAt(1, struckAt).y += 0.018;
    puff.burst(struckAt, struckDir.set(dx, 0, dz));
    followCam.shake();
    hud.flash();
  };
  // Tests can override the live input; null hands control back to the keyboard and gamepad.
  let forcedInput: Partial<InputState> | null = null;
  let forcedSteps = 0;
  let frameInput: InputState = input.read(0);
  let lastState = states.state;
  const feet = new THREE.Vector3();
  let viewOffset: THREE.Vector3 | null = null;
  let viewTarget: THREE.Vector3 | null = null;
  const groundedFeet = new THREE.Vector3();
  const tickFeet = new THREE.Vector3();
  const cameraPusher = { x: 0, y: 0, z: 0, r: 0.04 };
  const pushers = [...lizard.bodySpheres, ...iguanas.bodySpheres, cameraPusher];

  const STILL: InputState = { move: { x: 0, y: 0 }, run: false, jump: false, look: { yaw: 0, pitch: 0 }, zoom: 0 };
  const hooks = createTestHooks({
    world, obstacles, player, states, lizard, visual, camera, followCam, fade, plants,
    tortoise, crabs, iguanas, algae, feeding, water, hawk, cover, prey, wounds, puff,
    setInput: (i, forSteps = 0) => {
      forcedInput = i;
      forcedSteps = forSteps;
    },
    viewFrom: (offset, at) => {
      viewOffset = offset && new THREE.Vector3(offset.x, offset.y, offset.z);
      viewTarget = at ? new THREE.Vector3(at.x, at.y, at.z) : null;
    },
  });
  window.__game = hooks;

  const tick = (dt: number) => {
    // Plants slow the lizard by where its physics body is, not where it's drawn.
    player.feetAt(1, tickFeet);
    player.speedScale = plants.speedScale(tickFeet.x, tickFeet.z, Math.sin(player.yaw), Math.cos(player.yaw));
    // The tortoise moves first, shoving the lizard out of its way before the lizard's own move.
    tortoise.step(dt, player);
    regrowth.step(dt);
    iguanas.step(dt);
    crabs.step(dt);
    hawk.step(dt);
    wounds.step(dt);
    // Knocked down, the lizard lies still whatever the controls say.
    const input = wounds.down ? STILL : forcedInput ? { ...frameInput, ...forcedInput } : frameInput;
    player.step(dt, input);
    // Walking into another iguana pushes it slowly out of the way.
    if (input.move.y > 0) iguanas.pushedBy(player, dt);
    if (forcedSteps > 0 && --forcedSteps === 0) forcedInput = null;
    splashes.update(player, dt);
    const state = states.update(movementFacts(player), dt);
    if (state !== lastState && state !== 'idle') hud.hideHint();
    lastState = state;
    world.timestep = dt;
    world.step();
    hooks.physicsSteps++;
  };
  const readInput = (frameDt: number) => {
    frameInput = input.read(frameDt);
    followCam.applyInput(frameInput);
    if (frameInput.bite && !wounds.down) feeding.bite();
  };
  const updateViews = (alpha: number, frameDt: number) => {
    // The tortoise first: the lizard is fitted to its shell where it's drawn this frame.
    tortoise.update(alpha, frameDt);
    visual.downed = wounds.down;
    visual.update(states.state, alpha, frameDt);
    hawk.update(alpha, frameDt);
    puff.update(frameDt);
    hud.wounds(wounds.hits, MAX_HITS, wounds.countdown);
    iguanas.update(alpha, frameDt);
    player.feetAt(alpha, feet);
    const steering = player.bodyTurning || player.horizontalSpeed > 0.02;
    // Swimming, the camera follows the lizard up and down as if it were on the ground.
    const groundedFeetY = player.grounded || player.swimming ? player.feetAt(1, groundedFeet).y : null;
    followCam.update(feet, groundedFeetY, player.yawAt(alpha), steering, frameDt);
    if (viewOffset) {
      const at = viewTarget ?? feet;
      camera.position.copy(at).add(viewOffset);
      camera.lookAt(at);
    }
    fade.update(camera.position, followCam.target, player.yawAt(alpha), frameDt);
    // Plants part for the lizard's body, and for the camera so tall stems don't fill the view.
    lizard.updateBodySpheres();
    Object.assign(cameraPusher, { x: camera.position.x, y: camera.position.y, z: camera.position.z });
    crabs.update(alpha, frameDt);
    plants.update(pushers, frameDt);
    water.update(frameDt);
    algae.update(frameDt);
    updateUnderwaterView(scene, camera);
    followSun(sun, feet);
  };
  const draw = () => {
    renderer.render(scene, camera);
    hooks.ready = true;
  };

  let stopLoop: (() => void) | null = startLoop({
    step: tick,
    render(alpha, frameDt) {
      // Input is read once per rendered frame; the next physics steps use it.
      readInput(frameDt);
      updateViews(alpha, frameDt);
      draw();
    },
  });

  // Tests drive time themselves: the first call stops the real-time loop for good, then each call
  // runs exactly `n` fixed steps (input, physics, camera, animation) and draws once at the end.
  hooks.advance = (n, drawFrame = true) => {
    stopLoop?.();
    stopLoop = null;
    for (let i = 0; i < n; i++) {
      readInput(FIXED_DT);
      tick(FIXED_DT);
      updateViews(1, FIXED_DT);
    }
    if (drawFrame) draw();
  };
  let accumulator = 0;
  hooks.frame = (frameDt, drawFrame = false) => {
    stopLoop?.();
    stopLoop = null;
    readInput(frameDt);
    for (accumulator += frameDt; accumulator >= FIXED_DT; accumulator -= FIXED_DT) tick(FIXED_DT);
    updateViews(accumulator / FIXED_DT, frameDt);
    if (drawFrame) draw();
  };
}

main();
