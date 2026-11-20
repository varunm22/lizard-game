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
export const NOTICE = 2.3;
export const REAR_TIME = 0.9;
/** His charge: this fast (m/s) on land, turning at most this fast (rad/s), for at most this long (s). */
export const CHARGE_SPEED = 0.42;
const CHARGE_TURN = 1.6;
export const CHARGE_TIME = 3.5;
/** After a charge he won't charge again for this long (s). */
const COOLDOWN = 4;
/** Swimming his beat, this fast (m/s). */
const PATROL_SPEED = 0.16;
/** His head this near the lizard's body (m, skin to skin) hits it, and throws it this far. */
const HIT_REACH = 0.02;
const THROW = 0.12;
/** A pup gets curious about the lizard within this (m), comes at this speed, and nudges it this far over this long (s). */
export const PUP_CURIOUS = 0.55;
const PUP_SPEED = 0.12;
const NUDGE = 0.05;
/** Its head this near the lizard's body (m, skin to skin) touches it. */
const NOSE_REACH = 0.008;
const NUDGE_TIME = 0.4;
/** After a nudge, a pup goes back to its mother and rests at least this long (s). */
const PUP_REST = 6;

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const yawQ = new THREE.Quaternion();
const tiltE = new THREE.Euler();
const partAt = new THREE.Vector3();
const partTurn = new THREE.Quaternion();
/** Under water he stays down this long (s), and up for a breath this long; a dart lasts this long, a roll right over this long. */
const DIVE_TIME = 9;
const BREATH_TIME = 2.5;
const DART_TIME = 0.7;
const ROLL_TIME = 1.1;
const ease = (k: number) => k * k * (3 - 2 * k);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** One sea lion in the world: its body, where it is and which way it faces, and its solid body. */
class SeaLion {
  readonly pos = new THREE.Vector3();
  readonly prev = new THREE.Vector3();
  yaw: number;
  prevYaw: number;
  travel = 0;
  /** Lying along the ground: its pitch and roll to the sand under it; afloat, `swimPitch` and `swimRoll`. */
  readonly tilt = new THREE.Quaternion();
  /** Afloat: how far under it is (0 at the surface, 1 swimming deep), and its pitch (nose up) and roll (left side up), radians. */
  under = 0;
  swimPitch = 0;
  swimRoll = 0;
  readonly rb: RAPIER.RigidBody;
  /** One capsule per slice of its trunk (`SeaLionBody.parts`), following its pose. */
  readonly colliders: RAPIER.Collider[];

  constructor(
    readonly body: SeaLionBody,
    world: RAPIER.World,
    x: number,
    z: number,
    yaw: number,
  ) {
    this.yaw = this.prevYaw = yaw;
    this.rb = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    this.colliders = body.parts.map((p) => world.createCollider(RAPIER.ColliderDesc.capsule(Math.max(p.half, 1e-4), p.radius).setCollisionGroups(SEA_LION_GROUPS), this.rb));
    this.place(x, z);
    this.prev.copy(this.pos);
    this.syncBody(true);
  }

  /** The first of its colliders, for the lizard's shove to look past (it looks past all of them). */
  get collider() {
    return this.colliders[0];
  }

  /**
   * Put it at (x, z) on the ground, or floating at the surface where the water is deep enough.
   * Ashore it lies along the sand: pitched to the slope under it nose to tail, rolled to it side to side.
   */
  place(x: number, z: number) {
    const ground = terrainHeight(x, z);
    const float = WATER_Y - 0.55 * this.body.height;
    this.pos.set(x, Math.max(ground, float), z);
    if (float >= ground) {
      // Afloat: only its back and head out at the surface; under water, as deep as `under` takes it
      // (clear of the bottom), pitched and rolled as it swims.
      const h = this.body.height;
      const top = WATER_Y - 0.82 * h;
      const deep = Math.max(ground + 0.02, WATER_Y - 3.2 * h);
      this.pos.y = top + (Math.min(top, deep) - top) * this.under;
      tiltE.set(-this.swimPitch, 0, this.swimRoll, 'XYZ');
      this.tilt.setFromEuler(tiltE);
      return;
    }
    const half = 0.35 * this.body.length;
    const side = 0.1 * this.body.length;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const nose = terrainHeight(x + fx * half, z + fz * half);
    const tail = terrainHeight(x - fx * half, z - fz * half);
    const left = terrainHeight(x + fz * side, z - fx * side);
    const right = terrainHeight(x - fz * side, z + fx * side);
    // Halfway between the sand under its middle and the line between its ends, so it neither floats over a dip nor sinks into a hump.
    this.pos.y = (ground + (nose + tail) / 2) / 2;
    tiltE.set(Math.atan2(tail - nose, 2 * half), 0, Math.atan2(right - left, 2 * side) * -1, 'XYZ');
    this.tilt.setFromEuler(tiltE);
  }

