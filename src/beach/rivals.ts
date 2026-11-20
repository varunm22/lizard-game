import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d';
import { wrapAngle } from '../math/angles';
import type { InputState } from '../input';
import { PlayerController } from '../player/controller';
import { MOVEMENT as M } from '../player/movement';
import { MovementStateMachine, movementFacts } from '../player/state';
import type { LizardModel } from '../player/lizardModel';
import { LizardVisual } from '../player/visual';
import { CACTUS_GROUP, IGNORE_BODIES, IGUANA_GROUP, PLANT_STEM_GROUP, terrainHeight } from '../world/terrain';
import { DISPLAY_ROCKS, FEMALE_SPOTS, SULK_SPOTS } from './layout';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A display: the head bobbing, three times over this long (s). */
export const DISPLAY_TIME = 1.2;
/** The head's nod (radians, snout up) `t` s into a display. */
export function displayNod(t: number): number {
  if (t < 0 || t >= DISPLAY_TIME) return 0;
  const bob = Math.abs(Math.sin((t / DISPLAY_TIME) * 3 * Math.PI));
  return 0.42 * bob * Math.min(1, t / 0.1, (DISPLAY_TIME - t) / 0.15);
}

/** A rival warns a lizard this near his rock (m), and gives up warning past this. */
export const WARN = 0.9;
const LEAVE = 1.4;
/** He displays this often (s) while warning; a display back within `ANSWER` of his counts as an exchange. */
const DISPLAY_GAP = 1.8;
export const ANSWER = 2.5;
/** Within this (m, centre to centre) the two are head to head, and the shoving starts. */
export const CONTACT = 2 * (M.bodyHalfLength + M.bodyRadius) + 0.015;
/** The shoving: he surges this long (s), then eases off this long; the push that wins (m). */
export const SURGE = 0.7;
export const EASE = 0.5;
export const WIN = 0.22;
/** How fast the pair moves (m/s per unit of push in hand). */
const SHOVE_RATE = 0.12;
/** The lizard's push holding forward, his easing push, and a head-butt's (m, only while he eases off), and how soon it can butt again (s). */
export const PLAYER_PUSH = 1;
const EASED = 0.3;
export const BUTT = 0.05;
export const BUTT_GAP = 0.6;
/** After losing, the lizard can't start shoving again for this long (s). */
const LOST_GAP = 1.5;
/** A beaten male sulks this long (s) before coming back to challenge. */
export const SULK = 14;
/** Standing on a vacant rock this long (s) claims it; away from it this long, it's lost. */
export const CLAIM_TIME = 2;
const AWAY_TIME = 4;
/** A female comes this near the lizard on its rock (m), and two displays to her this far apart (s) win her. */
const COURT = 0.2;
const COURT_GAP = 1.0;
export const COURTSHIP = 2;

/**
 * The three rival males: how many displays it takes to make each back down (never, the big one),
 * and how hard each pushes. The old male is twice the lizard's weight: no shove moves him. He
 * chases an intruder off instead, and only the bull can see him off.
 */
export const RIVALS = [
  { backDown: 2, push: 0.9, tint: [1, 0.97, 0.95], name: 'young' },
  { backDown: Infinity, push: 2.4, tint: [0.88, 0.84, 0.84], name: 'old' },
  { backDown: 4, push: 1.5, tint: [0.96, 0.92, 0.9], name: 'seasoned' },
] as const;
/** The old male's rock, the lek's best: in the middle, nearest the females, the only one they come to. */
export const OLD_ROCK = 1;
/** The old male chases an intruder off at a walk this fast (0 to 1), until it's this far ahead of him (m) or for this long (s). */
const CHASE_PACE = 1;
export const CHASE_LOSE = 1.0;
const CHASE_TIME = 30;
/** Charged off the bull's beach, a male flees here (out past the females) and stays away. */
const ROUTED_SPOTS = [
  { x: -4.6, z: 4.4 },
  { x: 2.4, z: 5.0 },
  { x: 4.8, z: 4.4 },
] as const;

