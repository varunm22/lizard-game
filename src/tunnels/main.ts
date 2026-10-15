import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { FIXED_DT, startLoop } from '../loop';
import { createScene, PALETTE, SUN_OFFSET } from '../render/scene';
import { loadBinary } from '../render/gltf';
import { buildTerrain, IGNORE_IGUANAS, PLAYER_GROUP } from '../world/terrain';
import { waterDepth, WATER_Y } from '../world/shore';
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
import { createTunnelsHooks } from '../debug/createTunnelsHooks';
import { createGoalsPanel } from '../goalsPanel';
import { stageSelect } from '../stageSelect';
import { Markers } from '../dunes/markers';
import { clock, createDunesHud, type HudText } from '../dunes/hud';
import lizardUrl from '../assets/lizard.glb?url';
import rockUrl from '../assets/tunnels.glb?url';
import lightUrl from '../assets/tunnels-light.bin?url';
import { FINISH, lightAt, setLight, START, START_Y, terrainOrUpper } from './layout';
import { buildRock, buildSunbeams } from './rock';
import { TunnelsRun } from './run';

const TEXT: HudText = {
  intro:
    '<h2>Lava tunnels</h2>' +
    'Find your way through the lava tubes to the <b>jameo</b>, a collapse open to the sky, under the <b>golden light</b>.' +
    '<ul><li>The tunnels run on <b>two floors</b>. Holes in the floor drop you to the tubes below: some are dead ends, some are the way on.</li>' +
    '<li>No jumping back up a hole. Find a <b>rubble pile</b> to climb up through a hole in the roof.</li>' +
    '<li>One gap is narrow enough to <b>leap at a run</b> (Shift and Space).</li>' +
    '<li>Skylights let the sun in: warm patches, and landmarks.</li></ul>' +
    '<span class="go">Move to start.</span>',
  watched: '',
  chased: '',
};

/** Fog in the tubes: dark, close, warm grey; and under the flooded stretch's water. */
const CAVE_FOG = { colour: 0x1d1916, near: 1.2, far: 5 };
const UNDERWATER_FOG = { colour: 0x16302f, near: 0.05, far: 0.9 };

