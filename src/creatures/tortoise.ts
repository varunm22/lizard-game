import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { createAnimationActions } from '../render/animationActions';
import { loadGltf } from '../render/gltf';
import { toonify } from '../render/toon';
import { rng } from '../world/noise';
import { terrainHeight } from '../world/terrain';
import { registerExactSurface, setDrawnPose } from '../world/exactSurface';
import type { Plant, PlantKind, Plants } from '../world/plants';
import { covers, type Obstacle } from '../world/obstacles';
import { shoreDistance } from '../world/layout';
import { TERRAIN_SIZE } from '../world/terrain';
import { overCrack, crackSide } from '../island/crack';
import type { Fig, Figs } from '../island/figs';
import type { PlayerController } from '../player/controller';
import { centreAboveFeet } from '../player/movement';
import type { Route } from './route';

/**
 * A Galapagos giant tortoise (assets-src/tortoise.py) that grazes its meadow all day: it ambles from
 * one spot in it to another, picked at random, pressing the plants under it flat; it heads for food
 * it notices, liking figs best, then flowers, then grass; now and then it lies down for a rest. A
 * fig it will walk well out of its way for (`FIG_SENSE`), off its meadow and down the trail if that's
 * where the fig is; a flower only nearby; grass only when it hasn't eaten for a while and the grass
 * is right at its mouth. It steers round rocks, trees and logs, and keeps off the crack and the sea.
 * It takes no notice of the lizard. Its shell is solid (a kinematic body, so the lizard can stand on
 * it), and if it walks into the lizard it shoves it aside; if the lizard can't go anywhere, the
 * tortoise waits.
 */
export type TortoiseState = 'walk' | 'eat' | 'lie_down' | 'rest' | 'get_up';

/** How far ahead of its centre the mouth meets the ground when it reaches down to eat (m). */
export const MOUTH_AHEAD = 0.16;
/** A plant this close to that spot (m) and at least half grown can be eaten; a fig, which it noses for, a little further. */
const BITE_REACH = 0.035;
const FIG_REACH = 0.045;
/**
 * What it notices, and how long after a meal (s) before it wants each: a fig this far from its centre
 * (m), a flower this far from its mouth, and grass only once it's hungry and the grass is right at
 * its mouth.
 */
const FIG_SENSE = 1.0;
const FIG_AFTER = 3;
const FLOWER_SENSE = 0.5;
const FLOWER_AFTER = 12;
const GRASS_SENSE = 0.12;
const HUNGRY = 35;
export const FLOWERS: readonly PlantKind[] = ['lecocarpus', 'cotton', 'tomato', 'ipomoea'];
const GRASSES: readonly PlantKind[] = ['grass', 'sesuvium', 'tiquilia'];
/** It looks round for something better this often (s), and gives up on a plant it can't get its mouth onto in this long. */
const THINK = 0.25;
const PLANT_GIVE_UP = 8;
/**
 * Wandering, it heads for spots in its meadow: within this share of the meadow's oval, at least this
 * far off (m), and gives up on one it hasn't reached in this long (s).
 */
const WANDER_SPREAD = 0.85;
const WANDER_MIN = 0.3;
const WANDER_GIVE_UP = 40;
/** Turning rate at full stride (rad/s); it turns as it lurches, hardly at all in a drag. */
const TURN = 0.6;
/**
 * Steering: the shell's ground footprint (m), checked this far ahead of it along each heading it
 * might take; it tries headings this far apart (rad) either side of the one it wants.
 */
const SHELL_R = 0.11;
const FEELERS = [0.08, 0.2] as const;
const VEER = 0.3;
/** It keeps this far from the waterline on land (m) and from the crack's rim. */
const SHORE_KEEP = -0.55;
const CRACK_KEEP = 0.14;
/** Walks this long between rests, then rests this long (s, from-to). */
const WALK_SPELL = [45, 90] as const;
const REST_SPELL = [20, 35] as const;
/** Plants within this of its centre are under the plastron and feet, and get trampled (m). */
const TRAMPLE_REACH = 0.075;
const TRAMPLE_REACH_LYING = 0.1;
/** Clip blend time (s). */
const CROSSFADE = 0.35;
/**
 * Slower than this share of its mean speed, it's in the drag between lurches, all but stopped: it
 * only stops to eat or rest there, so the shell (and a lizard riding it) doesn't jolt to a halt.
 */