/** Cold-blooded: below this warmth the lizard's displays don't impress anyone, and its shove is weak. */
export const WARM_ENOUGH = 0.5;
/** How much of its push (and butt) the lizard has at warmth `w`: all of it from `WARM_ENOUGH`, down to `COLD_VIGOUR` at 0.15. */
const COLD_VIGOUR = 0.4;
export function vigour(w: number): number {
  return COLD_VIGOUR + (1 - COLD_VIGOUR) * clamp((w - 0.15) / (WARM_ENOUGH - 0.15), 0, 1);
}


/** Another marine iguana on the beach, driven like the player by an InputState. */
export class Npc {
  readonly body: PlayerController;
  readonly states = new MovementStateMachine();
  readonly visual: LizardVisual;
  readonly input: InputState = { move: { x: 0, y: 0 }, run: false, jump: false, look: { yaw: 0, pitch: 0 }, zoom: 0 };
  readonly feet = new THREE.Vector3();
  /** Time into the display under way, or -1. */
  displayT = -1;
  /** In a shoving match: the input held, its position set by the match. */
  locked = false;

  constructor(
    readonly model: LizardModel,
    world: RAPIER.World,
    x: number,
    z: number,
    yaw: number,
    /** Standing this high (m) over the ground: up on a rock. */
    up = 0,
  ) {
    this.body = new PlayerController(world, new THREE.Vector3(x, terrainHeight(x, z) + up + 0.005, z), (IGUANA_GROUP << 16) | 0xffff);
    this.body.setFeet(this.body.feetAt(1, this.feet), yaw);
    this.body.stillGroups = IGNORE_BODIES;
    this.body.climbGroups = IGNORE_BODIES & ~PLANT_STEM_GROUP & ~CACTUS_GROUP;
    this.visual = new LizardVisual(model, this.body, world);
  }

  get displaying() {
    return this.displayT >= 0;
  }

  display() {
    if (this.displayT < 0) this.displayT = 0;
  }

  /** Walk toward (x, z) at `pace` (0 to 1); returns how far off it is (m). */
  steer(x: number, z: number, pace = 0.6): number {
    this.body.feetAt(1, this.feet);
    const d = Math.hypot(x - this.feet.x, z - this.feet.z);
    const diff = wrapAngle(Math.atan2(x - this.feet.x, z - this.feet.z) - this.body.yaw);
    this.input.move.x = clamp(-diff * 2.5, -1, 1);
    this.input.move.y = Math.abs(diff) < 0.9 ? pace : Math.min(pace, 0.3);
    if (d < 0.03) this.input.move.x = this.input.move.y = 0;
    return d;
  }

  /** Stand still, turning toward `yaw` a little at a time. */
  face(yaw: number, dt: number) {
    this.input.move.x = this.input.move.y = 0;
    const diff = wrapAngle(yaw - this.body.yaw);
    if (Math.abs(diff) < 0.05 || !this.body.grounded) return;
    const turn = clamp(diff, -2 * dt, 2 * dt);
    this.body.setFeet(this.body.feetAt(1, this.feet), wrapAngle(this.body.yaw + turn));
  }

  step(dt: number) {
    if (this.locked) this.input.move.x = this.input.move.y = 0;
    this.body.step(dt, this.input);
    this.states.update(movementFacts(this.body), dt);
    if (this.displayT >= 0 && (this.displayT += dt) >= DISPLAY_TIME) this.displayT = -1;
  }

  update(alpha: number, dt: number, low: boolean) {
    this.visual.lowDetail = low;
    // Head to head, both keep nodding into each other.
    const goal = this.locked ? 0.15 + 0.1 * Math.sin(performance.now() * 0.01) : displayNod(this.displayT);
    this.model.nod += (goal - this.model.nod) * (1 - Math.exp(-30 * dt));
    this.visual.update(this.states.state, alpha, dt);
    this.model.updateBodySpheres();
  }
}

export type RivalState = 'hold' | 'warn' | 'chase' | 'shove' | 'retreat' | 'sulk' | 'return' | 'routed';
export type FemaleState = 'bask' | 'come' | 'watch' | 'chosen';

