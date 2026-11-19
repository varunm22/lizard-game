import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { IGNORE_STEMS_AND_IGUANAS, terrainHeight } from '../world/terrain';
import type { Obstacle } from '../world/obstacles';
import type { PlayerController } from '../player/controller';
import type { MovementStateMachine } from '../player/state';
import type { FollowCamera } from '../camera/followCamera';
import type { OccluderFade } from '../camera/occluderFade';
import type { LagoonTestHooks } from './testHooks';
import type { Herons } from '../lagoon/herons';
import type { DriftLog } from '../lagoon/driftLog';
import type { Wrack } from '../lagoon/wrack';
import type { Swimmers } from '../lagoon/swimmers';
import type { Fries } from '../lagoon/fry';
import type { LagoonRun } from '../lagoon/run';
import type { Mangrove } from '../lagoon/props';
import type { Vitals } from '../player/vitals';
import type { Wounds } from '../player/wounds';
import type { Feeding } from '../player/feeding';
import type { Algae } from '../world/algae';
import { channelHalf, channelX, CREEK, CREEK_FLOW, current, DAM, depthAt, FINISH, JAM, LOG_POOL, SAFE_POINTS, SNAG, START } from '../lagoon/layout';

interface LagoonHookContext {
  world: RAPIER.World;
  obstacles: readonly Obstacle[];
  mangroves: readonly Mangrove[];
  player: PlayerController;
  states: MovementStateMachine;
  camera: THREE.PerspectiveCamera;
  followCam: FollowCamera;
  fade: OccluderFade;
  herons: Herons;
  log: DriftLog;
  wrack: Wrack;
  swimmers: Swimmers;
  fries: Fries;
  run: LagoonRun;
  vitals: Vitals;
  wounds: Wounds;
  algae: Algae;
  feeding: Feeding;
  canEat: () => boolean;
  setInput: LagoonTestHooks['setInput'];
  viewFrom: LagoonTestHooks['viewFrom'];
}

