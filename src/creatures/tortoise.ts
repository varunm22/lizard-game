import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createAnimationActions } from '../render/animationActions';
import { loadGltf } from '../render/gltf';
import { toonify } from '../render/toon';
import { rng } from '../world/noise';
import { terrainHeight } from '../world/terrain';
import { registerExactSurface, setDrawnPose } from '../world/exactSurface';
import type { Plant, Plants } from '../world/plants';
import type { PlayerController } from '../player/controller';
import { centreAboveFeet } from '../player/movement';
import type { Route } from './route';

/**
 * A Galapagos giant tortoise (assets-src/tortoise.py) that plods round its route all day: it presses
 * the plants under it flat, so its round becomes a trail; it stops to eat some of the plants its
 * mouth comes to; now and then it lies down for a rest. It takes no notice of the lizard. Its shell
 * is solid (a kinematic body, so the lizard can stand on it), and if it walks into the lizard it
 * shoves it aside; if the lizard can't go anywhere, the tortoise waits.
 */
export type TortoiseState = 'walk' | 'eat' | 'lie_down' | 'rest' | 'get_up';

/** How far ahead of its centre the mouth meets the ground when it reaches down to eat (m). */
const MOUTH_AHEAD = 0.16;
/** A plant this close to that spot (m) and at least half grown can be eaten. */
const BITE_REACH = 0.03;
/** It eats about this share of the plants its mouth comes to, and not again for a while (s). */
const EAT_CHANCE = 0.4;
const EAT_COOLDOWN = 12;
/** Walks this long between rests, then rests this long (s, from-to). */
const WALK_SPELL = [45, 90] as const;
const REST_SPELL = [20, 35] as const;
/** Plants within this of its centre are under the plastron and feet, and get trampled (m). */
const TRAMPLE_REACH = 0.075;
const TRAMPLE_REACH_LYING = 0.1;
/** Clip blend time (s). */
const CROSSFADE = 0.35;
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
  /** How far round its route it is (m). */
  along: number;
  private stateTime = 0;
  private mixer: THREE.AnimationMixer;
  private actions: Record<string, THREE.AnimationAction>;
  private current: THREE.AnimationAction | null = null;
  private extras: Extras;
  private rand = rng(5);
  private untilRest: number;
  private restFor = 0;
  private eatCooldown = 0;
  private trampleCooldown = 0;
  /**
   * Called when it walks onto the lizard, with how far to shove it (m, level) to clear its path.
   * Returns whether it was trampled (false if already down).
   */
  onTrample: ((dx: number, dz: number, shell: RAPIER.Collider) => boolean) | null = null;
  /** Times it has trampled the lizard. */
  tramples = 0;
  private meal: Plant | null = null;
  /** Plants it has already passed by without eating, so each gets one chance. */
  private passed = new WeakSet<Plant>();
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
    start: number,
  ) {
    this.root = gltf.scene;
    toonify(this.root);
    this.root.traverse((o) => (o.frustumCulled = false));
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
    this.along = start;
    this.untilRest = this.spell(WALK_SPELL);
    this.pose();
    this.prevPos.copy(this.pos);
    this.prevRot.copy(this.rot);
    this.body.setTranslation(this.pos, true);
    this.body.setRotation(this.rot, true);
    this.play('walk');
  }

  static async load(url: string, scene: THREE.Scene, world: RAPIER.World, route: Route, plants: Plants, start = 0) {
    const tortoise = new Tortoise(await loadGltf(url), world, route, plants, start);
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
    const { dx, dz } = this.route.at(this.along);
    return { x: this.pos.x, y: this.pos.y, z: this.pos.z, yaw: Math.atan2(dx, dz) };
  }

  /** The point on its route `d` metres ahead of it. */
  ahead(d: number) {
    const { x, z } = this.route.at(this.along + d);
    return { x, z };
  }

  /** Tests: rest now, or eat the next plant it comes to. */
  request(action: 'eat' | 'rest') {
    if (action === 'rest') this.untilRest = 0;
    else {
      this.eatCooldown = 0;
      this.greedy = true;
    }
  }

  /** Advance one fixed step. */
  step(dt: number, player: PlayerController) {
    const rider = this.carrying(player);
    this.ridden = rider;
    this.prevPos.copy(this.pos);
    this.prevRot.copy(this.rot);
    this.stateTime += dt;
    this.eatCooldown -= dt;
    this.trampleCooldown -= dt;
    const t = this.stateTime;
    switch (this.state) {
      case 'walk': {
        this.untilRest -= dt;
        if (this.untilRest <= 0) {
          this.enter('lie_down');
          break;
        }
        const meal = this.findMeal();
        if (meal) {
          this.meal = meal;
          this.enter('eat');
          break;
        }
        const was = this.along;
        this.along += this.speed * dt;
        this.pose();
        if (!this.clearLizard(player)) {
          // Pinned lizard: wait for it rather than walk over it.
          this.along = was;
          this.pose();
        }
        this.trample(TRAMPLE_REACH);
        break;
      }
      case 'eat':
        if (this.meal && t >= this.extras.bite_time) {
          if (!this.meal.eaten) this.plants.eat(this.meal);
          this.meal = null;
        }
        if (t >= this.duration('eat')) {
          this.eatCooldown = EAT_COOLDOWN;
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
    // Fade out everything still showing, not just the last clip: one cut short mid-fade (eat, walk
    // for a frame, then lie down) would otherwise leave the weights short of 1, and the bind pose
    // made up the rest, so the shell jumped.
    for (const action of Object.values(this.actions)) {
      if (action !== next && action.isRunning() && action.getEffectiveWeight() > 0) action.fadeOut(CROSSFADE);
    }
    this.current = next;
  }

  /** A plant at its mouth worth stopping for, or null. */
  private findMeal(): Plant | null {
    if (this.eatCooldown > 0) return null;
    const { x, z, dx, dz } = this.route.at(this.along);
    const p = this.plants.nearest(x + dx * MOUTH_AHEAD, z + dz * MOUTH_AHEAD, BITE_REACH, 0.5);
    if (!p || this.passed.has(p)) return null;
    this.passed.add(p);
    if (!this.greedy && this.rand() > EAT_CHANCE) return null;
    this.greedy = false;
    return p;
  }

  /** Stand at the current point of the route: centre on the ground, tilted to where its feet are. */
  private pose() {
    const { x, z, dx, dz } = this.route.at(this.along);
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
    const { dx, dz } = this.route.at(this.along);
    this.plants.trample(this.pos.x, this.pos.z, reach, dx, dz);
  }

  /**
   * If the lizard is inside the shell's outline (grown by a margin) and not up on its back, shove it
   * straight out from the middle. False if it couldn't be moved far enough (pinned against something).
   */
  private clearLizard(player: PlayerController): boolean {
    const feet = player.feetAt(1, new THREE.Vector3());
    if (feet.y > this.pos.y + ON_TOP) return true;
    const { dx, dz } = this.route.at(this.along);
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