export interface Rival {
  npc: Npc;
  rock: number;
  backDown: number;
  push: number;
  state: RivalState;
  /** Displays answered this time round. */
  exchanges: number;
  /** Since his last display (s). */
  sinceDisplay: number;
  /** Since it started this state (s). */
  timer: number;
  /** Come back to take his rock from the lizard. */
  challenging: boolean;
  /** Chases an intruder off rather than backing down (the old male). */
  chaser: boolean;
}

/** The shoving match under way. */
export interface Match {
  rival: Rival;
  /** How far the lizard has pushed him back (m): `WIN` wins, -`WIN` loses. */
  push: number;
  /** Into the current surge-and-ease cycle (s). */
  t: number;
  /** Unit vector from him to the lizard, level. */
  ax: number;
  az: number;
  /** Where the pair's middle started. */
  mx: number;
  mz: number;
  sinceButt: number;
}

/** What the lizard is doing, for the rivals, from the run. */
export interface Suitor {
  player: PlayerController;
  /** Free to be challenged: not down, not finished, not swimming. */
  free(): boolean;
  /** Pressing forward this step, and the jump (a head-butt) just pressed. */
  pushing(): boolean;
  butting(): boolean;
  /** Its warmth, 0 to 1: cold, its displays don't count and its shove is weak. */
  warmth(): number;
}

/**
 * The lek on the lava field behind the beach: three rival males, each holding a display rock, and
 * the females basking at its back. A lizard coming near a rock gets warned off, the male facing it
 * and bobbing his head; answer each display with one of its own (B) and the young and the seasoned
 * male back down after a few exchanges. Walk into one (or let him close in) and it's a shoving
 * match, head to head, holding forward to push, butting (Space) as he eases off between surges.
 * Beaten either way, a male goes off to sulk at the field's edge and comes back later to challenge.
 * A vacant rock is claimed by standing on it a moment; seeing off a returning challenger is a goal.
 * The old male never backs down and can't be shoved: he comes off his rock and chases the lizard
 * off at a walk. Led down onto the bull's beach, the bull charges him (`rout`) and he flees for good.
 * His rock is the one the females come to: holding it brings the nearest over, and displaying to
 * her wins her. Cold (`WARM_ENOUGH`), the lizard's displays count for nothing and its shove is weak.
 */
export class Rivals {
  readonly rivals: Rival[] = [];
  readonly females: { npc: Npc; state: FemaleState; home: (typeof FEMALE_SPOTS)[number] }[] = [];
  /** Which rock each is held by: a rival's index, 'player', or null. */
  readonly owner: (number | 'player' | null)[];
  match: Match | null = null;
  /** Counts for the goals. */
  outDisplayed = 0;
  shoveWins = 0;
  shoveLosses = 0;
  claims = 0;
  defended = 0;
  courtship = 0;
  chosen = false;
  /** The rock the lizard is claiming, and for how long it's stood there (s). */
  claiming: { rock: number; t: number } | null = null;
  /** Tests not about them stop them. */
  paused = false;
  /** Called as the lizard wins or loses a match, beats a male back by displays, claims a rock, sees off a challenger, wins a female. */
  onEvent: ((what: 'won' | 'lost' | 'outDisplayed' | 'claimed' | 'defended' | 'lostRock' | 'female' | 'chosen' | 'cold' | 'chase' | 'routed', rock: number) => void) | null = null;
  private feet = new THREE.Vector3();
  private sinceLost = Infinity;
  private away = 0;
  private sinceCourt = Infinity;
  private female: (typeof this.females)[number] | null = null;

  constructor(
    rivalModels: LizardModel[],
    femaleModels: LizardModel[],
    scene: THREE.Scene,
    world: RAPIER.World,
    private suitor: Suitor,
  ) {
    RIVALS.forEach((r, i) => {
      const rock = DISPLAY_ROCKS[i];
      const model = rivalModels[i];
      scene.add(model.root);
      const npc = new Npc(model, world, rock.x, rock.z, rock.yaw, rock.top);
      this.rivals.push({ npc, rock: i, backDown: r.backDown, push: r.push, state: 'hold', exchanges: 0, sinceDisplay: 0, timer: 0, challenging: false, chaser: r.backDown === Infinity });
    });
    FEMALE_SPOTS.forEach((s, i) => {
      const model = femaleModels[i];
      scene.add(model.root);
      this.females.push({ npc: new Npc(model, world, s.x, s.z, s.yaw), state: 'bask', home: s });
    });
    this.owner = DISPLAY_ROCKS.map((_, i) => i);
  }