const DRAG_PAUSE = 0.3;
/** Where its feet stand (m from the centre, +X its left, +Z forward), for fitting it to the ground. */
const FEET = { side: 0.07, front: 0.092, back: -0.078 };
/** The lizard is shoved clear of the shell's outline by this much (its half-width and some). */
const SHOVE_MARGIN = 0.025;
/** The shell reaches out past its outline at the front for the head and front legs (m). */
const FRONT_REACH = 0.04;
/**
 * A lizard in its path ahead of the middle, caught as it walks, is trampled: shoved out to the side
 * this far past the shell's outline (m), and not again for this long (s).
 */
const TRAMPLE_CLEAR = 0.06;
const TRAMPLE_COOLDOWN = 3;
/** Feet higher than this above the tortoise's are on its back, riding, not in its way (m). */
const ON_TOP = 0.05;
/** How far below a rider's feet the shell may curve away and still be carrying it (m). */
const RIDER_PROBE = 0.02;
/** Rising faster than this (m/s), a lizard on the shell is jumping off, not riding. */
const RIDER_LEAP = 0.1;

interface Extras {
  gait_speed: number;
  /** The walk's surge: its speed / gait_speed = 1 + a1 cos(th) + a2 cos(2 th), th = 4 pi (t - phase), t the cycle fraction. */
  gait_surge: [number, number, number];
  bite_time: number;
  shell_top: number;
  shell_half_extents: [number, number];
  rest_drop: number;
  /** Points on the outside of the carapace (x, y, z triples), standing, feet at y = 0. */
  shell_hull: number[];
}

export class Tortoise {
  readonly root: THREE.Object3D;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private drawnAt = new THREE.Vector3();
  state: TortoiseState = 'walk';
  /** How far it has walked in all (m). */
  along = 0;
  /** Where its centre stands on the ground, and the way it faces (yaw, as the lizard's: 0 is +Z). */
  private x: number;
  private z: number;
  yaw: number;
  /** What it's heading for: a fig, a plant, or just a spot in its meadow. */
  aim: { kind: 'fig'; fig: Fig } | { kind: 'plant'; plant: Plant; for: number } | { kind: 'wander'; x: number; z: number; for: number } | null = null;
  /** Plants it gave up trying to reach. */
  private passed = new WeakSet<Plant>();
  /** Seconds since it last ate. */
  sinceMeal = 0;
  private thinkIn = 0;
  /** Which way it last veered round something in its way (1 left, -1 right). */
  private veer = 1;
  private stateTime = 0;
  private mixer: THREE.AnimationMixer;
  private actions: Record<string, THREE.AnimationAction>;
  private current: THREE.AnimationAction | null = null;
  private extras: Extras;
  private rand = rng(5);
  private untilRest: number;
  private restFor = 0;
  private trampleCooldown = 0;
  /**
   * Called when it walks onto the lizard, with how far to shove it (m, level) to clear its path.
   * Returns whether it was trampled (false if already down).
   */
  onTrample: ((dx: number, dz: number, shell: RAPIER.Collider) => boolean) | null = null;
  /** Times it has trampled the lizard. */
  tramples = 0;
  private meal: { plant: Plant } | { fig: Fig } | null = null;
  private greedy = false;
  private pos = new THREE.Vector3();
  private prevPos = new THREE.Vector3();
  private rot = new THREE.Quaternion();
  private prevRot = new THREE.Quaternion();
  private basis = new THREE.Matrix4();
  private world: RAPIER.World;
  /** The bone the shell is skinned to, its height in the rest pose, and how far the clips raise it now. */
  private shellBone: THREE.Object3D;
  private standingHeight: number;
  private lift = 0;
  private riderRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  /** The lizard was on the shell last step. */
  ridden = false;

