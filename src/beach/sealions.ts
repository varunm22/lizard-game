import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import type { PlayerController } from '../player/controller';
import { WATER_Y } from '../world/shore';
import { terrainHeight } from '../world/terrain';
import { BULL_BEAT, BULL_STRETCH, COWS, onBullStretch, PUPS, shoreZ } from './layout';
import { SeaLionBody, type SeaLionKit } from './sealionBody';
import { SEA_LION_GROUPS } from './props';

/** What the bull can do to the lizard, from the run. */
export interface BeachPrey {
  feet(out: THREE.Vector3): THREE.Vector3;
  /** Out in the open: not down, not finished. */
  huntable(): boolean;
  swimming(): boolean;
  /** Hit by the bull, the blow travelling along (dx, dz): 'down', 'hurt', or null if it was down already. */
  struck(dx: number, dz: number): 'down' | 'hurt' | null;
}

export type BullState = 'patrol' | 'rear' | 'charge' | 'back';
export type PupState = 'rest' | 'come' | 'nudge' | 'back';

/** The bull notices the lizard on his stretch this near (m), rears and barks this long (s), then charges. */
export const NOTICE = 1.8;
export const REAR_TIME = 0.9;
/** His charge: this fast (m/s) on land, turning at most this fast (rad/s), for at most this long (s). */
export const CHARGE_SPEED = 0.42;
const CHARGE_TURN = 1.6;
export const CHARGE_TIME = 2.5;
/** After a charge he won't charge again for this long (s). */
const COOLDOWN = 4;
/** Swimming his beat, this fast (m/s). */
const PATROL_SPEED = 0.16;
/** His muzzle this near the lizard (m) hits it, and throws it this far. */
const HIT_REACH = 0.12;
const THROW = 0.12;
/** A pup gets curious about the lizard within this (m), comes at this speed, and nudges it this far over this long (s). */
export const PUP_CURIOUS = 0.55;
const PUP_SPEED = 0.12;
const NUDGE = 0.05;
/** Its nose this near the middle of the lizard (m) touches it: half the lizard's length, and the gap the lizard keeps from a body pressing into it. */
const NOSE_REACH = 0.12;
const NUDGE_TIME = 0.4;
/** After a nudge, a pup goes back to its mother and rests at least this long (s). */
const PUP_REST = 6;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** One sea lion in the world: its body, where it is and which way it faces, and its solid capsule. */
class SeaLion {
  readonly pos = new THREE.Vector3();
  readonly prev = new THREE.Vector3();
  yaw: number;
  prevYaw: number;
  travel = 0;
  readonly rb: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private radius: number;

  constructor(
    readonly body: SeaLionBody,
    world: RAPIER.World,
    x: number,
    z: number,
    yaw: number,
  ) {
    this.yaw = this.prevYaw = yaw;
    const L = body.length;
    this.radius = 0.09 * L * (body.kind === 'Bull' ? 1.15 : 1);
    this.rb = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.28 * L, this.radius).setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)).setCollisionGroups(SEA_LION_GROUPS), this.rb);
    this.place(x, z);
    this.prev.copy(this.pos);
    this.syncBody(true);
  }

  /** Put it at (x, z) on the ground, or floating at the surface where the water is deep enough. */
  place(x: number, z: number) {
    const ground = terrainHeight(x, z);
    this.pos.set(x, Math.max(ground, WATER_Y - 0.55 * this.body.height), z);
  }

  get depth() {
    return WATER_Y - terrainHeight(this.pos.x, this.pos.z);
  }

  /** The tip of its muzzle (m, world). */
  nose(out: THREE.Vector3) {
    const L = this.body.length * 0.5;
    return out.set(this.pos.x + Math.sin(this.yaw) * L, this.pos.y, this.pos.z + Math.cos(this.yaw) * L);
  }

  syncBody(teleport = false) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    const t = { x: this.pos.x, y: this.pos.y + this.radius, z: this.pos.z };
    if (teleport) {
      this.rb.setTranslation(t, true);
      this.rb.setRotation(q, true);
    } else {
      this.rb.setNextKinematicTranslation(t);
      this.rb.setNextKinematicRotation(q);
    }
  }

  /** Start of a step: remember where it was, for drawing between steps. */
  begin() {
    this.prev.copy(this.pos);
    this.prevYaw = this.yaw;
  }

  /** Turn toward `want` at most `rate` (rad/s), and move `speed` forward. */
  head(want: number, rate: number, speed: number, dt: number) {
    const d = wrap(want - this.yaw);
    this.yaw = wrap(this.yaw + Math.max(-rate * dt, Math.min(rate * dt, d)));
    const step = speed * dt;
    this.place(this.pos.x + Math.sin(this.yaw) * step, this.pos.z + Math.cos(this.yaw) * step);
    this.travel += step;
  }

  draw(alpha: number, dt: number) {
    const root = this.body.root;
    root.position.lerpVectors(this.prev, this.pos, alpha);
    root.rotation.y = this.prevYaw + wrap(this.yaw - this.prevYaw) * alpha;
    this.body.advance(dt, this.travel);
    this.travel = 0;
    this.body.pose();
  }
}