  /** The rock the lizard holds, or -1. */
  get held(): number {
    return this.owner.indexOf('player');
  }

  /** A rival is warning the lizard, chasing it or shoving it. */
  get danger(): 'none' | 'watched' | 'chased' {
    if (this.match) return 'chased';
    return this.rivals.some((r) => r.state === 'warn' || r.state === 'chase') ? 'watched' : 'none';
  }

  /** The rival males where the bull might see them: out in the open unless already routed. */
  intruders() {
    return this.rivals.map((r) => ({ x: r.npc.feet.x, z: r.npc.feet.z, open: r.state !== 'routed' && !r.npc.body.swimming }));
  }

  /** The old male is out chasing the lizard. */
  get chasing() {
    return this.rivals.some((r) => r.chaser && r.state === 'chase');
  }

  /** The bull charges rival `i`: he flees the beach and the lek, for good this run, his rock left vacant. */
  rout(i: number) {
    const r = this.rivals[i];
    if (r.state === 'routed') return;
    if (this.match?.rival === r) this.endMatch(false, true);
    r.state = 'routed';
    r.timer = 0;
    r.challenging = false;
    r.npc.displayT = -1;
    if (this.owner[r.rock] === i) this.owner[r.rock] = null;
    this.onEvent?.('routed', r.rock);
  }

  /** The lizard displays (B). */
  display() {
    const p = this.suitor;
    if (!p.free() || this.match) return;
    const pf = p.player.feetAt(1, this.feet);
    // Too cold to put on a show: nobody's impressed.
    if (p.warmth() < WARM_ENOUGH) {
      const f = this.female;
      const near = this.rivals.some((r) => r.state === 'warn' && Math.hypot(r.npc.feet.x - pf.x, r.npc.feet.z - pf.z) < WARN + 0.2) || (!!f && Math.hypot(f.npc.feet.x - pf.x, f.npc.feet.z - pf.z) < COURT + 0.25);
      if (near) this.onEvent?.('cold', this.held);
      return;
    }
    for (const r of this.rivals) {
      if (r.state !== 'warn' || r.sinceDisplay > ANSWER) continue;
      if (Math.hypot(r.npc.feet.x - pf.x, r.npc.feet.z - pf.z) > WARN + 0.2) continue;
      r.exchanges++;
      // One answer to each of his displays.
      r.sinceDisplay = Infinity;
      if (r.exchanges >= r.backDown) {
        this.outDisplayed++;
        this.beaten(r);
        this.onEvent?.('outDisplayed', r.rock);
      }
    }
    const f = this.female;
    if (f && f.state === 'watch' && this.sinceCourt > COURT_GAP && Math.hypot(f.npc.feet.x - pf.x, f.npc.feet.z - pf.z) < COURT + 0.25) {
      this.sinceCourt = 0;
      if (++this.courtship >= COURTSHIP) {
        this.chosen = true;
        f.state = 'chosen';
        this.onEvent?.('chosen', this.held);
      }
    }
  }

  /** Tests: send rival `i` off to sulk now (its rock left vacant), or bring it back now to challenge. */
  send(i: number, state: 'retreat' | 'return') {
    const r = this.rivals[i];
    if (state === 'retreat') this.beaten(r);
    else {
      const s = SULK_SPOTS[i];
      r.npc.body.setFeet(this.feet.set(s.x, terrainHeight(s.x, s.z), s.z));
      if (this.owner[r.rock] === i) this.owner[r.rock] = null;
      r.state = 'return';
      r.timer = 0;
      r.exchanges = 0;
    }
  }

