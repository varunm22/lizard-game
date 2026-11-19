import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { FIXED_DT, startLoop } from '../loop';
import { createScene, followSun } from '../render/scene';
import { buildTerrain, IGNORE_IGUANAS, PLAYER_GROUP, terrainHeight } from '../world/terrain';
import { updateUnderwaterView, WATER_Y, waterDepth } from '../world/shore';
import { covers } from '../world/obstacles';
import { Cover } from '../world/cover';
import { Plants } from '../world/plants';
import { ClimateSense } from '../player/climate';
import { Vitals, type DownCause } from '../player/vitals';
import { Wounds } from '../player/wounds';
import { Feeding } from '../player/feeding';
import { Algae } from '../world/algae';
import { createEatPrompt, createHitFlash, createVitalsPanel } from '../vitalsPanel';
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
import { createBeachHooks } from '../debug/createBeachHooks';
import { createGoalsPanel } from '../goalsPanel';
import { stageSelect } from '../stageSelect';
import { Markers } from '../dunes/markers';
import { clock, createDunesHud, endKeys, runKeys, type HudText } from '../dunes/hud';
import { loadKit } from '../lagoon/props';
import lizardUrl from '../assets/lizard.glb?url';
import propsUrl from '../assets/props.glb?url';
import dunesUrl from '../assets/dunes.glb?url';
import plantsUrl from '../assets/plants.glb?url';
import seaLionsUrl from '../assets/sea-lions.glb?url';
import penguinUrl from '../assets/penguin.glb?url';
import cormorantUrl from '../assets/cormorant.glb?url';
import { beachLava, START } from './layout';
import { beachAlgaeSites, beachPlants, buildBeachProps } from './props';
import { loadSeaLionKit } from './sealionBody';
import { SeaLions } from './sealions';
import { Birds } from './birds';
import { displayNod, DISPLAY_TIME, EASE, Rivals, RIVALS, SURGE, WIN } from './rivals';
import { wearBreedingColours } from './breeding';
import { BeachRun, CAUGHT_TIME } from './run';
import { createBeachHud } from './hud';

const TEXT: HudText = {
  intro:
    '<h2>Sea lion beach</h2>' +
    "Grown now, and in your <b>breeding colours</b>: win a <b>display rock</b> on the lava behind the beach, and a female's eye." +
    '<ul><li>The <b>bull</b> patrols the waterline. On his stretch of sand he barks a warning, then charges: get off his beach, or dodge aside, he turns slowly.</li>' +
    '<li>Rival males hold the three rocks. Answer each head-bob with your own (<b>B</b>): the younger ones back down.</li>' +
    '<li>The old male never does. Walk into him and <b>shove</b>: hold <b>W</b>, and butt (<b>Space</b>) as he eases off.</li>' +
    '<li>Stand on a vacant rock to <b>claim</b> it. See off the male who comes back for it, then display to the female who comes over.</li>' +
    '<li>The water <b>chills</b> you: bask on the black lava. Bite (<b>F</b>) the algae at the waterline to eat.</li></ul>' +
    '<span class="go">Move to start.</span>',
  watched: 'A rival is warning you off!',
  chased: 'Charge!',
  controls: [
    ['F', 'bite'],
    ['B', 'display'],
  ],
};

