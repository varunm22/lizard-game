import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FIXED_DT, startLoop } from './loop';
import { createScene, followSun } from './render/scene';
import { buildTerrain, IGNORE_IGUANAS, PLAYER_GROUP, IGNORE_STEMS, IGNORE_STEMS_AND_IGUANAS, terrainHeight } from './world/terrain';
import { buildObstacles, covers } from './world/obstacles';
import { buildProps } from './world/props';
import { Algae } from './world/algae';
import { forestCover, lavaCover, ROCK_PILES, SPAWN, TORTOISE_ROUTE } from './world/layout';
import { SEA_DEPTH, shoreX, updateUnderwaterView, WATER_Y } from './world/shore';
import { Water } from './world/water';
import { Splashes } from './world/splashes';
import { Plants, type PlantKind } from './world/plants';
import { Route, Regrowth } from './creatures/route';
import { Tortoise } from './creatures/tortoise';
import { Crabs } from './creatures/crab';
import { Iguanas } from './creatures/iguana';
import { Hawk, PATROL } from './creatures/hawk';
import { findPerches } from './creatures/perches';
import { quarries } from './creatures/quarry';
import { StrikePuff } from './creatures/strikePuff';
import { Cover } from './world/cover';
import { pileShelters } from './world/rockPiles';
import { MAX_HITS, Wounds } from './player/wounds';
import { Input, type InputState } from './input';
import { PlayerController } from './player/controller';
import { MovementStateMachine } from './player/state';
import { LizardModel } from './player/lizardModel';
import { LizardVisual } from './player/visual';
import { Feeding } from './player/feeding';
import { FollowCamera } from './camera/followCamera';
import { OccluderFade } from './camera/occluderFade';
import { createHud } from './hud';
import type { GameTestHooks } from './debug/testHooks';
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
  const prey = quarries(player, lizard, wounds, iguanas, crabs);
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
  const jawRest = lizard.root.getObjectByName('jaw')?.quaternion.clone();
  const hooks: GameTestHooks = {
    ready: false,
    advance: () => {},
    frame: () => {},
    physicsSteps: 0,
    terrainHeight,
    obstacles: () =>
      obstacles.map((o) => ({
        name: o.name,
        kind: o.kind,
        x: o.position.x,
        y: o.position.y,
        z: o.position.z,
        height: o.height,
        radius: o.radius,
        opacity: (o.mesh.material as THREE.Material).opacity,
      })),
    groundAt: (x, z, from = 5) => {
      const hit = world.castRay(new RAPIER.Ray({ x, y: from, z }, { x: 0, y: -1, z: 0 }), 10, true, undefined, IGNORE_STEMS_AND_IGUANAS, undefined, player.body);
      return hit ? from - hit.timeOfImpact : null;
    },
    lizard: () => {
      const head = lizard.root.getObjectByName('head')!;
      const local = lizard.root.worldToLocal(head.getWorldPosition(new THREE.Vector3()));
      const { hips, chest, tail } = visual.fit ?? { hips: 0, chest: 0, tail: [0, 0, 0, 0] };
      const jaw = lizard.root.getObjectByName('jaw');
      return {
        clips: lizard.clipNames,
        current: lizard.current,
        head: { x: local.x, y: local.y, z: local.z },
        spine: { hips, chest, tail },
        biting: lizard.biting,
        // How far the jaw hangs open (radians).
        jawOpen: jaw ? 2 * Math.acos(Math.min(1, Math.abs(jaw.quaternion.dot(jawRest!)))) : 0,
        snout: { ...lizard.bodySpheres[0] },
      };
    },
    feet: () =>
      lizard.solePoints().map(({ leg, point }) => {
        // Look down from just above the foot, so a log or rock overhanging it doesn't count.
        const hit = world.castRay(new RAPIER.Ray({ x: point.x, y: point.y + 0.02, z: point.z }, { x: 0, y: -1, z: 0 }), 1, true, undefined, IGNORE_STEMS, undefined, player.body);
        return { leg, gap: hit ? hit.timeOfImpact - 0.02 : Infinity };
      }),
    clearance: () => visual.clearance.depths(),
    clearancePoints: () => visual.clearance.points().map((p) => lizard.root.worldToLocal(p)),
    player: () => {
      const f = player.feetAt(1, new THREE.Vector3());
      return {
        x: f.x,
        y: f.y,
        z: f.z,
        yaw: player.yaw,
        speed: player.horizontalSpeed,
        grounded: player.grounded,
        climbing: player.climbing,
        swimming: player.swimming,
        swimPitch: player.swimPitch,
        state: states.state,
      };
    },
    camera: () => ({ ...camera.position, yaw: followCam.yaw, pitch: followCam.pitch, arm: followCam.arm, distance: followCam.distance, faded: fade.faded }),
    setInput: (i, forSteps = 0) => {
      forcedInput = i;
      forcedSteps = forSteps;
    },
    viewFrom: (offset, at) => {
      viewOffset = offset && new THREE.Vector3(offset.x, offset.y, offset.z);
      viewTarget = at ? new THREE.Vector3(at.x, at.y, at.z) : null;
    },
    plants: (near) =>
      plants.all
        .filter((p) => !near || Math.hypot(p.x - near.x, p.z - near.z) < near.r)
        .map((p) => ({ kind: p.kind, x: p.x, y: p.y, z: p.z, height: p.height, tiltX: p.tx, tiltZ: p.tz, crush: p.crush, growth: p.growth })),
    sprout: (kind, x, z, grown) => plants.sprout(kind as PlantKind, x, z, grown) !== null,
    tortoise: () => ({ ...tortoise.position, state: tortoise.state, clip: tortoise.clip, along: tortoise.along, ahead: tortoise.ahead(0.3), route: { ...TORTOISE_ROUTE } }),
    tortoiseDo: (action) => tortoise.request(action),
    crabs: () =>
      crabs.list.map((c) => ({
        x: c.pos.x,
        y: c.pos.y,
        z: c.pos.z,
        yaw: c.yaw,
        state: c.state,
        clip: c.clip,
        onPile: c.home.pile,
        hops: c.hops,
        grooming: crabs.groomingWhom(c),
        dead: c.dead,
        gone: c.gone,
      })),
    crabClips: () => [...crabs.clips],
    iguanas: () =>
      iguanas.list.map((ig) => {
        const f = ig.body.feetAt(1, new THREE.Vector3());
        const meal = ig.meal;
        return {
          x: f.x,
          y: f.y,
          z: f.z,
          yaw: ig.body.yaw,
          home: { ...ig.home },
          activity: ig.activity,
          state: ig.states.state,
          clip: ig.model.current,
          grounded: ig.body.grounded,
          swimming: ig.body.swimming,
          sneezing: ig.sneezing,
          sneezes: ig.sneezes,
          bites: ig.bites,
          biting: ig.model.biting,
          meals: ig.meals,
          meal: meal && { id: meal.id, x: meal.x, y: meal.y, z: meal.z },
          touch: meal && ig.touch(meal),
          lava: lavaCover(f.x, f.z),
          hits: ig.hits,
          down: ig.down,
          gone: ig.gone,
          mate: ig.mate === player ? ('player' as const) : ig.mate ? iguanas.list.findIndex((o) => o.body === ig.mate) : null,
        };
      }),
    iguanaDo: (i, action) => {
      const ig = iguanas.list[i];
      if (action === 'feed') ig.feed();
      else if (action === 'move') ig.moveOn();
      else ig.sneeze();
    },
    iguanaPlace: (i, x, z, yaw, stay) => iguanas.list[i].place(x, z, yaw, stay),
    saltSpray: () => iguanas.spray.live,
    lava: lavaCover,
    crabGo: (i, x, z) => crabs.list[i].go(x, z),
    crabPlace: (i, x, z, y = 1) => crabs.list[i].place(x, y, z),
    ocean: () => ({ waterY: WATER_Y, depth: SEA_DEPTH }),
    shoreX,
    shelters: () => pileShelters().map((s) => ({ name: s.name, x: s.x, y: s.y, z: s.z, roofY: s.roofY, reach: s.reach })),
    rockPiles: () => ROCK_PILES.map((p) => ({ name: p.name, z: p.z, x0: shoreX(p.z) + p.from, x1: shoreX(p.z) + p.to, peak: p.peak })),
    algae: (near) =>
      (near ? algae.near(near.x, near.y, near.z, near.r) : algae.all()).map((p) => ({ id: p.id, kind: p.kind, x: p.x, y: p.y, z: p.z, grown: algae.grown(p.id) })),
    removeAlgae: (id) => algae.remove(id),
    bite: () => feeding.bite(),
    feeding: () => ({ bites: feeding.bites, mouthfuls: feeding.mouthfuls, lastBite: feeding.lastBite }),
    sproutAlgae: () => algae.sprout()?.id ?? null,
    ripples: () => water.ripples(),
    hawk: () => ({
      x: hawk.pos.x,
      y: hawk.pos.y,
      z: hawk.pos.z,
      speed: hawk.vel.length(),
      state: hawk.state,
      clip: hawk.clip,
      hunting: hawk.hunting,
      feeding: hawk.feeding,
      quarry: hawk.quarry && { kind: hawk.quarry.kind, index: hawk.quarry.index },
      scared: hawk.scared,
      seesPrey: hawk.seesPrey,
      strikes: hawk.strikes,
      hitsLanded: hawk.hitsLanded,
      perch: hawk.perchIndex,
      flushed: hawk.flushed,
      enabled: hawk.enabled,
    }),
    hawkClips: () => hawk.clipNames,
    hawkPerches: () => hawk.perchSpots.map((p) => ({ ...p })),
    hawkLowest: () => hawk.lowest(),
    hawkSit: (i) => hawk.sitAt(i),
    hawkDo: (action) => hawk.request(action),
    inSight: (from, x, y, z) => cover.inSight(new THREE.Vector3(from.x, from.y, from.z), { x, y, z }, player.body),
    lizardInView: (from) => hawk.inView(prey[0], new THREE.Vector3(from.x, from.y, from.z)),
    wounds: () => ({ hits: wounds.hits, down: wounds.down, countdown: wounds.countdown, hunted: wounds.hunted, flinching: lizard.flinching, puff: puff.live }),
    teleport: (x, z, yaw, y) => {
      player.setFeet(new THREE.Vector3(x, y ?? terrainHeight(x, z), z), yaw);
      followCam.yaw = yaw;
    },
  };
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
    const state = states.update(
      {
        grounded: player.grounded,
        jumped: player.jumped,
        landed: player.landed,
        verticalSpeed: player.velocity.y,
        horizontalSpeed: player.horizontalSpeed,
        climbing: player.climbing,
        swimming: player.swimming,
      },
      dt,
    );
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
      // Input is read once per frame, before the physics steps that frame owes.
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