  /** All back as they were (a new run); the lizard's displays and claims forgotten. */
  reset() {
    this.match = null;
    for (const r of this.rivals) {
      const rock = DISPLAY_ROCKS[r.rock];
      r.npc.locked = false;
      r.npc.input.run = false;
      r.npc.body.setFeet(this.feet.set(rock.x, terrainHeight(rock.x, rock.z) + rock.top + 0.005, rock.z), rock.yaw);
      r.npc.feet.copy(this.feet);
      Object.assign(r, { state: 'hold', exchanges: 0, sinceDisplay: 0, timer: 0, challenging: false });
    }
    for (const f of this.females) {
      f.state = 'bask';
      f.npc.body.setFeet(this.feet.set(f.home.x, terrainHeight(f.home.x, f.home.z), f.home.z), f.home.yaw);
      f.npc.feet.copy(this.feet);
    }
    this.owner.forEach((_, i) => (this.owner[i] = i));
    this.claiming = null;
    this.female = null;
    this.courtship = 0;
    this.chosen = false;
  }

  /** The lizard went down: any match is off. */
  callOff() {
    if (this.match) this.endMatch(false, true);
  }

  private beaten(r: Rival) {
    if (r.challenging && this.held === r.rock) {
      this.defended++;
      this.onEvent?.('defended', r.rock);
    }
    r.state = 'retreat';
    r.timer = 0;
    r.challenging = false;
    r.npc.displayT = -1;
    if (this.owner[r.rock] === this.rivals.indexOf(r)) this.owner[r.rock] = null;
  }

  step(dt: number) {
    const p = this.suitor;
    const pf = p.player.feetAt(1, this.feet);
    this.sinceLost += dt;
    this.sinceCourt += dt;
    if (this.match) this.stepMatch(dt);
    if (!this.paused) for (const [i, r] of this.rivals.entries()) this.stepRival(r, i, dt, pf);
    this.stepClaim(dt, pf);
    if (!this.paused) this.stepFemales(dt, pf);
    for (const r of this.rivals) r.npc.step(dt);
    for (const f of this.females) f.npc.step(dt);
  }

  private stepRival(r: Rival, i: number, dt: number, pf: THREE.Vector3) {
    const npc = r.npc;
    const rock = DISPLAY_ROCKS[r.rock];
    npc.body.feetAt(1, npc.feet);
    r.timer += dt;
    r.sinceDisplay += dt;
    const free = this.suitor.free();
    const toLizard = Math.hypot(pf.x - npc.feet.x, pf.z - npc.feet.z);
    const lizardToRock = Math.hypot(pf.x - rock.x, pf.z - rock.z);
    const atLizard = Math.atan2(pf.x - npc.feet.x, pf.z - npc.feet.z);
    switch (r.state) {
      case 'hold':
        if (npc.steer(rock.x, rock.z, 0.4) < 0.05) npc.face(rock.yaw + 0.4 * Math.sin(r.timer * 0.2), dt);
        if (free && lizardToRock < WARN) this.warn(r);
        break;
      case 'warn': {
        npc.face(atLizard, dt);
        if (r.sinceDisplay >= DISPLAY_GAP && r.timer > 0.3) {
          npc.display();
          r.sinceDisplay = 0;
        }
        // The old male won't back down or stand for it: after a display he comes off his rock and chases the lizard off.
        if (r.chaser && free && r.sinceDisplay >= DISPLAY_TIME && r.sinceDisplay < DISPLAY_GAP) {
          r.state = 'chase';
          r.timer = 0;
          this.onEvent?.('chase', r.rock);
          break;
        }
        if (!free || lizardToRock > LEAVE) {
          r.state = r.challenging ? 'return' : 'hold';
          r.timer = 0;
        } else if (toLizard < CONTACT && this.sinceLost > LOST_GAP && !this.match) this.startMatch(r);
        break;
      }
      case 'chase':
        // After it, at a walk, as long as it stays near; well ahead of him, or off in the water, he goes back.
        npc.steer(pf.x, pf.z, CHASE_PACE);
        if (!free || toLizard > CHASE_LOSE || r.timer > CHASE_TIME) {
          r.state = 'return';
          r.timer = 0;
        } else if (toLizard < CONTACT && this.sinceLost > LOST_GAP && !this.match) this.startMatch(r);
        break;
      case 'routed': {
        const s = ROUTED_SPOTS[i];
        npc.input.run = npc.steer(s.x, s.z, 1) > 0.5;
        if (Math.hypot(s.x - npc.feet.x, s.z - npc.feet.z) < 0.1) npc.face(Math.atan2(rock.x - npc.feet.x, rock.z - npc.feet.z), dt);
        break;
      }
      case 'shove':
        break;
      case 'retreat': {
        const s = SULK_SPOTS[i];
        if (npc.steer(s.x, s.z, 0.7) < 0.08) {
          r.state = 'sulk';
          r.timer = 0;
        }
        break;
      }
      case 'sulk':
        npc.face(Math.atan2(rock.x - npc.feet.x, rock.z - npc.feet.z), dt);
        if (r.timer > SULK) {
          r.state = 'return';
          r.timer = 0;
          r.exchanges = 0;
        }
        break;
      case 'return': {
        const d = npc.steer(rock.x, rock.z, 0.5);
        if (this.owner[r.rock] === 'player') {
          if (free && Math.hypot(npc.feet.x - rock.x, npc.feet.z - rock.z) < WARN * 0.8) {
            r.challenging = true;
            this.warn(r);
          }
        } else if (d < 0.06) {
          // Back on his rock, unclaimed: his again.
          if (this.owner[r.rock] === null) this.owner[r.rock] = i;
          if (this.claiming?.rock === r.rock) this.claiming = null;
          r.state = 'hold';
          r.timer = 0;
        }
        break;
      }
    }
  }

