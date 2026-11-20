import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { FIXED_DT, startLoop } from './loop';
import { createScene, followSun } from './render/scene';
import { ViewCheck } from './render/viewCheck';
import { CelRenderer } from './render/cel';
import { buildTerrain, IGNORE_IGUANAS, PLAYER_GROUP, terrainHeight } from './world/terrain';
import { buildObstacles, covers, type Obstacle } from './world/obstacles';
import { buildProps } from './world/props';
import { Algae } from './world/algae';
import { loadReefKit, Reef } from './world/reef';
import { SeaBed } from './world/seaBed';
import { forestCover, SPAWN, TORTOISE_ROUTE } from './world/layout';
import { updateUnderwaterView } from './world/shore';
import { Water } from './world/water';
import { Splashes } from './world/splashes';
import { Plants } from './world/plants';
import { Route, Regrowth } from './creatures/route';
import { Tortoise } from './creatures/tortoise';
import { Crabs } from './creatures/crab';
import { Fishes } from './creatures/fish';
import { Iguanas } from './creatures/iguana';
import { Hawk, PATROL } from './creatures/hawk';
import { findPerches } from './creatures/perches';
import { quarries } from './creatures/quarry';
import { StrikePuff } from './creatures/strikePuff';
import { Cover } from './world/cover';
import { Wounds } from './player/wounds';
import { Spines } from './player/spines';
import { Vitals } from './player/vitals';
import { ClimateSense } from './player/climate';
import { waterDepth, WATER_Y } from './world/shore';
import { Input, type InputState } from './input';
import { PlayerController } from './player/controller';
import { MovementStateMachine, movementFacts } from './player/state';
import { LizardModel } from './player/lizardModel';
import { LizardVisual } from './player/visual';
import { Feeding } from './player/feeding';
import { FollowCamera } from './camera/followCamera';
import { OccluderFade } from './camera/occluderFade';
import { createHud } from './hud';
import { LagoonView } from './island/lagoonView';
import { WalkOut } from './island/walkOut';
import { Goals } from './goals';
import { createGoalsPanel } from './goalsPanel';
import { createTestHooks } from './debug/createTestHooks';
import lizardUrl from './assets/lizard.glb?url';
import plantsUrl from './assets/plants.glb?url';
import propsUrl from './assets/props.glb?url';
import tortoiseUrl from './assets/tortoise.glb?url';
import crabUrl from './assets/crab.glb?url';
import hawkUrl from './assets/hawk.glb?url';
import reefUrl from './assets/reef.glb?url';
import { LEVEL } from './level';
import { stageSelect } from './stageSelect';
import { dunes } from './dunes/main';
import { lagoon } from './lagoon/main';
import { tunnels } from './tunnels/main';
import { endKeys, runKeys } from './dunes/hud';
import { clearForPuzzle, FIG_TREE, SNAG } from './island/layout';
import { Figs } from './island/figs';
import { Snag } from './island/snag';
import { IslandRun } from './island/run';
import { overCrack } from './island/crack';

