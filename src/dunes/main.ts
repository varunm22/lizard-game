import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { FIXED_DT, startLoop } from '../loop';
import { createScene, followSun } from '../render/scene';
import { buildTerrain, IGNORE_IGUANAS, PLAYER_GROUP, terrainHeight } from '../world/terrain';
import { updateUnderwaterView, WATER_Y } from '../world/shore';
import { CelRenderer } from '../render/cel';
import { Water } from '../world/water';
import { Splashes } from '../world/splashes';
import { Input, type InputState } from '../input';
import { PlayerController } from '../player/controller';
import { MovementStateMachine, movementFacts } from '../player/state';
import { LizardModel } from '../player/lizardModel';
import { LizardVisual } from '../player/visual';
import { FollowCamera } from '../camera/followCamera';
import { OccluderFade } from '../camera/occluderFade';
import { createDunesHooks } from '../debug/createDunesHooks';
import { createGoalsPanel } from '../goalsPanel';
import { stageSelect } from '../stageSelect';
import { ViewCheck } from '../render/viewCheck';
import { COLONY, NEST, RACER_HOMES, SAFE_POINTS } from './layout';
import lizardUrl from '../assets/lizard.glb?url';
import snakeUrl from '../assets/snake.glb?url';
import propsUrl from '../assets/props.glb?url';
import dunesUrl from '../assets/dunes.glb?url';
import { loadSnakeKit } from './snakeBody';
import { buildDuneProps } from './props';
import { dunePlants } from './plants';
import { Plants } from '../world/plants';
import { covers } from '../world/obstacles';
import plantsUrl from '../assets/plants.glb?url';
import { GroundProbe } from './ground';
import { Racers, type Prey } from './racers';
import { Hatchlings } from './hatchlings';
import { Colony } from './colony';
import { Markers } from './markers';
import { DuneRun } from './run';
import { clock, createDunesHud } from './hud';