  private warn(r: Rival) {
    r.state = 'warn';
    r.timer = 0;
    r.sinceDisplay = DISPLAY_GAP;
  }

  private startMatch(r: Rival) {
    const p = this.suitor.player;
    const pf = p.feetAt(1, this.feet);
    const nf = r.npc.feet;
    let ax = pf.x - nf.x;
    let az = pf.z - nf.z;
    const d = Math.hypot(ax, az) || 1;
    ax /= d;
    az /= d;
    this.match = { rival: r, push: 0, t: 0, ax, az, mx: (pf.x + nf.x) / 2, mz: (pf.z + nf.z) / 2, sinceButt: BUTT_GAP };
    r.state = 'shove';
    r.npc.locked = true;
    r.npc.displayT = -1;
    // Head to head.
    r.npc.body.setFeet(nf, Math.atan2(ax, az));
    p.setFeet(pf, Math.atan2(-ax, -az));
  }

  private stepMatch(dt: number) {
    const m = this.match!;
    const p = this.suitor.player;
    m.t = (m.t + dt) % (SURGE + EASE);
    m.sinceButt += dt;
    const surging = m.t < SURGE;
    const his = surging ? m.rival.push : EASED;
    // Cold, it hasn't the strength.
    const strength = vigour(this.suitor.warmth());
    const mine = this.suitor.pushing() ? PLAYER_PUSH * strength : 0;
    m.push += (mine - his) * SHOVE_RATE * dt;
    if (this.suitor.butting() && m.sinceButt >= BUTT_GAP) {
      m.sinceButt = 0;
      if (!surging) m.push += BUTT * strength;
    }
    // Both slide along with the push, the pair's middle moved by it.
    const half = CONTACT / 2;
    const cx = m.mx + m.ax * m.push;
    const cz = m.mz + m.az * m.push;
    const pf = p.feetAt(1, this.feet);
    p.carry(cx + m.ax * half - pf.x, 0, cz + m.az * half - pf.z, 0);
    const nf = m.rival.npc.body.feetAt(1, m.rival.npc.feet);
    m.rival.npc.body.carry(cx - m.ax * half - nf.x, 0, cz - m.az * half - nf.z, 0);
    if (!this.suitor.free()) this.endMatch(false, true);
    else if (m.push >= WIN) this.endMatch(true);
    else if (m.push <= -WIN) this.endMatch(false);
  }

