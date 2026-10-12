import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { wrapAngle } from '../math/angles';
import type { InputState } from '../input';
import { PlayerController } from '../player/controller';
import { MovementStateMachine, movementFacts } from '../player/state';
import { LizardModel } from '../player/lizardModel';
import { LizardVisual } from '../player/visual';
import { rng } from '../world/noise';
import type { Obstacle } from '../world/obstacles';
import { CACTUS_GROUP, IGNORE_BODIES, IGUANA_GROUP, PLANT_STEM_GROUP, terrainHeight } from '../world/terrain';
import type { Bushes } from './bushes';
import { steer } from './ground';
import { BURROWS, COLONY, NEST, type Burrow } from './layout';
import { BodyPrey } from './prey';
import type { Racer, Racers } from './racers';
import type { ViewCheck } from '../render/viewCheck';

export type HatchlingPhase = 'burrow' | 'run' | 'freeze' | 'hide' | 'safe' | 'caught' | 'gone';

/** Hatchling tuning: times in s, distances in m. */
export const HATCHLING = {
  /** How many are out at once, and when the first ones come up after the run starts. */
  count: 4,
  firstOut: [4, 10, 18, 27],
  /** Wait before the next comes up from a burrow, once one has got away or been caught. */
  nextOut: [8, 18] as [number, number],
  /** Dashes and the freezes between them. */
  dash: [0.5, 1.4] as [number, number],
  freeze: [0.4, 1.4] as [number, number],
  /** Frozen this much longer while a snake is watching it. */
  watched: [1.5, 3] as [number, number],
  /** A chased hatchling dives for a bush within this reach, and lies there this long after it's left alone. */
  bushReach: 0.9,
  hideTime: [2.5, 5] as [number, number],
  /** Lying with the adults this long before it wanders off out of sight. */
  safeTime: 6,
  /** How long a caught hatchling lies in the coils before the snake has swallowed it. */
  swallow: 3,
};

/** The burrows they come up from: the ones round the nest, where the lizard sees them go. */
const HOME_BURROWS = BURROWS.slice(1)
  .map((b) => ({ b, d: Math.hypot(b.x - NEST.x, b.z - NEST.z) }))
  .sort((p, q) => p.d - q.d)
  .slice(0, 8)
  .map((p) => p.b);
const STEER_EVERY = 4;
/** Drawn in full (feet fitted to the ground) only in view and this close to the camera (m), as the island's iguanas. */
const FULL_DETAIL_NEAR = 1.5;
const VIEW_RADIUS = 0.12;

/**
 * One of the lizard's nest-mates: comes up from its burrow and makes for the adults on the shore the
 * way real hatchlings do, a dash, a freeze, another dash, diving under a bush when a snake comes for
 * it. Some make it, some are caught; then another comes up, so the dunes are never empty. It's
 * driven like the island's iguanas, through the same controller and drawing as the lizard, but
 * never solid to the lizard (they slip past each other).
 */
export class Hatchling {
  readonly body: PlayerController;
  readonly states = new MovementStateMachine();
  readonly visual: LizardVisual;
  readonly prey: BodyPrey;
  phase: HatchlingPhase = 'gone';
  /** Seconds left in this phase. */
  timer = 0;
  /** Counts, for tests. */
  made = 0;
  caughtTimes = 0;
  paused = false;
  burrow: Burrow;
  private goal = { x: 0, z: 0 };
  private input: InputState = { move: { x: 0, y: 0 }, run: false, jump: false, look: { yaw: 0, pitch: 0 }, zoom: 0 };
  private feet = new THREE.Vector3();
  private steerTick: number;
  private steered = 0;
  /** The snake it's fleeing, while one is after it. */
  private fleeing: Racer | null = null;

  constructor(
    readonly index: number,
    readonly model: LizardModel,
    world: RAPIER.World,
    private herd: Hatchlings,
    private rand: () => number,
  ) {
    this.burrow = HOME_BURROWS[index % HOME_BURROWS.length];
    this.body = new PlayerController(world, new THREE.Vector3(this.burrow.x, terrainHeight(this.burrow.x, this.burrow.z), this.burrow.z), (IGUANA_GROUP << 16) | 0xffff);
    this.body.stillGroups = IGNORE_BODIES;
    this.body.climbGroups = IGNORE_BODIES & ~PLANT_STEM_GROUP & ~CACTUS_GROUP;
    this.visual = new LizardVisual(model, this.body, world);
    this.prey = new BodyPrey(`hatchling-${index}`, this.body, herd.bushes, () => this.huntable, (by) => this.caught(by));
    this.steerTick = index % STEER_EVERY;
    this.hide();
  }

  private between(r: readonly [number, number]) {
    return r[0] + (r[1] - r[0]) * this.rand();
  }

  get huntable() {
    return this.phase === 'burrow' || this.phase === 'run' || this.phase === 'freeze' || this.phase === 'hide';
  }