class Pup {
  state: PupState = 'rest';
  timer = 0;
  nudgeLeft = 0;
  readonly home: { x: number; z: number; yaw: number };
  constructor(readonly lion: SeaLion, home: { x: number; z: number; yaw: number }) {
    this.home = { ...home };
  }
}

/**
 * The sea lions: a bull patrolling the waterline, the cows hauled out above it and their pups. The
 * cows lie or sit up where they are; their bodies are solid. A pup comes galumphing over to a
 * lizard that comes near (`PUP_CURIOUS`), nudges it with its nose, then goes back to its mother.
 * The bull swims to and fro along his beat; a lizard on his stretch of beach (`onBullStretch`)
 * within `NOTICE` gets a warning, rearing up and barking, then a charge up the sand. He turns slowly,
 * so a lizard that dodges aside or gets off the beach is safe; caught, it's thrown aside and hurt.
 */
export class SeaLions {
  readonly cows: SeaLion[] = [];
  readonly pups: Pup[] = [];
  readonly bull: SeaLion;
  bullState: BullState = 'patrol';
  /** Charges that ended without catching the lizard, and that caught it; pup nudges. */
  dodged = 0;
  hits = 0;
  nudges = 0;
  prey: BeachPrey | null = null;
  /** Tests not about them stop them. */
  paused = false;
  private timer = 0;
  private cooldown = 0;
  private beatTo = BULL_BEAT.x1;
  private hit = false;
  private feet = new THREE.Vector3();
  private v = new THREE.Vector3();
  private time = 0;

  constructor(
    kit: SeaLionKit,
    scene: THREE.Scene,
    world: RAPIER.World,
    private player: PlayerController,
  ) {
    const add = (kind: 'Cow' | 'Bull' | 'Pup', x: number, z: number, yaw: number, seed: number) => {
      const lion = new SeaLion(new SeaLionBody(kit, kind, seed), world, x, z, yaw);
      scene.add(lion.body.root);
      return lion;
    };
    COWS.forEach((c, i) => {
      const cow = add('Cow', c.x, c.z, c.yaw, i);
      cow.body.lift = c.lift;
      cow.body.rest = c.lift > 0 ? 0 : 0.8;
      this.cows.push(cow);
    });
    PUPS.forEach((p, i) => {
      const pup = add('Pup', p.x, p.z, p.yaw, 10 + i);
      pup.body.rest = 0.6;
      this.pups.push(new Pup(pup, p));
    });
    const x = (BULL_BEAT.x0 + BULL_BEAT.x1) / 2;
    this.bull = add('Bull', x, shoreZ(x) - BULL_BEAT.off, Math.PI / 2, 20);
    this.bull.body.lift = 0.6;
  }

  get danger(): 'none' | 'watched' | 'chased' {
    if (this.bullState === 'rear') return 'watched';
    return this.bullState === 'charge' ? 'chased' : 'none';
  }

  /** Everything back where it started (a new run). */
  reset() {
    this.bullState = 'patrol';
    this.timer = 0;
    this.cooldown = 0;
    const x = (BULL_BEAT.x0 + BULL_BEAT.x1) / 2;
    this.bull.place(x, shoreZ(x) - BULL_BEAT.off);
    this.bull.yaw = Math.PI / 2;
    this.bull.begin();
    this.bull.syncBody(true);
    for (const p of this.pups) {
      p.state = 'rest';
      p.timer = 0;
      p.lion.place(p.home.x, p.home.z);
      p.lion.yaw = p.home.yaw;
      p.lion.begin();
      p.lion.syncBody(true);
    }
  }

  /** Tests: stand the bull at (x, z) facing `yaw`, on his beat or charging. */
  placeBull(x: number, z: number, yaw: number, state: 'patrol' | 'charge') {
    const b = this.bull;
    b.place(x, z);
    b.yaw = yaw;
    b.begin();
    b.syncBody(true);
    this.bullState = state;
    this.timer = 0;
    this.hit = false;
    this.cooldown = 0;
  }

