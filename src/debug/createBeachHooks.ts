import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { IGNORE_STEMS_AND_IGUANAS, terrainHeight } from '../world/terrain';
import type { Obstacle } from '../world/obstacles';
import type { PlayerController } from '../player/controller';
import type { MovementStateMachine } from '../player/state';
import type { FollowCamera } from '../camera/followCamera';
import type { OccluderFade } from '../camera/occluderFade';
import type { Vitals } from '../player/vitals';
import type { Wounds } from '../player/wounds';
import type { BeachTestHooks } from './testHooks';
import type { BeachRun } from '../beach/run';
import type { SeaLions } from '../beach/sealions';
import type { Rivals } from '../beach/rivals';
import type { Birds } from '../beach/birds';
import { depthAt, DISPLAY_ROCKS, onBullStretch, shoreZ, START, SWIM_LOOPS } from '../beach/layout';

interface BeachHookContext {
  world: RAPIER.World;
  obstacles: readonly Obstacle[];
  player: PlayerController;
  states: MovementStateMachine;
  camera: THREE.PerspectiveCamera;
  followCam: FollowCamera;
  fade: OccluderFade;
  run: BeachRun;
  sealions: SeaLions;
  rivals: Rivals;
  birds: Birds;
  vitals: Vitals;
  wounds: Wounds;
  display: () => void;
  playerDisplay: () => number;
  setInput: BeachTestHooks['setInput'];
  viewFrom: BeachTestHooks['viewFrom'];
}

/** The sea lion beach's test hooks (`window.__beach`); the beach's main owns input and view overrides. */
export function createBeachHooks(ctx: BeachHookContext): BeachTestHooks {
  const { world, obstacles, player, states, camera, followCam, fade, run, sealions, rivals, birds, vitals, wounds, setInput, viewFrom } = ctx;
  const v = new THREE.Vector3();
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
    run: () => ({
      state: run.state,
      time: run.time,
      best: run.best,
      attempts: run.attempts,
      catches: run.catches,
      finishes: run.finishes,
      ashore: run.ashore && { x: run.ashore.x, z: run.ashore.z },
      danger: run.danger,
      held: run.held,
      goals: run.goals.list.map((g) => ({ ...g })),
      objective: run.objective,
    }),
    restart: () => run.restart(),
    sealions: () => {
      const b = sealions.bull;
      const nose = b.nose(v);
      return {
        bull: { state: sealions.bullState, x: b.pos.x, y: b.pos.y, z: b.pos.z, yaw: b.yaw, nose: { x: nose.x, z: nose.z }, swim: b.body.swim, dodged: sealions.dodged, hits: sealions.hits, quarry: sealions.quarry, routs: sealions.routs },
        cows: sealions.cows.map((c, i) => ({
          x: c.pos.x,
          z: c.pos.z,
          yaw: c.yaw,
          lift: c.body.lift,
          gaps: c.colliders
            .map((k) => {
              // The capsule's lower end: its axis lies along its local Y.
              const t = k.translation();
              const r = k.rotation();
              const axis = v.set(0, k.halfHeight(), 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
              const end = axis.y < 0 ? 1 : -1;
              const x = t.x + end * axis.x;
              const z = t.z + end * axis.z;
              return t.y - Math.abs(axis.y) - k.radius() - terrainHeight(x, z);
            })
            .reverse(),
          alarm: sealions.alarm[i],
        })),
        pups: sealions.pups.map((p) => ({ state: p.state, x: p.lion.pos.x, z: p.lion.pos.z, yaw: p.lion.yaw, mother: p.mother })),
        nudges: sealions.nudges,
      };
    },
    bullBones: () => {
      const root = sealions.bull.body.root;
      root.updateMatrixWorld(true);
      const bones: Record<string, { x: number; y: number; z: number }> = {};
      root.traverse((o) => {
        if ((o as THREE.Bone).isBone) {
          const p = o.getWorldPosition(new THREE.Vector3());
          bones[o.name] = { x: p.x, y: p.y, z: p.z };
        }
      });
      return bones;
    },
    placeBull: (x, z, yaw, state = 'patrol') => sealions.placeBull(x, z, yaw, state),
    rivals: () => ({
      males: rivals.rivals.map((r) => ({
        state: r.state,
        rock: r.rock,
        x: r.npc.feet.x,
        y: r.npc.feet.y,
        z: r.npc.feet.z,
        yaw: r.npc.body.yaw,
        exchanges: r.exchanges,
        displaying: r.npc.displaying,
        challenging: r.challenging,
      })),
      owner: [...rivals.owner],
      match: rivals.match && { rival: rivals.rivals.indexOf(rivals.match.rival), push: rivals.match.push, t: rivals.match.t },
      females: rivals.females.map((f) => ({ state: f.state, x: f.npc.feet.x, z: f.npc.feet.z })),
      claiming: rivals.claiming && { ...rivals.claiming },
      outDisplayed: rivals.outDisplayed,
      shoveWins: rivals.shoveWins,
      shoveLosses: rivals.shoveLosses,
      claims: rivals.claims,
      defended: rivals.defended,
      courtship: rivals.courtship,
      chosen: rivals.chosen,
      playerDisplay: ctx.playerDisplay(),
    }),
    display: () => ctx.display(),
    rivalTo: (i, state) => (state === 'routed' ? rivals.rout(i) : rivals.send(i, state)),
    placeRival: (i, x, z, yaw) => {
      const n = rivals.rivals[i].npc;
      n.body.setFeet(v.set(x, terrainHeight(x, z) + 0.005, z), yaw);
      n.body.feetAt(1, n.feet);
    },
    sheltered: (x, z) => sealions.sheltered(x, z),
    displayRocks: () => DISPLAY_ROCKS.map((d) => ({ x: d.x, z: d.z, r: d.r, top: terrainHeight(d.x, d.z) + d.top })),
    birds: () => [
      ...birds.penguins.map((b) => ({ kind: 'penguin', x: b.pos.x, y: b.pos.y, z: b.pos.z, swim: b.swim })),
      ...birds.cormorants.map((b) => ({ kind: 'cormorant', x: b.pos.x, y: b.pos.y, z: b.pos.z, swim: b.swim })),
    ],
    birdTrips: () => birds.trips.map((t) => ({ kind: t.species, state: t.state, under: t.bird.under, x: t.bird.pos.x, y: t.bird.pos.y, z: t.bird.pos.z, solid: t.bird.solid.colliders.map((c) => { const p = c.translation(); return Math.hypot(p.x - t.bird.pos.x, p.y - t.bird.pos.y, p.z - t.bird.pos.z); }) })),
    swimLoops: () => SWIM_LOOPS.map((l) => ({ ...l })),
    birdGoals: () => ({ penguin: birds.nearPenguin, cormorant: birds.nearCormorant }),
    vitals: () => ({ health: vitals.health, warmth: vitals.warmth, fullness: vitals.fullness, air: vitals.air, down: wounds.down, downBy: wounds.downBy }),
    setVitals: (s) => Object.assign(vitals, s),
    pause: ({ sealions: s, rivals: r }) => {
      if (s !== undefined) sealions.paused = s;
      if (r !== undefined) rivals.paused = r;
    },
    start: () => ({ ...START }),
    shoreZ: (x) => shoreZ(x),
    onBullStretch: (x, z) => onBullStretch(x, z),
    depth: (x, z) => depthAt(x, z),
  };
}