  /** Out of the world until its next turn to come up. */
  private hide() {
    this.phase = 'gone';
    this.model.root.visible = false;
    this.body.collider.setEnabled(false);
  }

  /** Sit in a burrow's mouth, facing out, to come up in `wait` seconds. */
  wakeIn(burrow: Burrow, wait: number) {
    this.burrow = burrow;
    // Down at the back of the pit, facing out of the tunnel.
    const s = Math.sin(burrow.yaw);
    const c = Math.cos(burrow.yaw);
    const x = burrow.x + s * 0.03 * burrow.size;
    const z = burrow.z + c * 0.03 * burrow.size;
    this.body.collider.setEnabled(true);
    this.body.setFeet(this.feet.set(x, terrainHeight(x, z), z), burrow.yaw + Math.PI);
    this.model.root.visible = true;
    this.visual.downed = false;
    this.phase = 'burrow';
    this.timer = wait;
    this.fleeing = null;
    this.pickGoal();
  }

  /** Next point on its way to the adults: a dash's worth on, east, wandering a little. */
  private pickGoal() {
    this.body.feetAt(1, this.feet);
    const toX = COLONY.x - this.feet.x;
    const toZ = COLONY.z - this.feet.z;
    const d = Math.hypot(toX, toZ);
    const hop = Math.min(d, 0.6 + 0.6 * this.rand());
    const side = (this.rand() - 0.5) * 0.9 * Math.min(1, d / 1.5);
    this.goal.x = this.feet.x + (toX / d) * hop - (toZ / d) * side;
    this.goal.z = this.feet.z + (toZ / d) * hop + (toX / d) * side;
  }

  private caught(_by: Racer) {
    this.phase = 'caught';
    this.caughtTimes++;
    this.timer = HATCHLING.swallow;
    this.visual.downed = true;
  }

  step(dt: number) {
    if (this.paused || this.phase === 'gone') {
      if (this.phase === 'gone' && !this.paused) this.countDown(dt);
      return;
    }
    this.body.feetAt(1, this.feet);
    const hunter = this.herd.hunterOf(this.prey);
    const go = (run: boolean) => {
      this.input.move.y = 1;
      this.input.run = run;
    };
    this.input.move.x = 0;
    this.input.move.y = 0;
    this.input.run = false;
    this.timer -= dt;
    switch (this.phase) {
      case 'burrow':
        if (this.timer <= 0 && !hunter) this.dash();
        break;
      case 'run':
        if (hunter?.state === 'alert' && !this.fleeing) {
          // Seen: freeze, and hold it while the snake watches.
          this.phase = 'freeze';
          this.timer = this.between(HATCHLING.watched);
          break;
        }
        if (hunter && (hunter.state === 'chase' || hunter.state === 'strike')) this.flee(hunter);
        go(true);
        this.aim(this.goal.x, this.goal.z);
        if (Math.hypot(this.feet.x - COLONY.x, this.feet.z - COLONY.z) < COLONY.r) {
          this.phase = 'safe';
          this.timer = HATCHLING.safeTime;
          this.made++;
          this.herd.callOff(this.prey);
          break;
        }
        if (this.fleeing && this.herd.bushes.over(this.feet.x, this.feet.z)) {
          this.phase = 'hide';
          this.timer = this.between(HATCHLING.hideTime);
          break;
        }
        if (this.timer <= 0 || Math.hypot(this.goal.x - this.feet.x, this.goal.z - this.feet.z) < 0.05) {
          if (this.fleeing) {
            if (hunter) this.timer = 0.4;
            else this.fleeing = null;
          }
          if (!this.fleeing) {
            this.phase = 'freeze';
            this.timer = this.between(HATCHLING.freeze);
          }
          this.pickGoal();
        }
        break;
      case 'freeze':
        if (hunter && (hunter.state === 'chase' || hunter.state === 'strike')) {
          this.flee(hunter);
          break;
        }
        if (hunter?.state === 'alert') this.timer = Math.max(this.timer, 0.3);
        if (this.timer <= 0) this.dash();
        break;
      case 'hide':
        if (hunter) this.timer = Math.max(this.timer, 1);
        if (this.timer <= 0) {
          this.fleeing = null;
          this.dash();
        }
        break;
      case 'safe':
        // Lies still at the edge of the adults, then slips away among the rocks.
        if (this.timer <= 0) this.retire();
        break;
      case 'caught':
        if (this.timer <= 0) this.retire();
        break;
    }
  }

  private countDown(dt: number) {
    this.timer -= dt;
    if (this.timer <= 0) this.wakeIn(this.herd.freeBurrow(this.rand), 1 + this.rand() * 2);
  }

  private retire() {
    this.hide();
    this.timer = this.between(HATCHLING.nextOut);
  }

  private dash() {
    this.phase = 'run';
    this.timer = this.between(HATCHLING.dash);
  }