  /** Called off (the lizard went down or finished): the bull goes back to his beat. */
  callOff() {
    if (this.bullState === 'rear' || this.bullState === 'charge') this.endCharge();
  }

  step(dt: number) {
    if (this.paused) return;
    this.time += dt;
    const prey = this.prey;
    const feet = prey ? prey.feet(this.feet) : this.feet.set(1e3, 0, 1e3);
    const huntable = !!prey && prey.huntable();
    this.stepBull(dt, feet, huntable && !prey!.swimming());
    for (const p of this.pups) this.stepPup(p, dt, feet, huntable);
    for (const c of this.cows) {
      // Sitting up, a cow looks about now and then; lying, she dozes.
      c.body.look = c.body.lift > 0 ? 0.5 * Math.sin(this.time * 0.3 + c.body.length * 40) : 0;
    }
  }

  private stepBull(dt: number, feet: THREE.Vector3, onLand: boolean) {
    const b = this.bull;
    b.begin();
    this.cooldown -= dt;
    const dx = feet.x - b.pos.x;
    const dz = feet.z - b.pos.z;
    const dist = Math.hypot(dx, dz);
    const atLizard = Math.atan2(dx, dz);
    const stretch = onLand && onBullStretch(feet.x, feet.z);
    const deep = b.depth > 0.4 * b.body.height;
    const body = b.body;
    let lift = deep ? 0 : 0.6;
    let gait = 0;
    let jaw = 0;
    switch (this.bullState) {
      case 'patrol': {
        if (Math.abs(b.pos.x - this.beatTo) < 0.1) this.beatTo = this.beatTo === BULL_BEAT.x1 ? BULL_BEAT.x0 : BULL_BEAT.x1;
        const ax = b.pos.x + Math.sign(this.beatTo - b.pos.x) * 0.3;
        const want = Math.atan2(ax - b.pos.x, shoreZ(ax) - BULL_BEAT.off - b.pos.z);
        b.head(want, 1.2, PATROL_SPEED, dt);
        // Swimming low, the head up, looking to the beach now and then.
        body.look = 0.4 * Math.sin(this.time * 0.5);
        if (stretch && dist < NOTICE && this.cooldown <= 0) {
          this.bullState = 'rear';
          this.timer = 0;
        }
        break;
      }
      case 'rear': {
        this.timer += dt;
        b.head(atLizard, 3, 0, dt);
        lift = 1;
        body.look = 0;
        // Two barks, the head thrown up.
        const bark = Math.max(0, Math.sin((this.timer / REAR_TIME) * Math.PI * 2));
        jaw = 0.5 * bark;
        body.nod = 0.25 * bark;
        if (!stretch) this.endCharge(true);
        else if (this.timer >= REAR_TIME) {
          this.bullState = 'charge';
          this.timer = 0;
          this.hit = false;
        }
        break;
      }
      case 'charge': {
        this.timer += dt;
        const speed = deep ? CHARGE_SPEED * 0.8 : CHARGE_SPEED;
        b.head(atLizard, CHARGE_TURN, speed, dt);
        // Up the beach no further than his stretch.
        const s = b.pos.z - shoreZ(b.pos.x);
        if (s > BULL_STRETCH) b.place(b.pos.x, shoreZ(b.pos.x) + BULL_STRETCH);
        gait = deep ? 0 : 1;
        lift = 0.8;
        jaw = 0.35 * Math.max(0, Math.sin(this.timer * 7));
        body.look = 0;
        body.nod = 0;
        const nose = b.nose(this.v);
        const nd = Math.hypot(feet.x - nose.x, feet.z - nose.z);
        if (nd < HIT_REACH && this.prey) {
          const fx = Math.sin(b.yaw);
          const fz = Math.cos(b.yaw);
          if (this.prey.struck(fx, fz)) {
            this.player.shove(fx * THROW, fz * THROW, b.collider);
            this.hit = true;
            this.hits++;
          }
          this.endCharge();
        } else if (!stretch || this.timer >= CHARGE_TIME) this.endCharge();
        break;
      }
      case 'back': {
        const want = Math.atan2(0, -1);
        const targetZ = shoreZ(b.pos.x) - BULL_BEAT.off;
        if (b.pos.z <= targetZ + 0.02) {
          this.bullState = 'patrol';
          break;
        }
        b.head(want, 2, deep ? PATROL_SPEED : 0.22, dt);
        gait = deep ? 0 : 1;
        body.look = 0;
        break;
      }
    }
    body.swim += ((deep ? 1 : 0) - body.swim) * (1 - Math.exp(-4 * dt));
    body.lift += (lift - body.lift) * (1 - Math.exp(-5 * dt));
    body.gait += (gait - body.gait) * (1 - Math.exp(-6 * dt));
    body.jaw += (jaw - body.jaw) * (1 - Math.exp(-14 * dt));
    if (this.bullState !== 'rear') body.nod *= Math.exp(-6 * dt);
    b.syncBody();
  }