  private constructor(
    gltf: Awaited<ReturnType<typeof loadGltf>>,
    world: RAPIER.World,
    private route: Route,
    private plants: Plants,
    private figs: Figs | null,
    private obstacles: () => readonly Obstacle[],
    start: number,
  ) {
    this.root = gltf.scene;
    toonify(this.root);
    const rig = this.root.getObjectByName('Tortoise');
    if (!rig) throw new Error('tortoise.glb has no Tortoise armature');
    this.extras = rig.userData as Extras;
    const shellBone = this.root.getObjectByName('body');
    if (!shellBone) throw new Error('tortoise.glb has no body bone');
    this.shellBone = shellBone;
    this.standingHeight = this.shellHeight();
    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = createAnimationActions(this.mixer, gltf.animations, ['eat', 'lie_down', 'get_up']);

    this.world = world;
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    this.collider = world.createCollider(RAPIER.ColliderDesc.convexHull(shellHull(this.extras))!, this.body);
    registerExactSurface(this.collider);
    const at = route.at(start);
    this.x = at.x;
    this.z = at.z;
    this.yaw = Math.atan2(at.dx, at.dz);
    this.untilRest = this.spell(WALK_SPELL);
    this.pose();
    this.prevPos.copy(this.pos);
    this.prevRot.copy(this.rot);
    this.body.setTranslation(this.pos, true);
    this.body.setRotation(this.rot, true);
    this.play('walk');
  }

  /** `route` is the oval of its meadow; `figs` the fig tree's fruit, if the stage has one; `obstacles` what it steers round. */
  static async load(url: string, scene: THREE.Scene, world: RAPIER.World, route: Route, plants: Plants, figs: Figs | null, obstacles: () => readonly Obstacle[], start = 0) {
    const tortoise = new Tortoise(await loadGltf(url), world, route, plants, figs, obstacles, start);
    scene.add(tortoise.root);
    return tortoise;
  }

  /** Walking speed (m/s): the walk clip's own, so its feet stay planted. */
  get speed() {
    return this.extras.gait_speed;
  }

  get clip(): string | undefined {
    return this.current?.getClip().name;
  }

  /** Where its centre stands on the ground, and the way it faces (yaw, as the lizard's). */
  get position() {
    return { x: this.pos.x, y: this.pos.y, z: this.pos.z, yaw: this.yaw };
  }

  /** Where its mouth reaches the ground when it eats. */
  get mouth() {
    return { x: this.x + Math.sin(this.yaw) * MOUTH_AHEAD, z: this.z + Math.cos(this.yaw) * MOUTH_AHEAD };
  }

  /** The point `d` metres straight ahead of it. */
  ahead(d: number) {
    return { x: this.x + Math.sin(this.yaw) * d, z: this.z + Math.cos(this.yaw) * d };
  }

  /** What it's heading for now, if anything, and where that is. */
  get heading(): { kind: 'fig' | 'plant' | 'wander'; x: number; z: number } | null {
    const a = this.aim;
    if (!a) return null;
    if (a.kind === 'fig') return { kind: a.kind, x: a.fig.x, z: a.fig.z };
    if (a.kind === 'plant') return { kind: a.kind, x: a.plant.x, z: a.plant.z };
    return { kind: a.kind, x: a.x, z: a.z };
  }

  /** Tests: rest now, eat the next plant it comes to, or wander off toward (x, z). */
  request(action: 'eat' | 'rest' | { x: number; z: number }) {
    if (action === 'rest') this.untilRest = 0;
    else if (action === 'eat') {
      this.greedy = true;
      this.thinkIn = 0;
    } else {
      this.aim = { kind: 'wander', x: action.x, z: action.z, for: 0 };
      this.thinkIn = WANDER_GIVE_UP;
    }
  }

  /** Tests: stand it at (x, z), facing `yaw`, walking. */
  place(x: number, z: number, yaw: number) {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.aim = null;
    this.meal = null;
    this.thinkIn = 0;
    if (this.state !== 'walk') this.enter('walk');
    this.pose();
    this.prevPos.copy(this.pos);
    this.prevRot.copy(this.rot);
    this.body.setTranslation(this.pos, true);
    this.body.setRotation(this.rot, true);
  }

