import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { IGNORE_STEMS, IGNORE_STEMS_AND_IGUANAS, terrainHeight } from '../world/terrain';
import { lavaCover, ROCK_PILES, TORTOISE_ROUTE } from '../world/layout';
import { SEA_DEPTH, shoreX, WATER_Y } from '../world/shore';
import { pileShelters } from '../world/rockPiles';
import type { Obstacle } from '../world/obstacles';
import type { Plants, PlantKind } from '../world/plants';
import type { Algae } from '../world/algae';
import type { Reef } from '../world/reef';
import type { Fishes } from '../creatures/fish';
import type { Water } from '../world/water';
import type { Cover } from '../world/cover';
import type { Tortoise } from '../creatures/tortoise';
import type { Crabs } from '../creatures/crab';
import type { Iguanas } from '../creatures/iguana';
import type { Hawk } from '../creatures/hawk';
import type { Quarry } from '../creatures/quarry';
import type { StrikePuff } from '../creatures/strikePuff';
import type { PlayerController } from '../player/controller';
import type { MovementStateMachine } from '../player/state';
import type { LizardModel } from '../player/lizardModel';
import type { LizardVisual } from '../player/visual';
import type { Feeding } from '../player/feeding';
import type { Wounds } from '../player/wounds';
import type { Vitals } from '../player/vitals';
import type { ClimateSense } from '../player/climate';
import type { Goals } from '../goals';
import type { FollowCamera } from '../camera/followCamera';
import type { OccluderFade } from '../camera/occluderFade';
import type { GameTestHooks } from './testHooks';

interface HookContext {
  world: RAPIER.World;
  obstacles: readonly Obstacle[];
  player: PlayerController;
  states: MovementStateMachine;
  lizard: LizardModel;
  visual: LizardVisual;
  camera: THREE.PerspectiveCamera;
  followCam: FollowCamera;
  fade: OccluderFade;
  plants: Plants;
  tortoise: Tortoise;
  crabs: Crabs;
  iguanas: Iguanas;
  algae: Algae;
  reef: Reef;
  fishes: Fishes;
  feeding: Feeding;
  water: Water;
  hawk: Hawk;
  cover: Cover;
  prey: Quarry[];
  wounds: Wounds;
  vitals: Vitals;
  climate: ClimateSense;
  puff: StrikePuff;
  goals: Goals;
  canEat: () => boolean;
  setInput: GameTestHooks['setInput'];
  viewFrom: GameTestHooks['viewFrom'];
}

/** Inspect game systems; mutable input and camera overrides stay owned by the game loop. */
export function createTestHooks({
  world, obstacles, player, states, lizard, visual, camera, followCam, fade, plants,
  tortoise, crabs, iguanas, algae, reef, fishes, feeding, water, hawk, cover, prey, wounds, vitals, climate, puff, goals, canEat,
  setInput, viewFrom,
}: HookContext): GameTestHooks {
  const jawRest = lizard.root.getObjectByName('jaw')?.quaternion.clone();
  return {
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
    setInput,
    viewFrom,
    plants: (near) =>
      (near ? plants.near(near.x, near.z, near.r) : plants.all)
        .filter((p) => !near || Math.hypot(p.x - near.x, p.z - near.z) < near.r)
        .map((p) => ({ kind: p.kind, solid: p.solid, x: p.x, y: p.y, z: p.z, height: p.height, tiltX: p.tx, tiltZ: p.tz, crush: p.crush, growth: p.growth })),
    clearPlants: (x0, z0, x1, z1, r) => {
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len2 = dx * dx + dz * dz || 1;
      const gone = plants.all.filter((p) => {
        const t = Math.max(0, Math.min(1, ((p.x - x0) * dx + (p.z - z0) * dz) / len2));
        return Math.hypot(p.x - x0 - dx * t, p.z - z0 - dz * t) < r;
      });
      for (const p of gone) plants.eat(p);
      return gone.length;
    },
    sprout: (kind, x, z, grown) => plants.sprout(kind as PlantKind, x, z, grown) !== null,
    tortoise: () => ({ ...tortoise.position, state: tortoise.state, ridden: tortoise.ridden, tramples: tortoise.tramples, clip: tortoise.clip, along: tortoise.along, ahead: tortoise.ahead(0.3), route: { ...TORTOISE_ROUTE } }),
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
    iguanaScare: (i, x, z) => {
      iguanas.list[i].scare(x, z, true);
    },
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
    feeding: () => ({ bites: feeding.bites, mouthfuls: feeding.mouthfuls, lastBite: feeding.lastBite, canEat: canEat() }),
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
      dodged: hawk.dodged,
      survived: hawk.survived,
      perch: hawk.perchIndex,
      flushed: hawk.flushed,
      enabled: hawk.enabled,
    }),
    hawkClips: () => hawk.clipNames,
    hawkPerches: () => hawk.perchSpots.map((p) => ({ ...p })),
    hawkLowest: () => hawk.lowest(),
    hawkSit: (i) => hawk.sitAt(i),
    hawkDo: (action) => hawk.request(action),
    pause: ({ iguanas: still = [], crabs: crabsStill = false }) => {
      iguanas.list.forEach((ig, i) => (ig.paused = still.includes(i)));
      crabs.paused = crabsStill;
    },
    corals: () => reef.corals.map((c) => ({ ...c })),
    fish: () =>
      fishes.list.map((f) => ({
        species: f.species,
        school: f.school.home.x.toFixed(3) + ',' + f.school.home.z.toFixed(3),
        x: f.pos.x,
        y: f.pos.y,
        z: f.pos.z,
        speed: f.vel.length(),
        length: f.length,
        bottom: terrainHeight(f.pos.x, f.pos.z),
        darting: f.panic > 0,
      })),
    fishTouched: () => fishes.touched,
    inSight: (from, x, y, z) => cover.inSight(new THREE.Vector3(from.x, from.y, from.z), { x, y, z }, player.body),
    lizardInView: (from) => hawk.inView(prey[0], new THREE.Vector3(from.x, from.y, from.z)),
    vitals: () => ({
      health: vitals.health,
      warmth: vitals.warmth,
      fullness: vitals.fullness,
      air: vitals.air,
      rate: { ...vitals.rate },
      speedScale: vitals.speedScale,
      frozen: vitals.frozen,
      groomed: crabs.groomingPlayer,
      climate: { ...climate.now },
    }),
    setVitals: (v) => Object.assign(vitals, v),
    goals: () => goals.list.map((g) => ({ ...g })),
    completeGoal: (id) => {
      const goal = goals.list.find((g) => g.id === id);
      if (!goal || goal.done) return false;
      goals.complete(goal);
      return true;
    },
    wounds: () => ({ hits: wounds.hits, down: wounds.down, downBy: wounds.downBy, countdown: wounds.countdown, hunted: wounds.hunted, flinching: lizard.flinching, puff: puff.live }),
    teleport: (x, z, yaw, y) => {
      player.setFeet(new THREE.Vector3(x, y ?? terrainHeight(x, z), z), yaw);
      followCam.yaw = yaw;
    },
  };
}