  /** The charge is over, caught or not (or the warning, if `warned` and the lizard got off his stretch first). */
  private endCharge(warned = false) {
    if (this.bullState === 'charge' && !this.hit) this.dodged++;
    if (warned && this.bullState === 'rear') this.dodged++;
    this.bullState = 'back';
    this.cooldown = COOLDOWN;
  }

  private stepPup(p: Pup, dt: number, feet: THREE.Vector3, huntable: boolean) {
    const l = p.lion;
    l.begin();
    p.timer -= dt;
    const dx = feet.x - l.pos.x;
    const dz = feet.z - l.pos.z;
    const dist = Math.hypot(dx, dz);
    const body = l.body;
    let gait = 0;
    let lift = 0;
    const nose = l.nose(this.v);
    const nd = Math.hypot(feet.x - nose.x, feet.z - nose.z);
    const onLand = huntable && !this.prey!.swimming();
    switch (p.state) {
      case 'rest':
        body.look = 0.3 * Math.sin(this.time * 0.7 + body.length * 90);
        if (onLand && dist < PUP_CURIOUS && p.timer <= 0) p.state = 'come';
        break;
      case 'come': {
        lift = 0.6;
        if (!onLand || dist > PUP_CURIOUS * 1.6) {
          p.state = 'back';
          break;
        }
        if (nd < NOSE_REACH) {
          p.state = 'nudge';
          p.nudgeLeft = NUDGE_TIME;
          this.nudges++;
          break;
        }
        gait = 1;
        l.head(Math.atan2(dx, dz), 3, PUP_SPEED, dt);
        if (this.blocked(l)) {
          // A cow in the way: it gives up and goes back.
          l.place(l.prev.x, l.prev.z);
          p.state = 'back';
          p.timer = 2;
        }
        break;
      }
      case 'nudge': {
        lift = 0.7;
        p.nudgeLeft -= dt;
        // A push with its nose, lifting its head into the lizard.
        body.nod = 0.3 * Math.sin((1 - p.nudgeLeft / NUDGE_TIME) * Math.PI);
        const step = (NUDGE / NUDGE_TIME) * dt;
        if (onLand) this.player.shove(Math.sin(l.yaw) * step, Math.cos(l.yaw) * step, l.collider);
        if (p.nudgeLeft <= 0) {
          p.state = 'back';
          p.timer = PUP_REST;
        }
        break;
      }
      case 'back': {
        const hx = p.home.x - l.pos.x;
        const hz = p.home.z - l.pos.z;
        if (Math.hypot(hx, hz) < 0.03) {
          l.head(p.home.yaw, 2, 0, dt);
          if (Math.abs(wrap(p.home.yaw - l.yaw)) < 0.1) p.state = 'rest';
          break;
        }
        lift = 0.6;
        gait = 1;
        l.head(Math.atan2(hx, hz), 3, PUP_SPEED * 0.8, dt);
        break;
      }
    }
    if (p.state !== 'nudge') body.nod *= Math.exp(-6 * dt);
    body.lift += (lift - body.lift) * (1 - Math.exp(-5 * dt));
    body.gait += (gait - body.gait) * (1 - Math.exp(-6 * dt));
    l.syncBody();
  }

  /** Whether a pup has walked into a cow (it goes round by stopping and turning on). */
  private blocked(l: SeaLion) {
    return this.cows.some((c) => Math.hypot(c.pos.x - l.pos.x, c.pos.z - l.pos.z) < 0.5 * (c.body.length + l.body.length) * 0.55);
  }

  /** Draw them all between steps, posing only those near enough to see. */
  update(alpha: number, dt: number, eye: THREE.Vector3) {
    for (const l of [this.bull, ...this.cows, ...this.pups.map((p) => p.lion)]) {
      const near = Math.hypot(l.pos.x - eye.x, l.pos.z - eye.z) < 4;
      l.body.root.visible = near || l === this.bull || Math.hypot(l.pos.x - eye.x, l.pos.z - eye.z) < 7;
      if (near) l.draw(alpha, dt);
      else l.body.root.position.copy(l.pos);
    }
  }
}