  /** Advance one fixed step. */
  step(dt: number, player: PlayerController) {
    const rider = this.carrying(player);
    this.ridden = rider;
    this.prevPos.copy(this.pos);
    this.prevRot.copy(this.rot);
    this.stateTime += dt;
    this.sinceMeal += dt;
    this.trampleCooldown -= dt;
    const t = this.stateTime;
    switch (this.state) {
      case 'walk': {
        // No rest while there's a fig in view.
        if (this.aim?.kind !== 'fig') this.untilRest -= dt;
        const phase = this.walkPhase();
        const pause = this.surge(phase) < DRAG_PAUSE;
        if (this.untilRest <= 0 && pause) {
          this.meal = null;
          this.enter('lie_down');
          break;
        }
        this.thinkIn -= dt;
        if (this.thinkIn <= 0) {
          this.thinkIn = THINK;
          this.think();
        }
        // Heading for food: once its mouth will be on it when it next pauses, it stops there to eat.
        this.meal ??= this.mealAhead(this.untilPause(phase));
        if (this.meal && pause) {
          this.enter('eat');
          break;
        }
        const [wasX, wasZ, wasYaw] = [this.x, this.z, this.yaw];
        // Step and drag: it lurches forward as each foreleg reaches out, then all but stops while
        // the hind leg is dragged up; the walk clip's planted feet slide back under it to match.
        const surge = this.surge(phase);
        const step = this.speed * surge * dt;
        if (!this.meal) this.steer(surge * dt);
        this.x += Math.sin(this.yaw) * step;
        this.z += Math.cos(this.yaw) * step;
        this.pose();
        if (!this.clearLizard(player)) {
          // Pinned lizard: wait for it rather than walk over it.
          [this.x, this.z, this.yaw] = [wasX, wasZ, wasYaw];
          this.pose();
        } else this.along += step;
        this.trample(TRAMPLE_REACH);
        break;
      }
      case 'eat':
        if (this.meal && t >= this.extras.bite_time) {
          this.bite(this.meal);
          this.meal = null;
        }
        if (t >= this.duration('eat')) {
          this.aim = null;
          this.thinkIn = 0;
          this.enter('walk');
        }
        break;
      case 'lie_down':
        this.trample(TRAMPLE_REACH_LYING);
        if (t >= this.duration('lie_down')) {
          this.restFor = this.spell(REST_SPELL);
          this.enter('rest');
        }
        break;
      case 'rest':
        this.trample(TRAMPLE_REACH_LYING);
        if (t >= this.restFor) this.enter('get_up');
        break;
      case 'get_up':
        if (t >= this.duration('get_up')) {
          this.untilRest = this.spell(WALK_SPELL);
          this.enter('walk');
        }
        break;
    }
    // The solid shell rises and falls with the drawn one: bobbing as it walks, sunk onto the ground
    // while it lies down.
    const next = { x: this.pos.x, y: this.pos.y + this.lift, z: this.pos.z };
    if (rider) this.carry(player, next);
    this.body.setNextKinematicTranslation(next);
    this.body.setNextKinematicRotation(this.rot);
  }

  /** The lizard is standing on the shell: just under the middle of its body is the shell, not the ground. */
  private carrying(player: PlayerController): boolean {
    // Not only while grounded: when the shell bobs down a little faster than the lizard falls, it's
    // still riding. Jumping off isn't.
    if (player.swimming || player.climbing || player.velocity.y > RIDER_LEAP) return false;
    this.riderRay.origin = player.position;
    const reach = centreAboveFeet() + RIDER_PROBE;
    const hit = this.world.castRay(this.riderRay, reach, true, undefined, undefined, undefined, undefined, (c) => c.handle === this.collider.handle);
    return hit !== null;
  }

  /** Move a rider with the shell, from where it is now to `next` and the new heading, as if fixed to it. */
  private carry(player: PlayerController, next: { x: number; y: number; z: number }) {
    const was = this.body.translation();
    const delta = new THREE.Quaternion().copy(this.body.rotation() as THREE.Quaternion).invert().premultiply(this.rot);
    const feet = player.feetAt(1, new THREE.Vector3());
    const off = new THREE.Vector3(feet.x - was.x, feet.y - was.y, feet.z - was.z).applyQuaternion(delta);
    const ahead = new THREE.Vector3(0, 0, 1).applyQuaternion(delta);
    player.carry(next.x + off.x - feet.x, next.y + off.y - feet.y, next.z + off.z - feet.z, Math.atan2(ahead.x, ahead.z));
  }