  /** Run from `hunter`: for the nearest bush in reach that isn't toward it, else straight away. */
  private flee(hunter: Racer) {
    if (this.fleeing === hunter && this.phase === 'run') return;
    this.fleeing = hunter;
    this.phase = 'run';
    this.timer = 1.2;
    const awayX = this.feet.x - hunter.neck.x;
    const awayZ = this.feet.z - hunter.neck.z;
    const away = Math.hypot(awayX, awayZ) || 1;
    let best: { x: number; z: number } | null = null;
    let bestD = HATCHLING.bushReach;
    for (const b of this.herd.bushes.list) {
      const d = Math.hypot(b.x - this.feet.x, b.z - this.feet.z);
      const toward = ((b.x - this.feet.x) * awayX + (b.z - this.feet.z) * awayZ) / (d * away);
      if (d < bestD && toward > -0.3) {
        best = b;
        bestD = d;
      }
    }
    if (best) {
      this.goal.x = best.x;
      this.goal.z = best.z;
      this.timer = bestD / 0.5 + 0.5;
    } else {
      this.goal.x = this.feet.x + (awayX / away) * 0.8;
      this.goal.z = this.feet.z + (awayZ / away) * 0.8;
    }
  }

  /** Turn toward (x, z), round whatever is in the way. */
  private aim(x: number, z: number) {
    let want = Math.atan2(x - this.feet.x, z - this.feet.z);
    if (++this.steerTick >= STEER_EVERY) {
      this.steerTick = 0;
      this.steered = steer(this.herd.obstacles, this.feet.x, this.feet.z, want, 0.12, 0.03);
    }
    if (Math.abs(wrapAngle(this.steered - want)) < 2) want = this.steered;
    this.input.move.x = THREE.MathUtils.clamp(-wrapAngle(want - this.body.yaw) * 2.5, -1, 1);
  }

  /** Physics step: the controller under its own input. */
  move(dt: number) {
    if (this.phase === 'gone' || this.paused) return;
    if (this.phase === 'caught') {
      this.input.move.x = this.input.move.y = 0;
    }
    this.body.step(dt, this.input);
    this.states.update(movementFacts(this.body), dt);
  }

  update(alpha: number, dt: number) {
    if (this.phase === 'gone') return;
    this.visual.update(this.states.state, alpha, dt);
    this.model.updateBodySpheres();
  }
}

/** The lizard's nest-mates, as a group: who's out, the bushes they hide under, the snakes after them. */
export class Hatchlings {
  readonly list: Hatchling[] = [];
  racers: Racers | null = null;
  private time = 0;

  private constructor(
    readonly bushes: Bushes,
    readonly obstacles: readonly Obstacle[],
  ) {}

  static async load(url: string, scene: THREE.Scene, world: RAPIER.World, bushes: Bushes, obstacles: readonly Obstacle[]) {
    const herd = new Hatchlings(bushes, obstacles);
    for (let i = 0; i < HATCHLING.count; i++) {
      const model = await LizardModel.load(url);
      // A little paler or darker each, as a clutch is.
      const tint = new THREE.Color().setScalar(0.9 + 0.08 * i);
      model.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const tinted = (m: THREE.Material) => {
          const c = m.clone() as THREE.MeshToonMaterial;
          c.color?.multiply(tint);
          return c;
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(tinted) : tinted(mesh.material);
      });
      scene.add(model.root);
      herd.list.push(new Hatchling(i, model, world, herd, rng(410 + i)));
    }
    herd.start();
    return herd;
  }

  /** Back in their burrows, to come up one by one as at the start of a run. */
  start() {
    this.list.forEach((h, i) => h.wakeIn(HOME_BURROWS[i % HOME_BURROWS.length], HATCHLING.firstOut[i] ?? 30));
  }

  get prey() {
    return this.list.map((h) => h.prey);
  }

  /** A burrow round the nest no other hatchling is in. */
  freeBurrow(rand: () => number): Burrow {
    const taken = new Set(this.list.filter((h) => h.phase === 'burrow').map((h) => h.burrow));
    const open = HOME_BURROWS.filter((b) => !taken.has(b));
    return open[Math.floor(rand() * open.length)] ?? HOME_BURROWS[0];
  }

  /** The snake watching or after `prey`, if any. */
  hunterOf(prey: BodyPrey): Racer | null {
    if (!this.racers) return null;
    for (const r of this.racers.list) if (r.prey === prey && (r.state === 'alert' || r.state === 'chase' || r.state === 'strike' || r.state === 'search')) return r;
    return null;
  }

  callOff(prey: BodyPrey) {
    this.racers?.callOff(prey);
  }

  /** Decisions, before the physics step. */
  step(dt: number) {
    this.time += dt;
    for (const h of this.list) h.step(dt);
    for (const h of this.list) h.move(dt);
  }

  update(alpha: number, dt: number, view: ViewCheck) {
    for (const h of this.list) {
      h.visual.lowDetail = !view.close(h.model.root.position, VIEW_RADIUS, FULL_DETAIL_NEAR);
      h.update(alpha, dt);
    }
  }
}
