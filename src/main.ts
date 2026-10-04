import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FIXED_DT, startLoop } from './loop';
import { createScene, followSun } from './render/scene';
import { buildTerrain, IGNORE_STEMS, terrainHeight } from './world/terrain';
import { buildObstacles, covers } from './world/obstacles';
import { buildProps } from './world/props';
import { Algae } from './world/algae';
import { SPAWN, TORTOISE_ROUTE } from './world/layout';
import { SEA_DEPTH, shoreX, updateUnderwaterView, WATER_Y } from './world/shore';
import { Water } from './world/water';
import { Splashes } from './world/splashes';
import { Plants, type PlantKind } from './world/plants';
import { Route, Regrowth } from './creatures/route';
import { Tortoise } from './creatures/tortoise';
import { Input, type InputState } from './input';
import { PlayerController } from './player/controller';
import { MovementStateMachine } from './player/state';
import { LizardModel } from './player/lizardModel';
import { LizardVisual } from './player/visual';
import { FollowCamera } from './camera/followCamera';
import { OccluderFade } from './camera/occluderFade';
import { createHud } from './hud';
import type { GameTestHooks } from './debug/testHooks';
import lizardUrl from './assets/lizard.glb?url';
import plantsUrl from './assets/plants.glb?url';
import propsUrl from './assets/props.glb?url';
import tortoiseUrl from './assets/tortoise.glb?url';

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

  const player = new PlayerController(world, new THREE.Vector3(SPAWN.x, terrainHeight(SPAWN.x, SPAWN.z), SPAWN.z));
  player.setFeet(player.feetAt(1, new THREE.Vector3()), SPAWN.yaw);
  const states = new MovementStateMachine();

  const lizard = await LizardModel.load(lizardUrl);
  scene.add(lizard.root);
  const visual = new LizardVisual(lizard, player, world);

  const fade = new OccluderFade(world, obstacles);
  const followCam = new FollowCamera(camera, world, player.body, fade.handles);
  followCam.yaw = SPAWN.yaw;

  const input = new Input(renderer.domElement);
  const hud = createHud();
  // Tests can override the live input; null hands control back to the keyboard and gamepad.
  let forcedInput: Partial<InputState> | null = null;
  let forcedSteps = 0;
  let frameInput: InputState = input.read(0);
  let lastState = states.state;
  const feet = new THREE.Vector3();
  let viewOffset: THREE.Vector3 | null = null;
  const groundedFeet = new THREE.Vector3();
  const tickFeet = new THREE.Vector3();
  const cameraPusher = { x: 0, y: 0, z: 0, r: 0.04 };
  const pushers = [...lizard.bodySpheres, cameraPusher];

  const hooks: GameTestHooks = {
    ready: false,
    advance: () => {},
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
    groundAt: (x, z) => {
      const hit = world.castRay(new RAPIER.Ray({ x, y: 5, z }, { x: 0, y: -1, z: 0 }), 10, true, undefined, IGNORE_STEMS, undefined, player.body);
      return hit ? 5 - hit.timeOfImpact : null;
    },
    lizard: () => {
      const head = lizard.root.getObjectByName('head')!;
      const local = lizard.root.worldToLocal(head.getWorldPosition(new THREE.Vector3()));
      const { hips, chest, tail } = visual.fit ?? { hips: 0, chest: 0, tail: [0, 0, 0, 0] };
      return { clips: lizard.clipNames, current: lizard.current, head: { x: local.x, y: local.y, z: local.z }, spine: { hips, chest, tail } };
    },
    feet: () =>
      lizard.solePoints().map(({ leg, point }) => {
        // Look down from just above the foot, so a log or rock overhanging it doesn't count.
        const hit = world.castRay(new RAPIER.Ray({ x: point.x, y: point.y + 0.02, z: point.z }, { x: 0, y: -1, z: 0 }), 1, true, undefined, IGNORE_STEMS, undefined, player.body);
        return { leg, gap: hit ? hit.timeOfImpact - 0.02 : Infinity };
      }),
    clearance: () => visual.clearance.depths(),
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
    viewFrom: (offset) => {
      viewOffset = offset && new THREE.Vector3(offset.x, offset.y, offset.z);
    },
    plants: (near) =>
      plants.all
        .filter((p) => !near || Math.hypot(p.x - near.x, p.z - near.z) < near.r)
        .map((p) => ({ kind: p.kind, x: p.x, y: p.y, z: p.z, height: p.height, tiltX: p.tx, tiltZ: p.tz, crush: p.crush, growth: p.growth })),
    sprout: (kind, x, z, grown) => plants.sprout(kind as PlantKind, x, z, grown) !== null,
    tortoise: () => ({ ...tortoise.position, state: tortoise.state, clip: tortoise.clip, along: tortoise.along, ahead: tortoise.ahead(0.3), route: { ...TORTOISE_ROUTE } }),
    tortoiseDo: (action) => tortoise.request(action),
    ocean: () => ({ waterY: WATER_Y, depth: SEA_DEPTH }),
    shoreX,
    algae: (near) =>
      (near ? algae.near(near.x, near.y, near.z, near.r) : algae.all()).map((p) => ({ id: p.id, kind: p.kind, x: p.x, y: p.y, z: p.z })),
    removeAlgae: (id) => algae.remove(id),
    ripples: () => water.ripples(),
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
    player.step(dt, forcedInput ? { ...frameInput, ...forcedInput } : frameInput);
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
  };
  const updateViews = (alpha: number, frameDt: number) => {
    visual.update(states.state, alpha, frameDt);
    player.feetAt(alpha, feet);
    const steering = player.bodyTurning || player.horizontalSpeed > 0.02;
    // Swimming, the camera follows the lizard up and down as if it were on the ground.
    const groundedFeetY = player.grounded || player.swimming ? player.feetAt(1, groundedFeet).y : null;
    followCam.update(feet, groundedFeetY, player.yawAt(alpha), steering, frameDt);
    if (viewOffset) {
      camera.position.copy(feet).add(viewOffset);
      camera.lookAt(feet);
    }
    fade.update(camera.position, followCam.target, player.yawAt(alpha), frameDt);
    // Plants part for the lizard's body, and for the camera so tall stems don't fill the view.
    lizard.updateBodySpheres();
    Object.assign(cameraPusher, { x: camera.position.x, y: camera.position.y, z: camera.position.z });
    tortoise.update(alpha, frameDt);
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
}

main();