  get depth() {
    return WATER_Y - terrainHeight(this.pos.x, this.pos.z);
  }

  /** The tip of its muzzle (m, world). */
  nose(out: THREE.Vector3) {
    const L = this.body.length * 0.5;
    return out.set(this.pos.x + Math.sin(this.yaw) * L, this.pos.y, this.pos.z + Math.cos(this.yaw) * L);
  }

  /** Move its solid body to where it is, each capsule to where its pose put that part of it. */
  syncBody(teleport = false) {
    const q = yawQ.setFromAxisAngle(Y_AXIS, this.yaw).multiply(this.tilt);
    if (teleport) {
      this.rb.setTranslation(this.pos, true);
      this.rb.setRotation(q, true);
    } else {
      this.rb.setNextKinematicTranslation(this.pos);
      this.rb.setNextKinematicRotation(q);
    }
    this.colliders.forEach((c, i) => {
      this.body.partAt(i, partAt, partTurn);
      c.setTranslationWrtParent(partAt);
      c.setRotationWrtParent(partTurn);
    });
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
    root.quaternion.setFromAxisAngle(Y_AXIS, this.prevYaw + wrap(this.yaw - this.prevYaw) * alpha).multiply(this.tilt);
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
  private time = 0;
  /** His play under water (`play`): breathing at the surface or not and until when, the next dart, the one under way, and a roll. */
  private breathing = false;
  private breathIn = 3;
  private dartIn = 1.5;
  private dartLeft = 0;
  private dartTurn = 0;
  private darts = 0;
  private rollLeft = 0;

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
      // Her solid body follows how she lies or sits.
      cow.body.pose();
      cow.syncBody(true);
      this.cows.push(cow);
    });
    PUPS.forEach((p, i) => {
      const pup = add('Pup', p.x, p.z, p.yaw, 10 + i);
      pup.body.rest = 0.6;
      pup.body.pose();
      this.pups.push(new Pup(pup, p));
    });
    const x = (BULL_BEAT.x0 + BULL_BEAT.x1) / 2;
    this.bull = add('Bull', x, shoreZ(x) - BULL_BEAT.off, Math.PI / 2, 20);
    this.bull.body.lift = 0.6;
    this.bull.body.pose();
  }

  get danger(): 'none' | 'watched' | 'chased' {
    if (this.bullState === 'rear') return 'watched';
    return this.bullState === 'charge' ? 'chased' : 'none';
  }

  /** Everything back where it started (a new run). */
  reset() {
    this.bullState = 'patrol';
    this.breathing = false;
    this.breathIn = 3;
    this.dartIn = 1.5;
    this.dartLeft = 0;
    this.dartTurn = 0;
    this.darts = 0;
    this.rollLeft = 0;
    this.bull.under = this.bull.swimPitch = this.bull.swimRoll = 0;
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
        let want = Math.atan2(ax - b.pos.x, shoreZ(ax) - BULL_BEAT.off - b.pos.z);
        let speed = PATROL_SPEED;
        if (deep) {
          // Under water he plays: weaving, darting off at a sharp angle now and then and rolling
          // over, each stroke of the fore-flippers a surge; up every so often to breathe.
          this.play(dt);
          want += 0.55 * Math.sin(this.time * 0.8) + this.dartTurn;
          speed = PATROL_SPEED * (1.25 + 0.45 * Math.max(0, body.beat)) * (this.dartLeft > 0 ? 2.6 : 1);
        }
        b.head(want, this.dartLeft > 0 ? 4 : 1.8, speed, dt);
        // Swimming low, the head up, looking to the beach now and then.
        body.look = deep ? 0 : 0.4 * Math.sin(this.time * 0.5);
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
        // Faster in the water than galumphing up the sand.
        const speed = deep ? CHARGE_SPEED * 1.3 : CHARGE_SPEED;
        b.head(atLizard, CHARGE_TURN, speed, dt);
        // Up the beach no further than his stretch.
        const s = b.pos.z - shoreZ(b.pos.x);
        if (s > BULL_STRETCH) b.place(b.pos.x, shoreZ(b.pos.x) + BULL_STRETCH);
        gait = deep ? 0 : 1;
        lift = 0.8;
        jaw = 0.35 * Math.max(0, Math.sin(this.timer * 7));
        body.look = 0;
        body.nod = 0;
        if (this.touching(b, HIT_REACH) && this.prey) {
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
    this.swimAttitude(b, dt, deep);
    body.lift += (lift - body.lift) * (1 - Math.exp(-5 * dt));
    body.gait += (gait - body.gait) * (1 - Math.exp(-6 * dt));
    body.jaw += (jaw - body.jaw) * (1 - Math.exp(-14 * dt));
    if (this.bullState !== 'rear') body.nod *= Math.exp(-6 * dt);
    b.syncBody();
  }

  /**
   * The bull's play under water on his beat: when to go up for a breath and back down, darts off at
   * a sharp angle (a burst of speed, now and then a roll right over), all on fixed timers so a run
   * replays the same.
   */
  private play(dt: number) {
    this.breathIn -= dt;
    if (this.breathIn <= 0) {
      this.breathing = !this.breathing;
      this.breathIn = this.breathing ? BREATH_TIME : DIVE_TIME;
    }
    this.dartIn -= dt;
    this.dartLeft -= dt;
    if (this.dartLeft <= 0) this.dartTurn *= Math.exp(-3 * dt);
    if (this.dartIn <= 0 && !this.breathing) {
      this.darts++;
      this.dartLeft = DART_TIME;
      this.dartIn = 2.6 + 1.6 * ((this.darts * 0.618) % 1);
      this.dartTurn = (this.darts % 2 ? 1 : -1) * (0.7 + 0.4 * ((this.darts * 0.382) % 1));
      if (this.darts % 3 === 0) this.rollLeft = ROLL_TIME;
    }
  }

  /**
   * How far under he is, and his pitch and roll: down and up by breath, nosing down as he goes under
   * and up as he rises, banking into turns, and rolling right over on some darts. Ashore, level.
   */
  private swimAttitude(b: SeaLion, dt: number, deep: boolean) {
    const playing = deep && (this.bullState === 'patrol' || this.bullState === 'back');
    const want = playing && !this.breathing ? 1 : 0;
    const before = b.under;
    b.under += (want - b.under) * (1 - Math.exp(-(want ? 1.6 : 2.2) * dt));
    if (!deep) b.under = 0;
    const turnRate = wrap(b.yaw - b.prevYaw) / dt;
    const climb = (before - b.under) / dt;
    b.swimPitch += (Math.max(-0.7, Math.min(0.7, climb * 1.8)) - b.swimPitch) * (1 - Math.exp(-6 * dt));
    let roll = Math.max(-0.8, Math.min(0.8, -turnRate * 0.35)) * b.under;
    this.rollLeft -= dt;
    if (this.rollLeft > 0) roll += Math.PI * 2 * ease((ROLL_TIME - this.rollLeft) / ROLL_TIME);
    b.swimRoll += (roll - b.swimRoll) * (1 - Math.exp(-10 * dt));
    if (this.rollLeft <= 0 && Math.abs(b.swimRoll) > Math.PI) b.swimRoll -= Math.sign(b.swimRoll) * Math.PI * 2;
    if (!deep) {
      b.swimPitch = 0;
      b.swimRoll = 0;
    }
    // Looking into his turns; nose up at the surface for a breath.
    if (playing) b.body.look += (Math.max(-0.6, Math.min(0.6, turnRate * 0.4)) * b.under - b.body.look) * (1 - Math.exp(-6 * dt));
    if (deep && this.bullState === 'patrol') b.body.nod = 0.25 * (1 - b.under);
    b.place(b.pos.x, b.pos.z);
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
        if (this.touching(l, NOSE_REACH)) {
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
  /** Its forebody (head, neck or chest) within `reach` (m) of the lizard's body: their solid bodies, skin to skin. */
  private touching(l: SeaLion, reach: number) {
    const lizard = this.player.collider;
    return l.colliders.slice(0, 4).some((c) => {
      const hit = c.contactCollider(lizard, reach);
      return !!hit && hit.distance < reach;
    });
  }

  private blocked(l: SeaLion) {
    return this.cows.some((c) => Math.hypot(c.pos.x - l.pos.x, c.pos.z - l.pos.z) < 0.5 * (c.body.length + l.body.length) * 0.55);
  }

  /** Draw them all between steps, posing only those near enough to see. */
  update(alpha: number, dt: number, eye: THREE.Vector3) {
    for (const l of [this.bull, ...this.cows, ...this.pups.map((p) => p.lion)]) {
      const near = Math.hypot(l.pos.x - eye.x, l.pos.z - eye.z) < 4;
      l.body.root.visible = near || l === this.bull || Math.hypot(l.pos.x - eye.x, l.pos.z - eye.z) < 7;
      if (near) l.draw(alpha, dt);
      else {
        l.body.root.position.copy(l.pos);
        l.body.root.quaternion.setFromAxisAngle(Y_AXIS, l.yaw).multiply(l.tilt);
      }
    }
  }
}
