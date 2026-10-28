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
import { clock, createDunesHud, endKeys, runKeys, type HudText } from '../dunes/hud';
import lizardUrl from '../assets/lizard.glb?url';
import rockUrl from '../assets/tunnels.glb?url';
import lightUrl from '../assets/tunnels-light.bin?url';
import owlUrl from '../assets/owl.glb?url';
import whitetipUrl from '../assets/whitetip.glb?url';
import sealionUrl from '../assets/sealion.glb?url';
import { loadFreeRigKit } from '../render/freeRig';
import { FINISH, lightAt, outside, setLight, START, START_Y, terrainOrUpper } from './layout';
import { buildRock, buildSunbeams } from './rock';
import { RockCutaway } from './cutaway';
import { TunnelsRun } from './run';
import { HEARING, Owls } from './owl';
import { Sharks } from './sharks';
import { SeaLions } from './sealions';

const TEXT: HudText = {
  intro:
    '<h2>Lava tunnels</h2>' +
    'Find your way through the lava tubes and out to the <b>sea</b>, under the <b>golden light</b>.' +
    '<ul><li>The tunnels run on <b>two floors</b>. Holes in the floor drop you to the tubes below: some are dead ends, some are the way on.</li>' +
    '<li>No jumping back up a hole. Find a <b>rubble pile</b> to climb up through a hole in the roof.</li>' +
    '<li>One gap is narrow enough to <b>leap at a run</b> (Shift and Space).</li>' +
    '<li>Skylights let the sun in: warm patches, and landmarks. Barn owls roost in some: they hunt by <b>sound</b>, so walk, don\'t run, under them.</li></ul>' +
    '<span class="go">Move to start.</span>',
  watched: '',
  chased: '',
};

/**
 * Fog in the tubes: dark, close, warm grey; out in the cove, the sky's and far off, so the islet
 * shows across the water. Under water: dark green in the tunnels, blue-green in the sea.
 */
const CAVE_FOG = { colour: new THREE.Color(0x1d1916), near: 1.2, far: 5 };
const OPEN_FOG = { colour: new THREE.Color(PALETTE.sky), near: 4, far: 24 };
const UNDERWATER_FOG = { colour: new THREE.Color(0x16302f), near: 0.05, far: 0.9 };
const SEA_FOG = { colour: new THREE.Color(0x2a7f8c), near: 0.05, far: 1.4 };

/** The lava tunnels (`?level=tunnels`): a two-floor maze of lava tubes, holes to fall through and rubble to climb. */
export async function tunnels() {
  await (RAPIER as { init?: () => Promise<void> }).init?.();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  // The light is baked: the ground's colours read it as the terrain is built.
  setLight(await loadBinary(lightUrl));
  const { renderer, scene, camera, sun, sky } = createScene(document.body);
  const cel = new CelRenderer(renderer, sky, sun);
  cel.waterY = WATER_Y;
  scene.fog = new THREE.Fog(CAVE_FOG.colour.clone(), CAVE_FOG.near, CAVE_FOG.far);
  const hemisphere = scene.children.find((o) => o instanceof THREE.HemisphereLight) as THREE.HemisphereLight;
  // Nothing underground casts a live shadow: the rock's shade is baked, and the lizard is lit by where it is.
  sun.castShadow = false;
  // A soft fill from the camera keeps the dark lizard readable on dark rock (the rock itself is unlit).
  const fill = new THREE.PointLight(0xffe8d0, 0.25, 1.2, 1);
  camera.add(fill);
  scene.add(camera);
  buildTerrain(scene, world);
  const rock = await buildRock(rockUrl, scene, world);
  const cutaway = new RockCutaway(rock.mesh, scene);
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
  const run = new TunnelsRun(player, visual);
  const [owlKit, whitetipKit, sealionKit] = await Promise.all([
    loadFreeRigKit(owlUrl, 'Owl'),
    loadFreeRigKit(whitetipUrl, 'Whitetip'),
    loadFreeRigKit(sealionUrl, 'SeaLion'),
  ]);
  const owls = new Owls(owlKit, scene);
  const sharks = new Sharks(whitetipKit, scene);
  const sealions = new SeaLions(sealionKit, scene);
  const markers = new Markers(scene, { start: START, finish: FINISH, safe: [], ground: terrainOrUpper });

  const fade = new OccluderFade(world, []);
  // The camera keeps its distance through the rock; the rock in the way is cut away instead.
  const followCam = new FollowCamera(camera, world, player.body, new Set([...fade.handles, rock.collider.handle]));
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
    owls.callOff();
  };
  run.onRespawn = () => {
    owls.callOff();
    followCam.yaw = run.checkpoint.yaw;
  };
  run.onLost = () => flashMessage('Lost in the rock', 'Back to where you last changed floors.');
  run.onCaught = () => flashMessage('Caught by a barn owl!', 'Back to where you last changed floors.');
  owls.onCatch = () => run.caught();
  owls.onHeard = () => flashMessage('The owl heard you!', 'Slip out from under it quietly.');
  let owlWarned = false;
  sharks.onBolt = () => {
    if (!run.startledShark) flashMessage('A whitetip reef shark!', 'Only a pup, resting in the cave. Harmless.');
    run.startledShark = true;
  };
  run.onHome = () => {
    const best = run.best === run.time ? 'A new best!' : `Best ${clock(run.best!)}`;
    messageLeft = null;
    hud.message(`Out to the sea! ${clock(run.time)}`, `${best}. Across the water, sea lions bask on the outer islet.`, endKeys('tunnels'));
  };
  runKeys('tunnels', run);

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
    owls,
    sharks,
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

  const still: Partial<InputState> = { move: { x: 0, y: 0 }, run: false, jump: false };
  const tickFeet = new THREE.Vector3();
  const prey = { feet: tickFeet, loudness: 0, open: true };
  const tick = (dt: number) => {
    let input = forcedInput ? { ...frameInput, ...forcedInput } : frameInput;
    if (run.held) input = { ...input, ...still };
    run.step(dt, input.move.x !== 0 || input.move.y !== 0);
    // What the owls hear: running, a jump or a landing carry; a walk barely; standing still, nothing.
    player.feetAt(1, tickFeet);
    const speed = player.horizontalSpeed;
    prey.loudness = player.landed || player.jumped ? HEARING.thump : speed > 0.12 ? HEARING.run : speed > 0.015 ? HEARING.walk : 0;
    prey.open = run.state === 'running' || run.state === 'ready';
    owls.step(dt, prey);
    run.owlStirred = owls.list.some((o) => o.state !== 'roost');
    if (!owlWarned && owls.list.some((o) => o.inReach(tickFeet))) {
      owlWarned = true;
      flashMessage('A barn owl roosts up in this skylight', 'It hunts by sound: walk here, don\'t run.');
    }
    sharks.step(dt, tickFeet, player.swimming);
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
    cutaway.update(camera.position, viewOffset ? (viewTarget ?? feet) : followCam.target);
    lizard.updateBodySpheres();
    owls.pose(frameDt);
    sharks.pose();
    sealions.pose(frameDt);
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
    const open = outside(camera.position.x, camera.position.z);
    const [a, b] = under ? [UNDERWATER_FOG, SEA_FOG] : [CAVE_FOG, OPEN_FOG];
    fog.color.copy(a.colour).lerp(b.colour, open);
    fog.near = THREE.MathUtils.lerp(a.near, b.near, open);
    fog.far = THREE.MathUtils.lerp(a.far, b.far, open);
    (scene.background as THREE.Color).copy(under ? fog.color : OPEN_FOG.colour);
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