/** The lava tunnels (`?level=tunnels`): a two-floor maze of lava tubes, holes to fall through and rubble to climb. */
export async function tunnels() {
  await (RAPIER as { init?: () => Promise<void> }).init?.();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  // The light is baked: the ground's colours read it as the terrain is built.
  setLight(await loadBinary(lightUrl));
  const { renderer, scene, camera, sun, sky } = createScene(document.body);
  const cel = new CelRenderer(renderer, sky, sun);
  cel.waterY = WATER_Y;
  scene.fog = new THREE.Fog(CAVE_FOG.colour, CAVE_FOG.near, CAVE_FOG.far);
  const hemisphere = scene.children.find((o) => o instanceof THREE.HemisphereLight) as THREE.HemisphereLight;
  // Nothing underground casts a live shadow: the rock's shade is baked, and the lizard is lit by where it is.
  sun.castShadow = false;
  // A soft fill from the camera keeps the dark lizard readable on dark rock (the rock itself is unlit).
  const fill = new THREE.PointLight(0xffe8d0, 0.25, 1.2, 1);
  camera.add(fill);
  scene.add(camera);
  buildTerrain(scene, world);
  await buildRock(rockUrl, scene, world);
  const beams = buildSunbeams(scene, SUN_OFFSET);
  const water = new Water(scene);
  const splashes = new Splashes(water);

  const player = new PlayerController(world, new THREE.Vector3(START.x, START_Y, START.z), (PLAYER_GROUP << 16) | 0xffff);
  player.setFeet(new THREE.Vector3(START.x, START_Y, START.z), START.yaw);
  player.stillGroups = IGNORE_IGUANAS;
  const states = new MovementStateMachine();
  const lizard = await LizardModel.load(lizardUrl);
  scene.add(lizard.root);
  const visual = new LizardVisual(lizard, player, world);
  const run = new TunnelsRun(player);
  const markers = new Markers(scene, { start: START, finish: FINISH, safe: [], ground: terrainOrUpper });

  const fade = new OccluderFade(world, []);
  const followCam = new FollowCamera(camera, world, player.body, fade.handles);
  followCam.yaw = START.yaw;
  const input = new Input(renderer.domElement);

  const hud = createDunesHud(TEXT);
  stageSelect();
  const goalsPanel = createGoalsPanel(hud.corner, run.goals.list);
  run.goals.onDone = (goal) => goalsPanel.done(goal);
  let introShown = true;
  let messageLeft: number | null = null;
  const flashMessage = (title: string, detail: string) => {
    hud.message(title, detail);
    messageLeft = 2.5;
  };
  run.onDrop = () => {
    if (run.drops.length === 1) flashMessage('Down to the lower tunnels', 'Find a rubble pile to climb back up.');
  };
  run.onClimb = () => {
    if (run.climbs === 1) flashMessage('Back up through the roof', 'Rubble from old collapses makes a way up.');
  };
  run.onLeap = () => {
    if (run.leaps === 1) flashMessage('Over the gap!', '');
  };
  run.onReset = () => {
    hud.message(null);
    messageLeft = null;
    followCam.yaw = START.yaw;
  };
  run.onHome = () => {
    const best = run.best === run.time ? 'A new best!' : `Best ${clock(run.best!)}`;
    messageLeft = null;
    hud.message(`Out into the jameo! ${clock(run.time)}`, `${best} Press R to go again.`);
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
  const groundedFeet = new THREE.Vector3();
  const lit = { sun: 0, glow: 0 };

  const hooks = createTunnelsHooks({
    world,
    player,
    states,
    camera,
    followCam,
    fade,
    run,
    setInput: (i, forSteps = 0) => {
      forcedInput = i;
      forcedSteps = forSteps;
    },
    viewFrom: (offset, at) => {
      viewOffset = offset && new THREE.Vector3(offset.x, offset.y, offset.z);
      viewTarget = at ? new THREE.Vector3(at.x, at.y, at.z) : null;
    },
  });
  window.__tunnels = hooks;

  const tick = (dt: number) => {
    const input = forcedInput ? { ...frameInput, ...forcedInput } : frameInput;
    run.step(dt, input.move.x !== 0 || input.move.y !== 0);
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
  const fog = scene.fog as THREE.Fog;
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
    lizard.updateBodySpheres();
    // Light the lizard by the light where it is: dim deep in the tubes, warm in a skylight's sun.
    lightAt(feet.x, feet.y + 0.03, feet.z, lit);
    hemisphere.intensity = 0.7 + 1.0 * Math.pow(lit.glow, 0.7);
    sun.intensity = 2.4 * THREE.MathUtils.smoothstep(lit.sun, 0.2, 0.7);
    sun.target.position.copy(feet);
    sun.position.copy(feet).add(SUN_OFFSET);
    markers.update(frameDt, camera.position);
    beams.material.uniforms.time.value += frameDt;
    if (messageLeft !== null && (messageLeft -= frameDt) <= 0) {
      messageLeft = null;
      if (run.state !== 'home') hud.message(null);
    }
    if (introShown && run.state !== 'ready') {
      introShown = false;
      hud.intro(false);
    }
    toFinish.set(FINISH.x, feet.y, FINISH.z);
    const distance = Math.max(0, Math.hypot(FINISH.x - feet.x, FINISH.z - feet.z) - FINISH.r);
    toFinish.applyMatrix4(camera.matrixWorldInverse);
    hud.status(run.time, run.best, distance, Math.atan2(toFinish.x, -toFinish.z));
    water.update(frameDt);
    const under = waterDepth(camera.position) > 0;
    const f = under ? UNDERWATER_FOG : CAVE_FOG;
    fog.color.set(f.colour);
    fog.near = f.near;
    fog.far = f.far;
    (scene.background as THREE.Color).set(under ? UNDERWATER_FOG.colour : PALETTE.sky);
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
