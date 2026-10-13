import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { IGNORE_STEMS_AND_IGUANAS, terrainHeight } from '../world/terrain';
import type { PlayerController } from '../player/controller';
import type { MovementStateMachine } from '../player/state';
import type { FollowCamera } from '../camera/followCamera';
import type { OccluderFade } from '../camera/occluderFade';
import type { TunnelsTestHooks } from './testHooks';
import type { TunnelsRun } from '../tunnels/run';
import { FINISH, FLOORS, HOLES, lightAt, POOLS, RAMPS, SKYLIGHTS, START, STEPS, TOP } from '../tunnels/layout';

interface TunnelsHookContext {
  world: RAPIER.World;
  player: PlayerController;
  states: MovementStateMachine;
  camera: THREE.PerspectiveCamera;
  followCam: FollowCamera;
  fade: OccluderFade;
  run: TunnelsRun;
  setInput: TunnelsTestHooks['setInput'];
  viewFrom: TunnelsTestHooks['viewFrom'];
}

/** The lava tunnels' test hooks (`window.__tunnels`); the tunnels' main owns input and view overrides. */
export function createTunnelsHooks(ctx: TunnelsHookContext): TunnelsTestHooks {
  const { world, player, states, camera, followCam, fade, run, setInput, viewFrom } = ctx;
  const down = (x: number, z: number, from: number) => {
    const hit = world.castRay(new RAPIER.Ray({ x, y: from, z }, { x: 0, y: -1, z: 0 }), 10, true, undefined, IGNORE_STEMS_AND_IGUANAS, undefined, player.body);
    return hit ? from - hit.timeOfImpact : null;
  };
  return {
    ready: false,
    advance: () => {},
    frame: () => {},
    physicsSteps: 0,
    terrainHeight,
    groundAt: (x, z, from = 5) => down(x, z, from),
    floorBelow: (x, z, from) => down(x, z, from),
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
    run: () => ({
      state: run.state,
      time: run.time,
      best: run.best,
      attempts: run.attempts,
      finishes: run.finishes,
      drops: [...run.drops],
      climbs: run.climbs,
      leaps: run.leaps,
      swam: run.swam,
      basked: [...run.basked],
      goals: run.goals.list.map((g) => ({ ...g })),
    }),
    restart: () => run.restart(),
    layout: () => ({
      floors: [...FLOORS],
      top: TOP,
      start: { ...START },
      finish: { ...FINISH },
      holes: HOLES.map((h) => ({ ...h })),
      ramps: RAMPS.map((r) => ({ ...r })),
      steps: { ...STEPS },
      skylights: SKYLIGHTS.map((s) => ({ ...s })),
      pools: POOLS.map((p) => ({ ...p })),
    }),
    light: (x, y, z) => ({ ...lightAt(x, y, z, { sun: 0, glow: 0 }) }),
  };
}