  private endMatch(won: boolean, off = false) {
    const m = this.match!;
    const r = m.rival;
    this.match = null;
    r.npc.locked = false;
    if (won) {
      this.shoveWins++;
      this.beaten(r);
      this.onEvent?.('won', r.rock);
      return;
    }
    if (!off) {
      this.shoveLosses++;
      this.sinceLost = 0;
      // Thrown back off, and off his rock if it held it.
      this.suitor.player.carry(m.ax * 0.1, 0, m.az * 0.1, 0);
      if (this.owner[r.rock] === 'player') {
        this.owner[r.rock] = this.rivals.indexOf(r);
        this.onEvent?.('lostRock', r.rock);
      }
      this.onEvent?.('lost', r.rock);
    }
    r.challenging = false;
    r.state = 'hold';
    r.timer = 0;
  }

  /** Claiming a vacant rock by standing on it; losing it by staying away. */
  private stepClaim(dt: number, pf: THREE.Vector3) {
    const on = DISPLAY_ROCKS.findIndex((_, i) => this.onRock(i, pf));
    const held = this.held;
    if (held >= 0) {
      this.away = on === held ? 0 : this.away + dt;
      if (this.away > AWAY_TIME) {
        this.owner[held] = null;
        this.onEvent?.('lostRock', held);
      }
      return;
    }
    if (on < 0 || this.owner[on] !== null || !this.suitor.free()) {
      this.claiming = null;
      return;
    }
    if (this.claiming?.rock !== on) this.claiming = { rock: on, t: 0 };
    if ((this.claiming.t += dt) >= CLAIM_TIME) {
      this.owner[on] = 'player';
      this.claims++;
      this.away = 0;
      this.claiming = null;
      this.onEvent?.('claimed', on);
    }
  }

  /** Whether (feet) is up on display rock i. */
  onRock(i: number, pf: THREE.Vector3) {
    const d = DISPLAY_ROCKS[i];
    return Math.hypot(pf.x - d.x, pf.z - d.z) < d.r * 0.9 && pf.y > terrainHeight(d.x, d.z) + d.top * 0.5;
  }

  private stepFemales(dt: number, pf: THREE.Vector3) {
    const held = this.held;
    // Once it holds the old male's rock, the lek's best, the nearest female comes over (no challenger about).
    if (!this.female && held === OLD_ROCK && !this.rivals.some((r) => r.challenging)) {
      const rock = DISPLAY_ROCKS[held];
      this.female = this.females.reduce((a, b) => (Math.hypot(a.home.x - rock.x, a.home.z - rock.z) <= Math.hypot(b.home.x - rock.x, b.home.z - rock.z) ? a : b));
      this.female.state = 'come';
      this.onEvent?.('female', held);
    }
    for (const f of this.females) {
      const npc = f.npc;
      npc.body.feetAt(1, npc.feet);
      if (f !== this.female || f.state === 'bask') {
        if (npc.steer(f.home.x, f.home.z, 0.4) < 0.05) npc.face(f.home.yaw, dt);
        continue;
      }
      if (held < 0 && f.state !== 'chosen') {
        f.state = 'bask';
        this.female = null;
        this.courtship = 0;
        continue;
      }
      const d = Math.hypot(pf.x - npc.feet.x, pf.z - npc.feet.z);
      if (f.state === 'come') {
        npc.steer(pf.x, pf.z, 0.8);
        if (d < COURT + 0.1) f.state = 'watch';
      } else {
        npc.face(Math.atan2(pf.x - npc.feet.x, pf.z - npc.feet.z), dt);
        if (f.state === 'watch' && d > COURT + 0.4) f.state = 'come';
        // Chosen, she nods back.
        if (f.state === 'chosen' && !npc.displaying && Math.sin(this.sinceCourt * 2) > 0.95) npc.display();
      }
    }
  }

  /** The female won over (or coming), for the camera and HUD. */
  get suitorFemale() {
    return this.female;
  }

  update(alpha: number, dt: number, eye: THREE.Vector3) {
    for (const n of [...this.rivals.map((r) => r.npc), ...this.females.map((f) => f.npc)]) {
      const far = Math.hypot(n.feet.x - eye.x, n.feet.z - eye.z) > 1.5;
      n.update(alpha, dt, far);
    }
  }
}