  /** Draw it between the last two steps. */
  update(alpha: number, frameDt: number) {
    this.root.position.lerpVectors(this.prevPos, this.pos, alpha);
    this.root.quaternion.slerpQuaternions(this.prevRot, this.rot, alpha);
    this.mixer.update(frameDt);
    this.lift = this.shellHeight() - this.standingHeight;
    // The shell as drawn: between steps, at the drawn shell's height.
    this.drawnAt.copy(this.root.position).y += this.lift;
    setDrawnPose(this.collider, this.drawnAt, this.root.quaternion);
  }

  /** Height of the body bone (which carries the shell) above the feet, as drawn now. */
  private shellHeight() {
    this.root.updateMatrixWorld(true);
    return this.root.worldToLocal(this.shellBone.getWorldPosition(new THREE.Vector3())).y;
  }

  private spell([a, b]: readonly [number, number]) {
    return a + (b - a) * this.rand();
  }

  private duration(clip: string) {
    return this.actions[clip].getClip().duration;
  }

  private enter(state: TortoiseState) {
    this.state = state;
    this.stateTime = 0;
    this.play(state);
  }

  private play(name: string) {
    const next = this.actions[name];
    if (next === this.current) return;
    next.reset().setEffectiveWeight(1).fadeIn(CROSSFADE).play();
    // Set off from the middle of a drag, slowly, as it stopped.
    if (name === 'walk') next.time = this.dragTime();
    // Fade out everything still showing, not just the last clip: one cut short mid-fade (eat, walk
    // for a frame, then lie down) would otherwise leave the weights short of 1, and the bind pose
    // made up the rest, so the shell jumped.
    for (const action of Object.values(this.actions)) {
      if (action !== next && action.isRunning() && action.getEffectiveWeight() > 0) action.fadeOut(CROSSFADE);
    }
    this.current = next;
  }

  /** Where the walk clip is in its cycle (0..1). */
  private walkPhase() {
    const walk = this.actions.walk;
    return walk.time / walk.getClip().duration;
  }

  /** When in the walk clip it's slowest, in the middle of a drag (s). */
  private dragTime() {
    const [phase] = this.extras.gait_surge;
    return (phase + 0.25) * this.actions.walk.getClip().duration;
  }

  /** Its speed at cycle fraction t, as a share of its mean speed. */
  private surge(t: number) {
    const [phase, a1, a2] = this.extras.gait_surge;
    const th = 4 * Math.PI * (t - phase);
    return 1 + a1 * Math.cos(th) + a2 * Math.cos(2 * th);
  }

  /** How far it will walk from cycle fraction t until it next pauses in a drag (m). */
  private untilPause(t: number) {
    const cycle = this.actions.walk.getClip().duration;
    const dt = 1 / 120;
    let d = 0;
    for (let s = 0; s < cycle / dt && this.surge(t + (s * dt) / cycle) >= DRAG_PAUSE; s++) d += this.speed * this.surge(t + (s * dt) / cycle) * dt;
    return d;
  }

  /** Take the bite: the plant goes, or the fig if its mouth is still on it (the lizard may have nosed it away). */
  private bite(meal: { plant: Plant } | { fig: Fig }) {
    const mouth = this.mouth;
    if ('fig' in meal) {
      const f = meal.fig;
      if (f.state !== 'lying' || Math.hypot(f.x - mouth.x, f.z - mouth.z) > FIG_REACH * 1.5) return;
      this.figs!.eat(f);
    } else if (!meal.plant.eaten) this.plants.eat(meal.plant);
    this.sinceMeal = 0;
  }

