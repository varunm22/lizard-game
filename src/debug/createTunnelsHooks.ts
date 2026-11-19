import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { IGNORE_STEMS_AND_IGUANAS, terrainHeight } from '../world/terrain';
import type { PlayerController } from '../player/controller';
import type { MovementStateMachine } from '../player/state';
import type { FollowCamera } from '../camera/followCamera';
import type { OccluderFade } from '../camera/occluderFade';
import type { TunnelsTestHooks } from './testHooks';
import type { TunnelsRun } from '../tunnels/run';
import type { Owls } from '../tunnels/owl';
import type { Sharks } from '../tunnels/sharks';
import type { RockSection } from '../tunnels/section';
import { FINISH, floorOpen, FLOORS, HOLES, ISLET, lightAt, POOLS, RAMPS, ROOSTS, SKYLIGHTS, START, STEPS, TOP } from '../tunnels/layout';

interface TunnelsHookContext {
  world: RAPIER.World;
  player: PlayerController;
  states: MovementStateMachine;
  camera: THREE.PerspectiveCamera;
  followCam: FollowCamera;
  fade: OccluderFade;
  run: TunnelsRun;
  owls: Owls;
  sharks: Sharks;
  section: RockSection;
  setInput: TunnelsTestHooks['setInput'];
  viewFrom: TunnelsTestHooks['viewFrom'];
}

/** The lava tunnels' test hooks (`window.__tunnels`); the tunnels' main owns input and view overrides. */
export function createTunnelsHooks(ctx: TunnelsHookContext): TunnelsTestHooks {
  const { world, player, states, camera, followCam, fade, run, owls, sharks, section, setInput, viewFrom } = ctx;
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
    floorOpen,
    cameraClear: () => {
      // Along the line from the camera to the point it looks at: anything drawn in between is in
      // the way. Rock the section cuts away isn't drawn, so the line carries on past it.
      const t = followCam.target;
      const d = new THREE.Vector3().subVectors(t, camera.position);
      const length = d.length();
      d.divideScalar(length);
      const from = camera.position.clone();
      let left = length;
      for (let i = 0; i < 64 && left > 0; i++) {
        const hit = world.castRay(new RAPIER.Ray(from, d), left, false, undefined, IGNORE_STEMS_AND_IGUANAS, undefined, player.body);
        if (!hit) return true;
        const at = from.clone().addScaledVector(d, hit.timeOfImpact);
        if (!section.cuts(at, camera)) return false;
        const skip = hit.timeOfImpact + 0.002;
        from.addScaledVector(d, skip);
        left -= skip;
      }
      return true;
    },
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
      // Back on their ledges, not hearing the lizard land wherever it's put.
      owls.callOff();
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
      catches: run.catches,
      checkpoint: { ...run.checkpoint },
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
      roosts: ROOSTS.map((r) => ({ ...r })),
      islet: { ...ISLET },
    }),
    owls: () =>
      owls.list.map((o) => ({ name: o.roost.name, state: o.state, x: o.at.x, y: o.at.y, z: o.at.z, under: { ...o.under } })),
    sharks: () => sharks.list.map((s) => ({ state: s.state, x: s.at.x, y: s.at.y, z: s.at.z })),
    light: (x, y, z) => ({ ...lightAt(x, y, z, { sun: 0, glow: 0 }) }),
  };
}