async function main() {
  // The wasm build loads with the module. The single-file preview build swaps in the compat package
  // (wasm inlined in the script), which has to be started first.
  await (RAPIER as { init?: () => Promise<void> }).init?.();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  const { renderer, scene, camera, sun, sky } = createScene(document.body);
  const cel = new CelRenderer(renderer, sky, sun);
  buildTerrain(scene, world);
  const landmarks = buildObstacles(scene, world);
  const props = await buildProps(propsUrl, scene, world, landmarks);
  // Everything as it was laid out, which the plants, algae and reef are laid out round, so the
  // puzzle's clearings leave them all where they were.
  const laidOut = [...landmarks, ...props.obstacles];
  // The way out: the crack, kept clear, the fig tree and the dead tree on the rim.
  const kept = clearForPuzzle(props.obstacles, scene, world);
  const figs = new Figs(scene, world, FIG_TREE, props.figTree, (): readonly Obstacle[] => steerRound);
  const snag = new Snag(scene, world, SNAG, props.snag);
  const obstacles: Obstacle[] = [...landmarks, ...kept, figs.tree, snag.obstacle];
  // What the tortoise steers round, and figs stop against: all but the dead tree, which it's meant to bump.
  const steerRound: Obstacle[] = obstacles.filter((o) => o !== snag.obstacle);
  const algae = new Algae(scene, props.algae, laidOut);
  // Corals and urchins on the sea floor, clear of the algae.
  const reefKit = await loadReefKit(reefUrl);
  const reef = new Reef(scene, reefKit.geometry, laidOut, (x, z) => algae.all().some((p) => Math.abs(p.x - x) < 0.03 && Math.abs(p.z - z) < 0.03));
  const water = new Water(scene);
  cel.waterY = WATER_Y;
  const splashes = new Splashes(water);
  figs.onSplash = (x, z) => water.ripple(x, z, 0.6);
  // Plants grow anywhere a rock, log or tree (or its rim) isn't.
  const open = (x: number, z: number) => !laidOut.some((o) => covers(o, x, z, 0.015));
  const plants = await Plants.load(plantsUrl, scene, world, open, SPAWN);
  // Nothing grows down in the crack or at the new trees' feet.
  for (const p of [...plants.all]) {
    if (overCrack(p.x, p.z, 0.01) || covers(figs.tree, p.x, p.z, 0.02) || covers(snag.obstacle, p.x, p.z, 0.02)) plants.eat(p);
  }
  const route = new Route(TORTOISE_ROUTE.x, TORTOISE_ROUTE.z, TORTOISE_ROUTE.rx, TORTOISE_ROUTE.rz);
  const regrowth = new Regrowth(route, plants);
  const tortoise = await Tortoise.load(tortoiseUrl, scene, world, route, plants, figs, () => steerRound);

  const player = new PlayerController(world, new THREE.Vector3(SPAWN.x, terrainHeight(SPAWN.x, SPAWN.z), SPAWN.z), (PLAYER_GROUP << 16) | 0xffff);
  player.setFeet(player.feetAt(1, new THREE.Vector3()), SPAWN.yaw);
  player.stillGroups = IGNORE_IGUANAS;
  const states = new MovementStateMachine();

  const lizard = await LizardModel.load(lizardUrl);
  scene.add(lizard.root);
  const visual = new LizardVisual(lizard, player, world);
  const feeding = new Feeding(lizard, algae);
  const iguanas = await Iguanas.load(lizardUrl, scene, world, player, obstacles, algae, plants, water);
  // Reef fish keep clear of the lizard and the other iguanas, unless the lizard is quick or corners one.
  const fishes = new Fishes(scene, reefKit.geometry, reefKit.extras, obstacles, new SeaBed(obstacles), [player.position, ...iguanas.list.map((ig) => ig.body.position)], lizard.bodySpheres);
  const crabs = await Crabs.load(crabUrl, scene, world, algae, player, lizard, iguanas.list.map((ig) => ({ body: ig.body, model: ig.model })));

  // Health, warmth, food and air. The hawk's strikes take health; at none the lizard goes down and
  // comes back at the spawn.
  const vitals = new Vitals();
  feeding.onMouthful = () => vitals.eat();
  const wounds = new Wounds(player, lizard, vitals, () => {
    player.setFeet(new THREE.Vector3(SPAWN.x, terrainHeight(SPAWN.x, SPAWN.z), SPAWN.z), SPAWN.yaw);
    followCam.yaw = SPAWN.yaw;
  });
  const cover = new Cover(world, obstacles, plants);
  const climate = new ClimateSense(player, cover, () => iguanas.list.filter((ig) => !ig.down).map((ig) => ig.body.position), waterDepth);
  const prey = quarries(player, lizard, wounds, iguanas, crabs, tortoise);
  const hawk = await Hawk.load(hawkUrl, scene, (fit) => findPerches(steerRound, forestCover, PATROL, fit), cover, prey);

  const fade = new OccluderFade(world, obstacles);
  const followCam = new FollowCamera(camera, world, player.body, fade.handles);
  followCam.yaw = SPAWN.yaw;

  const input = new Input(renderer.domElement);
  const hud = createHud();
  stageSelect();
  // One goal per creature, the algae and the fish.
  let basking = false;
  let canEat = false;
  const goals = new Goals([
    { id: 'hawk', label: 'Survive a hawk attack', met: () => hawk.survived > 0 },
    { id: 'tortoise', label: 'Ride a giant tortoise', met: () => tortoise.ridden, hold: 1 },
    { id: 'crab', label: 'Get groomed by a crab', met: () => crabs.groomingPlayer },
    { id: 'iguana', label: 'Bask beside another iguana', met: () => basking && climate.now.company > 0 && climate.now.sun >= 0.5, hold: 2 },
    { id: 'algae', label: 'Eat some algae', met: () => feeding.mouthfuls > 0 },
    { id: 'fish', label: 'Touch a fish', met: () => fishes.touched > 0 },
  ]);
  const goalsPanel = createGoalsPanel(hud.corner, goals.list);
  // The objective: over the crack. Once there, the run's end screen: R from the start, C on.
  const run = new IslandRun(player, tortoise, snag, figs);
  run.onHome = () => hud.message('Across the crack!', 'Over the bank to the west lies the mangrove lagoon.', endKeys('island'));
  // Going on (C): the lizard walks on west up the bank to where the mangrove lagoon, the next stage,
  // opens out below, as the screen fades; then it's the lagoon.
  const lagoonView = new LagoonView(scene);
  void lagoonView.load();
  const walkOut = new WalkOut(player);
  const leave = (then: () => void) => {
    hud.message(null);
    walkOut.start(then);
  };
  runKeys('island', run, (go) => leave(go));
  let introShown = true;
  hud.intro(true);
  hud.objective(run.objective.text, run.objective.hint);
  goals.onDone = (goal) => goalsPanel.done(goal);
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
  // Trampled by the tortoise: shoved out of its path, with the same jolt and flash.
  tortoise.onTrample = (dx, dz, shell) => wounds.trample(dx, dz, shell);
  wounds.onTrample = () => {
    followCam.shake();
    hud.flash();
  };
  // Up on a cactus: it hops off, with the flash.
  const spines = new Spines(world, obstacles);
  wounds.onPrick = () => hud.flash();
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
    tortoise, crabs, iguanas, algae, reef, fishes, feeding, water, hawk, cover, prey, wounds, vitals, climate, puff, goals, figs, snag, run, walkOut, leave, lagoonView, canEat: () => canEat,
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
    // The cold slows it too, on land and in the water.
    player.speedScale = plants.speedScale(tickFeet.x, tickFeet.z, Math.sin(player.yaw), Math.cos(player.yaw)) * vitals.speedScale;
    // The tortoise moves first, shoving the lizard out of its way before the lizard's own move.
    tortoise.step(dt, player);
    regrowth.step(dt);
    figs.step(dt, lizard.bodySpheres, { x: Math.sin(player.yaw), z: Math.cos(player.yaw) });
    snag.step(dt);
    iguanas.step(dt);
    crabs.step(dt);
    fishes.step(dt);
    hawk.step(dt);
    // Knocked down, or stuck down in the lava crack, the lizard lies still whatever the controls say.
    let input = wounds.down || run.held ? STILL : forcedInput ? { ...frameInput, ...forcedInput } : frameInput;
    const out = walkOut.step(dt);
    if (out) input = { ...input, ...out };
    climate.step(dt);
    const moving = input.move.x !== 0 || input.move.y !== 0;
    // The start card stays up until the player first moves the lizard, as on the dunes.
    if (introShown && moving) {
      introShown = false;
      hud.intro(false);
    }
    basking = player.grounded && !moving && player.horizontalSpeed < 0.02 && !wounds.down;
    vitals.step(dt, climate.now, {
      still: player.grounded && !moving && player.horizontalSpeed < 0.02,
      running: input.run && moving && player.horizontalSpeed > 0.3,
      swimming: player.swimming,
      groomed: crabs.groomingPlayer,
    });
    wounds.step(dt);
    const hop = wounds.down ? null : spines.shake(player);
    if (hop) wounds.prick(hop.x, hop.z);
    goals.step(dt);
    player.step(dt, input);
    run.step(dt);
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
  const view = new ViewCheck();
  const readInput = (frameDt: number) => {
    frameInput = input.read(frameDt);
    followCam.applyInput(frameInput);
    if (frameInput.bite && !wounds.down) feeding.bite();
  };
  const updateViews = (alpha: number, frameDt: number) => {
    // What the camera saw last frame: what's off screen or far off is animated and fitted less.
    view.update(camera);
    // The tortoise first: the lizard is fitted to its shell where it's drawn this frame.
    tortoise.update(alpha, frameDt);
    snag.update(alpha);
    figs.update();
    const { text, hint } = run.objective;
    hud.objective(text, hint);
    hud.banner(run.banner);
    visual.downed = wounds.down;
    visual.update(states.state, alpha, frameDt);
    hawk.update(alpha, frameDt);
    puff.update(frameDt);
    hud.vitals({
      health: vitals.health,
      warmth: vitals.warmth,
      fullness: vitals.fullness,
      air: vitals.air,
      healthRate: vitals.rate.health,
      warmthRate: vitals.rate.warmth,
    });
    hud.down(wounds.countdown);
    iguanas.update(alpha, frameDt, view);
    player.feetAt(alpha, feet);
    const steering = player.bodyTurning || player.horizontalSpeed > 0.02;
    // Swimming, the camera follows the lizard up and down as if it were on the ground.
    const groundedFeetY = player.grounded || player.swimming ? player.feetAt(1, groundedFeet).y : null;
    // Stuck down in the lava crack, look down on the lizard from overhead rather than at the wall.
    followCam.overhead = run.fallen !== null;
    followCam.update(feet, groundedFeetY, player.yawAt(alpha), steering, frameDt);
    if (viewOffset) {
      const at = viewTarget ?? feet;
      camera.position.copy(at).add(viewOffset);
      camera.lookAt(at);
    }
    walkOut.view(camera, feet, player.yawAt(alpha), frameDt);
    hud.fade(walkOut.fade);
    // Over the crack, the lagoon beyond the west bank comes into view.
    lagoonView.group.visible = run.state === 'home';
    fade.update(camera.position, followCam.target, player.yawAt(alpha), frameDt);
    // Plants part for the lizard's body, and for the camera so tall stems don't fill the view.
    lizard.updateBodySpheres();
    // Algae at the mouth: say F eats it.
    canEat = !wounds.down && !!feeding.inReach();
    hud.canEat(canEat);
    Object.assign(cameraPusher, { x: camera.position.x, y: camera.position.y, z: camera.position.z });
    crabs.update(alpha, frameDt, view);
    plants.update(pushers, frameDt);
    water.update(frameDt);
    algae.update(frameDt);
    reef.update(frameDt);
    fishes.update(alpha);
    updateUnderwaterView(scene, camera);
    followSun(sun, feet);
  };
  const draw = () => {
    cel.render(scene, camera);
    hooks.ready = true;
  };

  // Opened with ?test, tests drive time themselves from the start: no real-time loop, and nothing is
  // drawn until a test asks. On a software renderer, a page that has drawn takes over a second to close.
  const driven = new URLSearchParams(location.search).has('test');
  if (driven) {
    // What the first frame drawn would have done for everything that stays put.
    scene.updateMatrixWorld();
    hooks.ready = true;
  }
  let stopLoop: (() => void) | null = driven ? null : startLoop({
    step: tick,
    render(alpha, frameDt) {
      // Input is read once per rendered frame; the next physics steps use it.
      readInput(frameDt);
      updateViews(alpha, frameDt);
      draw();
    },
  });

  // Tests drive time themselves: the first call stops the real-time loop for good, then each call
  // runs exactly `n` fixed steps (input, physics, camera, animation) and, if asked, draws once at the end.
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
  hooks.renderStats = () => {
    stopLoop?.();
    stopLoop = null;
    draw();
    let skinned = 0;
    scene.traverse((o) => (skinned += (o as THREE.SkinnedMesh).isSkinnedMesh ? 1 : 0));
    return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, skinned };
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

if (LEVEL === 'dunes') dunes();
else if (LEVEL === 'lagoon') lagoon();
else if (LEVEL === 'tunnels') tunnels();
else main();
