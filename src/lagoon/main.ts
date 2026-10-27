import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { FIXED_DT, startLoop } from '../loop';
import { createScene, followSun } from '../render/scene';
import { toonGradient } from '../render/toon';
import { buildTerrain, IGNORE_IGUANAS, PLAYER_GROUP, terrainHeight } from '../world/terrain';
import { updateUnderwaterView, WATER_Y, waterDepth } from '../world/shore';
import { Cover } from '../world/cover';
import { ClimateSense } from '../player/climate';
import { Vitals, type DownCause } from '../player/vitals';
import { Wounds } from '../player/wounds';
import { createHitFlash, createVitalsPanel } from '../hud';
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
import { createLagoonHooks } from '../debug/createLagoonHooks';
import { createGoalsPanel } from '../goalsPanel';
import { stageSelect } from '../stageSelect';
import { GroundProbe } from '../dunes/ground';
import { Markers } from '../dunes/markers';
import { clock, createDunesHud, endKeys, runKeys, type HudText } from '../dunes/hud';
import lizardUrl from '../assets/lizard.glb?url';
import propsUrl from '../assets/props.glb?url';
import lagoonUrl from '../assets/lagoon.glb?url';
import heronUrl from '../assets/heron.glb?url';
import { current, FINISH, lagoonLava, SAFE_POINTS, START } from './layout';
import { buildLagoonProps, loadKit } from './props';
import { DriftLog } from './driftLog';
import { loadHeronKit } from './heronBody';
import { Herons } from './herons';
import { Swimmers } from './swimmers';
import { CAUGHT_TIME, LagoonRun } from './run';

const TEXT: HudText = {
  intro:
    '<h2>Mangrove lagoon</h2>' +
    'Cross the lagoon to the <b>lava field</b> beyond the channel, under the <b>golden light</b>.' +
    '<ul><li>Lava herons stalk the shallows and stab fast: each stab costs <b>health</b>. Keep moving, and keep out of reach.</li>' +
    '<li>No heron reaches in among the <b>mangrove roots</b>, or sees you swimming low over <b>deep water</b>. ' +
    'Swim too near one and it strikes without stalking.</li>' +
    '<li>Shark pups are curious, and sometimes bite. Never turn on one close up.</li>' +
    '<li>The water <b>chills</b> you and diving costs <b>air</b>: bask on the black lava to warm up.</li>' +
    '<li>The channel is too deep and its far bank too steep. A <b>driftwood log</b> lies in a pool by its bank: ' +
    'swim into it to push it, out into the current.</li>' +
    '<li>A faint teal ring marks a <b>safe point</b>. Caught after reaching it, you start again from there.</li></ul>' +
    '<span class="go">Move to start.</span>',
  watched: 'A heron is stalking you. Keep moving!',
  chased: 'It is about to strike!',
};