  /** Pick what to head for: the best food it notices, or else a spot in its meadow. */
  private think() {
    const { x: mx, z: mz } = this.mouth;
    const side = crackSide(this.x, this.z);
    // A fig, if one lies within its notice on this side of the crack.
    if (this.figs && this.sinceMeal > FIG_AFTER) {
      let best: Fig | null = null;
      let bestD = FIG_SENSE;
      for (const f of this.figs.lying) {
        const d = Math.hypot(f.x - this.x, f.z - this.z);
        if (d < bestD && crackSide(f.x, f.z) === side) [best, bestD] = [f, d];
      }
      if (best) {
        this.aim = { kind: 'fig', fig: best };
        return;
      }
    }
    if (this.aim?.kind === 'fig') this.aim = null;
    // A plant it's still after, as long as it's there and it hasn't been circling it too long.
    if (this.aim?.kind === 'plant') {
      if (!this.aim.plant.eaten && (this.aim.for += THINK) < PLANT_GIVE_UP) return;
      this.passed.add(this.aim.plant);
      this.aim = null;
    }
    // A flower near its mouth, or grass right at it when hungry.
    const flower = this.greedy || this.sinceMeal > FLOWER_AFTER ? this.nearestPlant(mx, mz, FLOWER_SENSE, this.greedy ? null : FLOWERS) : null;
    const grass = !flower && (this.greedy || this.sinceMeal > HUNGRY) ? this.nearestPlant(mx, mz, GRASS_SENSE, GRASSES) : null;
    const plant = flower ?? grass;
    if (plant) {
      this.greedy = false;
      this.aim = { kind: 'plant', plant, for: 0 };
      return;
    }
    // Otherwise amble to another spot in the meadow.
    const a = this.aim;
    if (a?.kind === 'wander' && Math.hypot(a.x - this.x, a.z - this.z) > 0.08 && (a.for += THINK) < WANDER_GIVE_UP) return;
    this.aim = this.wanderSpot();
  }