/** The sea lion beach (`?level=beach`), the last stage: ashore past the bull, and win a rock on the lek. */
export async function beach() {
  await (RAPIER as { init?: () => Promise<void> }).init?.();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  const { renderer, scene, camera, sun, sky } = createScene(document.body);
  const cel = new CelRenderer(renderer, sky, sun);
  cel.waterY = WATER_Y;
  buildTerrain(scene, world);
  const kit = await loadKit([propsUrl, dunesUrl]);
  const { obstacles, crowns } = buildBeachProps(kit, scene, world);
  const open = (x: number, z: number) => !obstacles.some((o) => covers(o, x, z, 0.015));
  const plants = await Plants.load(plantsUrl, scene, world, open, START, (o) => beachPlants(o));
  const algae = new Algae(scene, { green: kit.geometry.get('algae_green')!, red: kit.geometry.get('algae_red')! }, [], beachAlgaeSites());
  const water = new Water(scene);
  const splashes = new Splashes(water);

  const player = new PlayerController(world, new THREE.Vector3(START.x, terrainHeight(START.x, START.z), START.z), (PLAYER_GROUP << 16) | 0xffff);
  player.setFeet(player.feetAt(1, new THREE.Vector3()), START.yaw);
  player.stillGroups = IGNORE_IGUANAS;
  const states = new MovementStateMachine();
  const lizard = await LizardModel.load(lizardUrl);
  await wearBreedingColours(lizard);
  scene.add(lizard.root);
  const visual = new LizardVisual(lizard, player, world);
  const vitals = new Vitals();
  const wounds = new Wounds(player, lizard, vitals, () => run.afterDown(), CAUGHT_TIME);
  const cover = new Cover(world, obstacles, plants, crowns);
  const feeding = new Feeding(lizard, algae);
  feeding.onMouthful = () => vitals.eat();

  const sealions = new SeaLions(await loadSeaLionKit(seaLionsUrl), scene, world, player);
  const birds = await Birds.load(penguinUrl, cormorantUrl, scene, (out) => (player.swimming ? player.feetAt(1, out) : null));
  // The rival males in their breeding colours, each a little different; the females plain and smaller-looking, duller.
  const rivalModels: LizardModel[] = [];
  for (const r of RIVALS) {
    const m = await LizardModel.load(lizardUrl);
    await wearBreedingColours(m, new THREE.Color(...r.tint));
    rivalModels.push(m);
  }
  const femaleModels: LizardModel[] = [];
  for (let i = 0; i < 3; i++) {
    const m = await LizardModel.load(lizardUrl);
    const tint = new THREE.Color(0.8 + 0.04 * i, 0.74, 0.7);
    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const tinted = (mat: THREE.Material) => {
        const c = mat.clone() as THREE.MeshToonMaterial;
        c.color?.multiply(tint);
        return c;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(tinted) : tinted(mesh.material);
    });
    femaleModels.push(m);
  }
  let rawInput: InputState | null = null;
  let pressedJump = false;
  const free = (): boolean => (run.state === 'ready' || run.state === 'running') && !wounds.down && !player.swimming;
  const rivals: Rivals = new Rivals(rivalModels, femaleModels, scene, world, {
    player,
    free,
    pushing: () => !!rawInput && rawInput.move.y > 0,
    butting: () => pressedJump,
  });
  const run: BeachRun = new BeachRun(player, wounds, vitals, sealions, rivals, birds);
  sealions.prey = run.prey;
  const climate = new ClimateSense(player, cover, () => [...rivals.rivals.map((r) => r.npc), ...rivals.females.map((f) => f.npc)].map((n) => n.body.position), waterDepth, beachLava);
  const markers = new Markers(scene, { start: START, finish: { x: 1e3, z: 1e3, r: 0 }, safe: [] });

  const fade = new OccluderFade(world, obstacles);
  const followCam = new FollowCamera(camera, world, player.body, fade.handles);
  followCam.yaw = START.yaw;
  const input = new Input(renderer.domElement);

  const hud = createDunesHud(TEXT);
  const beachHud = createBeachHud();
  const vitalsPanel = createVitalsPanel();
  const eatPrompt = createEatPrompt();
  let canEat = false;
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
    sealion: 'Flattened by the bull!',
    cold: 'Too cold to move!',
    air: 'Out of air!',
    hunger: 'Starved!',
  };
  run.onCaught = (by) => {
    messageLeft = null;
    hud.message(DOWN[by] ?? 'Down!', run.ashore ? 'Back where you came ashore...' : 'Back to the reef...');
  };
  run.onHurt = () => flashMessage('The bull caught you!', 'Keep off his stretch of beach, or dodge aside.');
  run.onAshore = () => flashMessage('Ashore', 'Mind the bull. The lek is on the lava behind the beach.');
  run.onRespawn = () => hud.message(null);
  run.onReset = () => {
    hud.message(null);
    messageLeft = null;
    followCam.yaw = START.yaw;
  };
  run.onHome = () => {
    const best = run.best === run.time ? 'A new best!' : `Best ${clock(run.best!)}`;
    hud.message(`Chosen! ${clock(run.time)}`, `Her eggs will hatch in the dunes. ${best}`, endKeys('beach'));
  };
  rivals.onEvent = (what) => {
    const say: Record<string, [string, string]> = {
      outDisplayed: ['He backs down', 'Out-displayed, he goes off to sulk.'],
      won: ['Shoved off!', 'He goes off to sulk. His rock is free.'],
      lost: ['Pushed back', 'He holds his ground. Try again, butting as he eases off.'],
      claimed: ['Your rock!', 'Hold it: he will be back for it.'],
      defended: ['Seen off!', 'A female is coming over. Display to her (B).'],
      lostRock: ['Rock lost', 'Off your rock too long, or pushed off it.'],
      chosen: ['', ''],
      female: ['', ''],
    };
    const [t, d] = say[what];
    if (t) flashMessage(t, d);
  };
  runKeys('beach', run);

  let forcedInput: Partial<InputState> | null = null;
  let forcedSteps = 0;
  let frameInput: InputState = input.read(0);
  let viewOffset: THREE.Vector3 | null = null;
  let viewTarget: THREE.Vector3 | null = null;
  const feet = new THREE.Vector3();
  const tickFeet = new THREE.Vector3();
  const toTarget = new THREE.Vector3();
  const target = { x: 0, z: 0, r: 0 };
  const groundedFeet = new THREE.Vector3();
  const cameraPusher = { x: 0, y: 0, z: 0, r: 0.03 };
  const pushers = [...lizard.bodySpheres, ...rivalModels.flatMap((m) => m.bodySpheres), ...femaleModels.flatMap((m) => m.bodySpheres), cameraPusher];
  /** The lizard's own display under way (s in), or -1. */
  let displayT = -1;
  let jumpWas = false;
  const display = () => {
    if (displayT >= 0 || wounds.down || player.swimming || !player.grounded) return;
    displayT = 0;
    rivals.display();
  };

  const hooks = createBeachHooks({
    world, obstacles, player, states, camera, followCam, fade, run, sealions, rivals, birds, vitals, wounds, display, playerDisplay: () => displayT,
    setInput: (i, forSteps = 0) => {
      forcedInput = i;
      forcedSteps = forSteps;
    },
    viewFrom: (offset, at) => {
      viewOffset = offset && new THREE.Vector3(offset.x, offset.y, offset.z);
      viewTarget = at ? new THREE.Vector3(at.x, at.y, at.z) : null;
    },
  });
  window.__beach = hooks;

  const still: Partial<InputState> = { move: { x: 0, y: 0 }, run: false, jump: false };
  const tick = (dt: number) => {
    let input = forcedInput ? { ...frameInput, ...forcedInput } : frameInput;
    rawInput = input;
    pressedJump = input.jump && !jumpWas;
    jumpWas = input.jump;
    if (run.held) input = { ...input, ...still };
    run.step(dt, input.move.x !== 0 || input.move.y !== 0);
    if (frameInput.display) display();
    if (displayT >= 0 && (displayT += dt) >= DISPLAY_TIME) displayT = -1;
    sealions.step(dt);
    rivals.step(dt);
    birds.step(dt);
    player.feetAt(1, tickFeet);
    climate.step(dt);
    const moving = input.move.x !== 0 || input.move.y !== 0;
    vitals.step(dt, climate.now, {
      still: player.grounded && !moving && player.horizontalSpeed < 0.02,
      running: input.run && moving && player.horizontalSpeed > 0.3,
      swimming: player.swimming,
      groomed: false,
    });
    wounds.step(dt);
    if (frameInput.bite && !wounds.down) feeding.bite();
    player.speedScale = plants.speedScale(tickFeet.x, tickFeet.z, Math.sin(player.yaw), Math.cos(player.yaw)) * vitals.speedScale;
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
    const nodGoal = rivals.match ? 0.15 + 0.1 * Math.sin(run.time * 10) : displayNod(displayT);
    lizard.nod += (nodGoal - lizard.nod) * (1 - Math.exp(-30 * frameDt));
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
    sealions.update(alpha, frameDt, camera.position);
    rivals.update(alpha, frameDt, camera.position);
    birds.update(alpha, camera.position);
    algae.update(frameDt);
    Object.assign(cameraPusher, { x: camera.position.x, y: camera.position.y, z: camera.position.z });
    plants.update(pushers, frameDt);
    canEat = !wounds.down && !!feeding.inReach();
    eatPrompt(canEat);
    markers.update(frameDt, camera.position);
    const m = rivals.match;
    beachHud.shove(m && m.push / WIN, !!m && m.t >= SURGE && m.t < SURGE + EASE);
    beachHud.claim(rivals.claiming && rivals.claiming.t / 2);
    if (messageLeft !== null && (messageLeft -= frameDt) <= 0) {
      messageLeft = null;
      if (run.state === 'running' || run.state === 'ready') hud.message(null);
    }
    if (introShown && run.state !== 'ready') {
      introShown = false;
      hud.intro(false);
    }
    run.target(target);
    toTarget.set(target.x, feet.y, target.z);
    const distance = Math.max(0, Math.hypot(target.x - feet.x, target.z - feet.z) - target.r);
    toTarget.applyMatrix4(camera.matrixWorldInverse);
    hud.status(run.time, run.best, distance, Math.atan2(toTarget.x, -toTarget.z));
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
