import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { IGNORE_STEMS_AND_IGUANAS, terrainHeight } from '../world/terrain';
import type { Obstacle } from '../world/obstacles';
import type { PlayerController } from '../player/controller';
import type { MovementStateMachine } from '../player/state';
import type { FollowCamera } from '../camera/followCamera';
import type { OccluderFade } from '../camera/occluderFade';
import type { DunesTestHooks } from './testHooks';
import type { Bushes } from '../dunes/bushes';
import { coil, type Racers } from '../dunes/racers';
import type { Hatchlings } from '../dunes/hatchlings';
import type { DuneRun } from '../dunes/run';
import { BURROWS, COLONY, NEST } from '../dunes/layout';
import { coverAt } from '../dunes/prey';

interface DunesHookContext {
  world: RAPIER.World;
  obstacles: readonly Obstacle[];
  player: PlayerController;
  states: MovementStateMachine;
  camera: THREE.PerspectiveCamera;
  followCam: FollowCamera;
  fade: OccluderFade;
  bushes: Bushes;
  racers: Racers;
  hatchlings: Hatchlings;
  run: DuneRun;
  setInput: DunesTestHooks['setInput'];
  viewFrom: DunesTestHooks['viewFrom'];
}

/** The nesting dunes' test hooks (`window.__dunes`); the dunes' main owns input and view overrides. */
export function createDunesHooks(ctx: DunesHookContext): DunesTestHooks {
  const { world, obstacles, player, states, camera, followCam, fade, bushes, racers, hatchlings, run, setInput, viewFrom } = ctx;
  const xyz = (v: THREE.Vector3) => ({ x: v.x, y: v.y, z: v.z });
  const pick = (sel: boolean | number[] | undefined, i: number) => (sel === undefined ? null : Array.isArray(sel) ? !sel.includes(i) : sel);
  return {
    ready: false,
    advance: () => {},
    frame: () => {},
    physicsSteps: 0,
    terrainHeight,
    groundAt: (x, z, from = 5) => {
      const hit = world.castRay(new RAPIER.Ray({ x, y: from, z }, { x: 0, y: -1, z: 0 }), 10, true, undefined, IGNORE_STEMS_AND_IGUANAS, undefined, player.body);
      return hit ? from - hit.timeOfImpact : null;
    },
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
    setInput,
    viewFrom,
    teleport: (x, z, yaw, y) => {
      player.setFeet(new THREE.Vector3(x, y ?? terrainHeight(x, z), z), yaw);
      followCam.yaw = yaw;
    },
    racers: () =>
      racers.list.map((r) => ({
        state: r.state,
        ...xyz(r.neck),
        course: r.course,
        speed: r.speed,
        lift: r.body.lift,
        prey: r.prey?.id ?? null,
        home: { x: r.home.x, z: r.home.z },
        strikes: r.strikes,
        catches: r.catches,
        chases: r.chases,
        giveUps: r.giveUps,
        paused: r.paused,
        trail: r.body.trailLength,
        length: r.body.length,
      })),
    racerBody: (i) => {
      const b = racers.list[i].body;
      b.root.updateMatrixWorld(true);
      const bones: { x: number; y: number; z: number }[] = [];
      for (let k = 1; k < b.joints.length; k++) bones.push(xyz(b.root.getObjectByName(`spine_${k}`)!.getWorldPosition(new THREE.Vector3())));
      return { joints: b.joints.map(xyz), arcs: [...b.arcs], bones };
    },
    placeRacer: (i, x, z, yaw) => {
      const r = racers.list[i];
      const home = r.home as { x: number; z: number; yaw: number };
      Object.assign(home, { x, z, yaw });
      coil(r, x, z, yaw);
      r.state = 'lurk';
      r.prey = null;
      r.notice = 0;
      r.timer = 0;
      r.speed = 0;
      r.body.pose();
    },
    pause: ({ racers: rs, hatchlings: hs }) => {
      racers.list.forEach((r, i) => {
        const p = pick(rs, i);
        if (p !== null) r.paused = p;
      });
      hatchlings.list.forEach((h, i) => {
        const p = pick(hs, i);
        if (p !== null) h.paused = p;
      });
    },
    hatchlings: () =>
      hatchlings.list.map((h) => ({ phase: h.phase, ...xyz(h.body.feetAt(1, new THREE.Vector3())), made: h.made, caught: h.caughtTimes, paused: h.paused })),
    placeHatchling: (i, x, z, yaw) => {
      const h = hatchlings.list[i];
      h.wakeIn(h.burrow, 0);
      h.body.setFeet(new THREE.Vector3(x, terrainHeight(x, z), z), yaw);
      h.phase = 'run';
      h.timer = 5;
    },
    run: () => {
      const f = player.feetAt(1, new THREE.Vector3());
      return {
        state: run.state,
        time: run.time,
        best: run.best,
        attempts: run.attempts,
        catches: run.catches,
        finishes: run.finishes,
        danger: run.danger,
        inCover: coverAt(bushes, f.x, f.z),
        goals: run.goals.list.map((g) => ({ ...g })),
      };
    },
    restart: () => run.restart(),
    bushes: () => {
      const faded = new Set(bushes.faded);
      return bushes.list.map((b) => ({ name: b.name, x: b.x, y: b.y, z: b.z, radius: b.radius, height: b.height, faded: faded.has(b.name) }));
    },
    burrows: () => BURROWS.map((b) => ({ x: b.x, z: b.z, yaw: b.yaw })),
    marks: () => ({ start: { ...NEST }, finish: { ...COLONY } }),
  };
}