  private nearestPlant(x: number, z: number, r: number, kinds: readonly PlantKind[] | null): Plant | null {
    let best: Plant | null = null;
    let bestD = r;
    for (const p of this.plants.near(x, z, r)) {
      if (p.growth < 0.5 || p.crush > 0.5 || this.passed.has(p) || (kinds && !kinds.includes(p.kind))) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD && !this.blocked(p.x, p.z, 0)) [best, bestD] = [p, d];
    }
    return best;
  }

  /** A spot in its meadow, picked at random, a little way off and clear of anything solid. */
  private wanderSpot(): { kind: 'wander'; x: number; z: number; for: number } {
    const r = this.route;
    for (let i = 0; i < 20; i++) {
      const a = this.rand() * 2 * Math.PI;
      const d = Math.sqrt(this.rand()) * WANDER_SPREAD;
      const x = r.x + Math.cos(a) * r.rx * d;
      const z = r.z + Math.sin(a) * r.rz * d;
      if (Math.hypot(x - this.x, z - this.z) > WANDER_MIN && !this.blocked(x, z, SHELL_R)) return { kind: 'wander', x, z, for: 0 };
    }
    return { kind: 'wander', x: r.x, z: r.z, for: 0 };
  }

  /** Food at its mouth once it has walked `ahead` further on its heading, or null. */
  private mealAhead(ahead: number): { plant: Plant } | { fig: Fig } | null {
    const a = this.aim;
    if (!a || a.kind === 'wander') return null;
    const { x, z } = this.ahead(ahead + MOUTH_AHEAD);
    if (a.kind === 'fig') return Math.hypot(a.fig.x - x, a.fig.z - z) < FIG_REACH ? { fig: a.fig } : null;
    return Math.hypot(a.plant.x - x, a.plant.z - z) < BITE_REACH ? { plant: a.plant } : null;
  }

  /** Whether a shell of radius r at (x, z) would be somewhere it can't go. */
  private blocked(x: number, z: number, r: number): boolean {
    const edge = TERRAIN_SIZE / 2 - 0.2;
    if (Math.abs(x) > edge - r || Math.abs(z) > edge - r) return true;
    if (shoreDistance(x, z) > SHORE_KEEP + r || overCrack(x, z, CRACK_KEEP + r)) return true;
    return this.obstacles().some((o) => covers(o, x, z, r));
  }

  /** Turn toward what it's heading for, round anything in the way; `amount` is how much of a full-stride second's turn it gets. */
  private steer(amount: number) {
    const h = this.heading;
    if (!h) return;
    // Toward the food so its mouth comes onto it, or the spot itself.
    let want = Math.atan2(h.x - this.x, h.z - this.z);
    const clear = (yaw: number) => FEELERS.every((d) => !this.blocked(this.x + Math.sin(yaw) * d, this.z + Math.cos(yaw) * d, SHELL_R));
    if (!clear(want)) {
      // Round it the way it last went, else the other way.
      let found = false;
      for (let k = 1; k <= 8 && !found; k++) {
        for (const side of [this.veer, -this.veer]) {
          const yaw = want + side * k * VEER;
          if (clear(yaw)) {
            want = yaw;
            this.veer = side;
            found = true;
            break;
          }
        }
      }
    }
    const diff = Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw));
    const most = TURN * amount;
    this.yaw += Math.max(-most, Math.min(most, diff));
  }

  /** Stand where it is: centre on the ground, tilted to where its feet are. */
  private pose() {
    const [x, z, dx, dz] = [this.x, this.z, Math.sin(this.yaw), Math.cos(this.yaw)];
    // Its left, in the ground plane.
    const lx = dz;
    const lz = -dx;
    const h = (f: number, s: number) => terrainHeight(x + dx * f + lx * s, z + dz * f + lz * s);
    const fl = h(FEET.front, FEET.side);
    const fr = h(FEET.front, -FEET.side);
    const bl = h(FEET.back, FEET.side);
    const br = h(FEET.back, -FEET.side);
    this.pos.set(x, (fl + fr + bl + br) / 4, z);
    const forward = new THREE.Vector3(dx * (FEET.front - FEET.back), (fl + fr - bl - br) / 2, dz * (FEET.front - FEET.back)).normalize();
    const left = new THREE.Vector3(lx * 2 * FEET.side, (fl + bl - fr - br) / 2, lz * 2 * FEET.side).normalize();
    const up = new THREE.Vector3().crossVectors(forward, left).normalize();
    const side = new THREE.Vector3().crossVectors(up, forward);
    this.basis.makeBasis(side, up, forward);
    this.rot.setFromRotationMatrix(this.basis);
  }

  private trample(reach: number) {
    this.plants.trample(this.pos.x, this.pos.z, reach, Math.sin(this.yaw), Math.cos(this.yaw));
  }

  /**
   * If the lizard is inside the shell's outline (grown by a margin) and not up on its back, shove it
   * straight out from the middle. False if it couldn't be moved far enough (pinned against something).
   */
  private clearLizard(player: PlayerController): boolean {
    const feet = player.feetAt(1, new THREE.Vector3());
    if (feet.y > this.pos.y + ON_TOP) return true;
    const [dx, dz] = [Math.sin(this.yaw), Math.cos(this.yaw)];
    const ox = feet.x - this.pos.x;
    const oz = feet.z - this.pos.z;
    const along = ox * dx + oz * dz;
    const across = ox * dz - oz * dx;
    const [w, l] = this.extras.shell_half_extents;
    const ax = w + SHOVE_MARGIN;
    const az = l + SHOVE_MARGIN + (along > 0 ? FRONT_REACH : 0);
    const e = (across / ax) ** 2 + (along / az) ** 2;
    if (e >= 1) return true;
    // In its path, ahead of the middle: under its front feet. Trampled, and thrown out to the side.
    if (along > 0 && Math.abs(across) < w && this.trampleCooldown <= 0 && this.onTrample) {
      const side = across >= 0 ? 1 : -1;
      const out = side * (ax + TRAMPLE_CLEAR) - across;
      if (this.onTrample(out * dz, -out * dx, this.collider)) {
        this.tramples++;
        this.trampleCooldown = TRAMPLE_COOLDOWN;
      }
    }
    // Straight out from the middle to the outline (sideways if it's dead centre).
    const k = e > 1e-6 ? 1 / Math.sqrt(e) : 0;
    const [na, nc] = e > 1e-6 ? [along * k, across * k] : [0, ax];
    const wantA = na - along;
    const wantC = nc - across;
    const wx = wantA * dx + wantC * dz;
    const wz = wantA * dz - wantC * dx;
    const want = Math.hypot(wx, wz);
    const got = player.shove(wx, wz, this.collider);
    return got > want * 0.6 || want < 1e-4;
  }
}

/**
 * The shell as a convex hull: the outline at the rim, narrowing up to the crown, plus the plastron
 * underneath. Feet sit at y = 0 and the head points +Z.
 */
function shellHull(x: Extras): Float32Array {
  const [w, l] = x.shell_half_extents;
  // The carapace as the model script measured it, then the plastron underneath.
  const pts = [...x.shell_hull];
  for (const [y, s] of [[0.02, 0.85], [0.03, 1.0]]) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * 2 * Math.PI;
      pts.push(Math.sin(a) * w * s, y, Math.cos(a) * l * s);
    }
  }
  return new Float32Array(pts);
}