/** The nesting dunes level (`?level=dunes`): hatch, and run for the shore past the racer snakes. */
export async function dunes() {
  await (RAPIER as { init?: () => Promise<void> }).init?.();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  const { renderer, scene, camera, sun, sky } = createScene(document.body);
  const cel = new CelRenderer(renderer, sky, sun);
  cel.waterY = WATER_Y;
  buildTerrain(scene, world);
  const { obstacles, bushes } = await buildDuneProps(propsUrl, dunesUrl, scene, world);
  // Plants grow anywhere a rock, log, tree or a bush's woody base isn't.
  const open = (x: number, z: number) => !obstacles.some((o) => covers(o, x, z, 0.015));
  const plants = await Plants.load(plantsUrl, scene, world, open, NEST, dunePlants);
  const water = new Water(scene);
  const splashes = new Splashes(water);

  const player = new PlayerController(world, new THREE.Vector3(NEST.x, terrainHeight(NEST.x, NEST.z), NEST.z), (PLAYER_GROUP << 16) | 0xffff);
  player.setFeet(player.feetAt(1, new THREE.Vector3()), NEST.yaw);
  player.stillGroups = IGNORE_IGUANAS;
  const states = new MovementStateMachine();
  const lizard = await LizardModel.load(lizardUrl);
  scene.add(lizard.root);
  const visual = new LizardVisual(lizard, player, world);

  const ground = new GroundProbe(world, player.body);
  const kit = await loadSnakeKit(snakeUrl);
  let preyList: Prey[] = [];
  const racers = new Racers(kit, scene, ground, obstacles, () => preyList, (from, to) => bushes.blocks(from, to), RACER_HOMES);
  const hatchlings = await Hatchlings.load(lizardUrl, scene, world, bushes, obstacles);
  hatchlings.racers = racers;
  const colony = await Colony.load(lizardUrl, scene, world);
  const markers = new Markers(scene, { start: NEST, finish: COLONY, safe: SAFE_POINTS });
  const run = new DuneRun(player, visual, bushes, racers);
  preyList = [run.prey, ...hatchlings.prey];
  const cameraPusher = { x: 0, y: 0, z: 0, r: 0.03 };
  const pushers = [...lizard.bodySpheres, ...hatchlings.list.flatMap((h) => h.model.bodySpheres), cameraPusher];
  const tickFeet = new THREE.Vector3();

  const fade = new OccluderFade(world, obstacles);
  const followCam = new FollowCamera(camera, world, player.body, fade.handles);
  followCam.yaw = NEST.yaw;
  const input = new Input(renderer.domElement);

  const hud = createDunesHud();
  stageSelect();
  const goalsPanel = createGoalsPanel(hud.corner, run.goals.list);
  run.goals.onDone = (goal) => goalsPanel.done(goal);
  let introShown = true;
  /** Seconds left showing a passing message (a safe point reached, put back at one), else null. */
  let messageLeft: number | null = null;
  const flashMessage = (title: string, detail: string) => {
    hud.message(title, detail);
    messageLeft = 2.5;
  };
  run.onCaught = () => {
    messageLeft = null;
    hud.message('Caught by a racer snake!', run.checkpoint >= 0 ? 'Back to the safe point...' : 'Back to your burrow...');
  };
  run.onSafe = (i) => {
    markers.reached(i, true);
    flashMessage(`Safe point ${i + 1} of ${SAFE_POINTS.length}`, 'No snake reaches in here. Caught later, you start again from here.');
  };
  run.onRespawn = () => {
    hud.message(null);
  };
  run.onReset = () => {
    hud.message(null);
    messageLeft = null;
    SAFE_POINTS.forEach((_, i) => markers.reached(i, false));
    followCam.yaw = NEST.yaw;
  };
  run.onHome = () => {
    const best = run.best === run.time ? 'A new best!' : `Best ${clock(run.best!)}`;
    hud.message(`You made it! ${clock(run.time)}`, `${best} Press R to go again.`);
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && !e.repeat) run.restart();
  });

  let forcedInput: Partial<InputState> | null = null;
  let forcedSteps = 0;
  let frameInput: InputState = input.read(0);
  let viewOffset: THREE.Vector3 | null = null;
  let viewTarget: THREE.Vector3 | null = null;
  const feet = new THREE.Vector3();
  const toFinish = new THREE.Vector3();
  const view = new ViewCheck();
  const groundedFeet = new THREE.Vector3();

  const hooks = createDunesHooks({
    world, obstacles, player, states, camera, followCam, fade, bushes, racers, hatchlings, run,
    setInput: (i, forSteps = 0) => {
      forcedInput = i;
      forcedSteps = forSteps;
    },
    viewFrom: (offset, at) => {
      viewOffset = offset && new THREE.Vector3(offset.x, offset.y, offset.z);
      viewTarget = at ? new THREE.Vector3(at.x, at.y, at.z) : null;
    },
  });
  window.__dunes = hooks;

  const still: Partial<InputState> = { move: { x: 0, y: 0 }, run: false, jump: false };
  const tick = (dt: number) => {
    let input = forcedInput ? { ...frameInput, ...forcedInput } : frameInput;
    if (run.held) input = { ...input, ...still };
    run.step(dt, input.move.x !== 0 || input.move.y !== 0);
    racers.step(dt);
    hatchlings.step(dt);
    player.feetAt(1, tickFeet);
    player.speedScale = plants.speedScale(tickFeet.x, tickFeet.z, Math.sin(player.yaw), Math.cos(player.yaw));
    player.step(dt, input);
    if (forcedSteps > 0 && --forcedSteps === 0) forcedInput = null;
    splashes.update(player, dt);
    states.update(movementFacts(player), dt);
    world.timestep = dt;
    world.step();
    hooks.physicsSteps++;
  };
  const readInput = (frameDt: number) => {
    frameInput = input.read(frameDt);
    followCam.applyInput(frameInput);
  };
  const updateViews = (alpha: number, frameDt: number) => {
    visual.update(states.state, alpha, frameDt);
    player.feetAt(alpha, feet);
    const steering = player.bodyTurning || player.horizontalSpeed > 0.02;
    const groundedFeetY = player.grounded || player.swimming ? player.feetAt(1, groundedFeet).y : null;
    followCam.update(feet, groundedFeetY, player.yawAt(alpha), steering, frameDt);
    if (viewOffset) {
      const at = viewTarget ?? feet;
      camera.position.copy(at).add(viewOffset);
      camera.lookAt(at);
    }
    fade.update(camera.position, followCam.target, player.yawAt(alpha), frameDt);
    bushes.fade(camera.position, followCam.target, frameDt);
    lizard.updateBodySpheres();
    racers.update(frameDt);
    view.update(camera);
    hatchlings.update(alpha, frameDt, view);
    colony.update(frameDt);
    Object.assign(cameraPusher, { x: camera.position.x, y: camera.position.y, z: camera.position.z });
    plants.update(pushers, frameDt);
    markers.update(frameDt, camera.position);
    if (messageLeft !== null && (messageLeft -= frameDt) <= 0) {
      messageLeft = null;
      if (run.state === 'running') hud.message(null);
    }
    if (introShown && run.state !== 'ready') {
      introShown = false;
      hud.intro(false);
    }
    toFinish.set(COLONY.x, feet.y, COLONY.z);
    const distance = Math.max(0, Math.hypot(COLONY.x - feet.x, COLONY.z - feet.z) - COLONY.r);
    toFinish.applyMatrix4(camera.matrixWorldInverse);
    hud.status(run.time, run.best, distance, Math.atan2(toFinish.x, -toFinish.z));
    hud.danger(run.danger);
    water.update(frameDt);
    updateUnderwaterView(scene, camera);
    followSun(sun, feet);
  };
  const draw = () => {
    cel.render(scene, camera);
    hooks.ready = true;
  };

  const driven = new URLSearchParams(location.search).has('test');
  if (driven) {
    scene.updateMatrixWorld();
    hooks.ready = true;
  }
  let stopLoop: (() => void) | null = driven
    ? null
    : startLoop({
        step: tick,
        render(alpha, frameDt) {
          readInput(frameDt);
          updateViews(alpha, frameDt);
          draw();
        },
      });
  hooks.advance = (n, drawFrame = false) => {
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