/** The mangrove lagoon (`?level=lagoon`): cross the shallows past the lava herons, and float a log across the channel. */
export async function lagoon() {
  await (RAPIER as { init?: () => Promise<void> }).init?.();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  const { renderer, scene, camera, sun, sky } = createScene(document.body);
  const cel = new CelRenderer(renderer, sky, sun);
  cel.waterY = WATER_Y;
  buildTerrain(scene, world);
  const kit = await loadKit([propsUrl, lagoonUrl]);
  const { obstacles, mangroves, crowns } = buildLagoonProps(kit, scene, world);
  const water = new Water(scene);
  const splashes = new Splashes(water);

  const player = new PlayerController(world, new THREE.Vector3(START.x, terrainHeight(START.x, START.z), START.z), (PLAYER_GROUP << 16) | 0xffff);
  player.setFeet(player.feetAt(1, new THREE.Vector3()), START.yaw);
  player.stillGroups = IGNORE_IGUANAS;
  const states = new MovementStateMachine();
  const lizard = await LizardModel.load(lizardUrl);
  scene.add(lizard.root);
  const visual = new LizardVisual(lizard, player, world);
  // The island's bars: health, warmth (sun and shade, cooling in the water), food and air.
  const vitals = new Vitals();
  const wounds = new Wounds(player, lizard, vitals, () => run.afterDown(), CAUGHT_TIME);
  const cover = new Cover(world, obstacles, null, crowns);
  const climate = new ClimateSense(player, cover, () => [], waterDepth, lagoonLava);

  const logGeometry = kit.geometry.get('log_0')!;
  const logExtras = kit.extras.get('log_0') as { radius: number; length: number };
  const logMaterial = new THREE.MeshToonMaterial({ vertexColors: true, color: 0xd9d4cc, gradientMap: toonGradient() });
  const log = new DriftLog(world, logGeometry, logExtras, logMaterial, player);
  scene.add(log.mesh);
  const ground = new GroundProbe(world, player.body);
  const swimmers = new Swimmers(kit.geometry, scene);
  const heronKit = await loadHeronKit(heronUrl);
  const herons = new Herons(heronKit, scene, world, ground, obstacles, mangroves, player.body);
  const run = new LagoonRun(player, wounds, vitals, herons, log, swimmers);
  herons.prey = run.prey;
  swimmers.prey = run.prey;
  const markers = new Markers(scene, { start: START, finish: FINISH, safe: SAFE_POINTS });

  const fade = new OccluderFade(world, obstacles);
  const followCam = new FollowCamera(camera, world, player.body, fade.handles);
  followCam.yaw = START.yaw;
  const input = new Input(renderer.domElement);

  const hud = createDunesHud(TEXT);
  const vitalsPanel = createVitalsPanel();
  wounds.onStrike = createHitFlash();
  stageSelect();
  const goalsPanel = createGoalsPanel(hud.corner, run.goals.list);
  run.goals.onDone = (goal) => goalsPanel.done(goal);
  let introShown = true;
  let messageLeft: number | null = null;
  const flashMessage = (title: string, detail: string) => {
    hud.message(title, detail);
    messageLeft = 3;
  };
  const DOWN: Partial<Record<DownCause, string>> = {
    heron: 'Caught by a lava heron!',
    shark: 'Bitten by a shark pup!',
    cold: 'Too cold to move!',
    air: 'Out of air!',
    hunger: 'Starved!',
  };
  run.onCaught = (by) => {
    messageLeft = null;
    hud.message(DOWN[by] ?? 'Down!', run.checkpoint >= 0 ? 'Back to the safe point...' : 'Back to the lava coast...');
  };
  run.onSafe = (i) => {
    markers.reached(i, true);
    flashMessage('Safe in the roots', 'No heron reaches in here. Caught later, you start again from here.');
  };
  run.onRespawn = () => hud.message(null);
  run.onReset = () => {
    hud.message(null);
    messageLeft = null;
    SAFE_POINTS.forEach((_, i) => markers.reached(i, false));
    followCam.yaw = START.yaw;
  };
  run.onHome = () => {
    const best = run.best === run.time ? 'A new best!' : `Best ${clock(run.best!)}`;
    hud.message(`Across! ${clock(run.time)}`, best, endKeys('lagoon'));
  };
  log.onJammed = () => flashMessage('The log has jammed across the channel', 'A bridge to the lava field.');
  log.onLost = () => flashMessage('The log drifted out to sea', 'Another has washed into the pool.');
  runKeys('lagoon', run);

  let forcedInput: Partial<InputState> | null = null;
  let forcedSteps = 0;
  let frameInput: InputState = input.read(0);
  let viewOffset: THREE.Vector3 | null = null;
  let viewTarget: THREE.Vector3 | null = null;
  const feet = new THREE.Vector3();
  const tickFeet = new THREE.Vector3();
  const toFinish = new THREE.Vector3();
  const groundedFeet = new THREE.Vector3();
  const flow = { x: 0, z: 0 };

  const hooks = createLagoonHooks({
    world, obstacles, mangroves, player, states, camera, followCam, fade, herons, log, swimmers, run, vitals, wounds,
    setInput: (i, forSteps = 0) => {
      forcedInput = i;
      forcedSteps = forSteps;
    },
    viewFrom: (offset, at) => {
      viewOffset = offset && new THREE.Vector3(offset.x, offset.y, offset.z);
      viewTarget = at ? new THREE.Vector3(at.x, at.y, at.z) : null;
    },
  });
  window.__lagoon = hooks;

  const still: Partial<InputState> = { move: { x: 0, y: 0 }, run: false, jump: false };
  const tick = (dt: number) => {
    let input = forcedInput ? { ...frameInput, ...forcedInput } : frameInput;
    if (run.held) input = { ...input, ...still };
    run.step(dt, input.move.x !== 0 || input.move.y !== 0);
    herons.step(dt);
    log.step(dt, input.move.y > 0 && player.swimming);
    player.feetAt(1, tickFeet);
    swimmers.step(dt);
    // The channel's ebb carries a swimming lizard south.
    if (player.swimming) {
      current(tickFeet.x, tickFeet.z, flow);
      if (flow.z !== 0) player.carry(flow.x * dt, 0, flow.z * dt, 0);
    }
    climate.step(dt);
    const moving = input.move.x !== 0 || input.move.y !== 0;
    vitals.step(dt, climate.now, {
      still: player.grounded && !moving && player.horizontalSpeed < 0.02,
      running: input.run && moving && player.horizontalSpeed > 0.3,
      swimming: player.swimming,
      groomed: false,
    });
    wounds.step(dt);
    player.speedScale = vitals.speedScale;
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
    visual.downed = wounds.down;
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
    lizard.updateBodySpheres();
    log.update(alpha);
    herons.update(alpha);
    swimmers.update(alpha, frameDt);
    markers.update(frameDt, camera.position);
    if (messageLeft !== null && (messageLeft -= frameDt) <= 0) {
      messageLeft = null;
      if (run.state === 'running' || run.state === 'ready') hud.message(null);
    }
    if (introShown && run.state !== 'ready') {
      introShown = false;
      hud.intro(false);
    }
    toFinish.set(FINISH.x, feet.y, FINISH.z);
    const distance = Math.max(0, Math.hypot(FINISH.x - feet.x, FINISH.z - feet.z) - FINISH.r);
    toFinish.applyMatrix4(camera.matrixWorldInverse);
    hud.status(run.time, run.best, distance, Math.atan2(toFinish.x, -toFinish.z));
    hud.danger(run.danger);
    vitalsPanel({
      health: vitals.health,
      warmth: vitals.warmth,
      fullness: vitals.fullness,
      air: vitals.air,
      healthRate: vitals.rate.health,
      warmthRate: vitals.rate.warmth,
    });
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