/** The mangrove lagoon's test hooks (`window.__lagoon`); the lagoon's main owns input and view overrides. */
export function createLagoonHooks(ctx: LagoonHookContext): LagoonTestHooks {
  const { world, obstacles, mangroves, player, states, camera, followCam, fade, herons, log, wrack, swimmers, fries, run, vitals, wounds, algae, feeding, canEat, setInput, viewFrom } = ctx;
  const xyz = (v: THREE.Vector3) => ({ x: v.x, y: v.y, z: v.z });
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
    herons: () =>
      herons.list.map((h) => ({
        state: h.state,
        ...xyz(h.pos),
        yaw: h.yaw,
        bill: xyz(h.billTip(new THREE.Vector3())),
        sees: h.sees,
        unseen: h.unseen,
        alert: h.alert,
        strikes: h.strikes,
        catches: h.catches,
        paused: h.paused,
      })),
    heronBody: (i) => {
      const h = herons.list[i];
      h.body.root.updateMatrixWorld(true);
      const bones: Record<string, { x: number; y: number; z: number }> = {};
      h.body.root.traverse((o) => {
        if ((o as THREE.Bone).isBone) bones[o.name] = xyz(o.getWorldPosition(new THREE.Vector3()));
      });
      return { bones, feet: h.body.feet.map(xyz) };
    },
    placeHeron: (i, x, z, yaw) => {
      const h = herons.list[i];
      const spots = h.spots as { x: number; z: number; yaw: number }[];
      Object.assign(spots[h.spot], { x, z, yaw });
      h.stand(x, herons.groundAt(x, z), z, yaw);
      h.state = 'wait';
      h.timer = 60;
      h.seen = 0;
      h.cool = 0;
      h.update(1);
    },
    tangle: (x, z) => herons.inTangle(x, z),
    vitals: () => ({
      health: vitals.health,
      warmth: vitals.warmth,
      fullness: vitals.fullness,
      air: vitals.air,
      rate: { ...vitals.rate },
      speedScale: vitals.speedScale,
      frozen: vitals.frozen,
      cause: vitals.cause,
      down: wounds.down,
      downBy: wounds.downBy,
    }),
    setVitals: (v) => Object.assign(vitals, v),
    fry: () => fries.list.map((f) => ({ shoal: fries.shoals.indexOf(f.shoal), species: f.shoal.species, ...xyz(f.pos), speed: Math.hypot(f.vel.x, f.vel.z) })),
    fryShoals: () => fries.shoals.map((s) => ({ species: s.species, x: s.home.x, z: s.home.z, roots: s.posts.map((p) => ({ ...p })) })),
    fryDarts: () => fries.darts,
    algae: () => algae.all().map((p) => ({ id: p.id, kind: p.kind, x: p.x, y: p.y, z: p.z, grown: algae.grown(p.id) })),
    bite: () => feeding.bite(),
    feeding: () => ({ bites: feeding.bites, mouthfuls: feeding.mouthfuls, canEat: canEat() }),
    wadeable: (x, z) => herons.wadeable(x, z, x, z),
    haunts: (i) => herons.list[i].spots.map((p) => ({ ...p })),
    pause: ({ herons: hs, swimmers: ss }) => {
      if (hs !== undefined) herons.list.forEach((h, i) => (h.paused = Array.isArray(hs) ? !hs.includes(i) : hs));
      if (ss !== undefined) swimmers.paused = ss;
    },
    log: () => ({
      state: log.state,
      ...xyz(log.pos),
      heading: log.heading,
      speed: log.speed,
      inChannel: log.inChannel,
      pushes: log.pushes,
      reachedChannel: log.reachedChannel,
      lost: log.lost,
      ridden: log.ridden,
      rider: log.rider,
      hooked: log.hooked,
      roll: log.roll,
      keelDepth: log.keelDepth,
      touching: log.touching,
      contacts: log.contacts.map((c) => ({ ...c })),
      ends: [xyz(log.end(-1, new THREE.Vector3())), xyz(log.end(1, new THREE.Vector3()))],
      spine: log.spine().map(xyz),
    }),
    wrack: () => ({
      open: CREEK_FLOW.open,
      racked: wrack.racked,
      pieces: wrack.pieces.map((w) => ({ kind: w.kind, state: w.state, ...xyz(w.pos) })),
    }),
    rackWrack: () => wrack.rackAll(),
    pushWrack: (i, x, z) => {
      const w = wrack.pieces[i];
      w.vel.x = x;
      w.vel.z = z;
    },
    logPoint: (x, y, z) => xyz(log.toWorld(x, y, z, new THREE.Vector3())),
    placeLog: (x, z, heading, roll = 0) => log.place(x, z, heading, roll),
    swimmers: () => swimmers.list.map((s) => ({ kind: s.kind, state: s.state, pool: s.pool, ...xyz(s.pos), top: swimmers.top(s), yaw: s.yaw, speed: s.speed, bites: s.bites })),
    placeSwimmer: (i, x, z, yaw) => swimmers.place(i, x, z, yaw),
    channel: (z) => ({ x: channelX(z), half: channelHalf(z) }),
    current: (x, z) => current(x, z, { x: 0, z: 0 }),
    depth: (x, z) => depthAt(x, z),
    run: () => ({
      state: run.state,
      time: run.time,
      best: run.best,
      attempts: run.attempts,
      catches: run.catches,
      finishes: run.finishes,
      checkpoint: run.checkpoint,
      safe: run.safe,
      danger: run.danger,
      goals: run.goals.list.map((g) => ({ ...g })),
    }),
    restart: () => run.restart(),
    mangroves: () => mangroves.map((m) => ({ name: m.name, x: m.x, z: m.z, reach: m.reach, sapling: m.sapling })),
    marks: () => ({
      start: { ...START },
      safe: SAFE_POINTS.map((p) => ({ ...p })),
      finish: { ...FINISH },
      pool: { x: LOG_POOL.x, z: LOG_POOL.z, r: LOG_POOL.r },
      creek: { z: CREEK.z, half: CREEK.half },
      jam: { ...JAM },
      dam: { ...DAM },
      snag: { x: SNAG.x, z: SNAG.z },
    }),
  };
}
