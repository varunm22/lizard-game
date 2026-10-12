import * as THREE from 'three';
import { Goals, type GoalSpec } from '../goals';
import type { PlayerController } from '../player/controller';
import type { LizardVisual } from '../player/visual';
import { terrainHeight } from '../world/terrain';
import type { Bushes } from './bushes';
import { COLONY, NEST, SAFE_POINTS } from './layout';
import { BodyPrey, coverAt, safePointAt } from './prey';
import type { Racers } from './racers';

export type RunState = 'ready' | 'running' | 'caught' | 'home';

/** Lying in the coils this long (s) before the lizard is back in its burrow. */
export const CAUGHT_TIME = 2.5;
/** A crossing this quick (s) counts for the fast goal. */
export const FAST = 60;

/**
 * One go at the crossing: from the nest burrow to the adults under the light. The clock starts as
 * the lizard first moves. On the way are two safe points, rock crevices no snake reaches into: once
 * the lizard has reached one, a racer's catch sends it back there (after a moment in the coils) with
 * the clock still running; caught before the first, it's back in the burrow to start over. Reaching
 * the colony wins it. R starts over at any time. Also keeps the dunes' goals, ticked off for good
 * the first time each is met.
 */
export class DuneRun {
  state: RunState = 'ready';
  /** The clock (s), and the best crossing so far. */
  time = 0;
  best: number | null = null;
  attempts = 1;
  catches = 0;
  finishes = 0;
  /** The furthest safe point reached on this attempt (index into SAFE_POINTS), or -1. */
  checkpoint = -1;
  /** Seconds left lying caught. */
  private caughtLeft = 0;
  /** Whether any racer has chased the lizard on this attempt. */
  private chasedThisRun = false;
  readonly prey: BodyPrey;
  readonly goals: Goals;
  /** Things the goals wait on, set by the racers' callbacks. */
  private outran = false;
  private froze = false;
  private feet = new THREE.Vector3();
  /** Called as a run starts over (R, or after a catch), and as one is won or lost. */
  onReset: (() => void) | null = null;
  onCaught: (() => void) | null = null;
  onHome: (() => void) | null = null;
  /** Called as the lizard reaches a safe point for the first time on an attempt, and as it's put back at one after a catch. */
  onSafe: ((index: number) => void) | null = null;
  onRespawn: ((index: number) => void) | null = null;

  constructor(
    private player: PlayerController,
    private visual: LizardVisual,
    private bushes: Bushes,
    private racers: Racers,
  ) {
    this.prey = new BodyPrey('player', player, bushes, () => this.state === 'ready' || this.state === 'running', () => this.caught());
    racers.onGiveUp = (_r, p) => {
      if (p === this.prey) this.outran = true;
    };
    racers.onLeave = (_r, p) => {
      if (p === this.prey && p.speed() < 0.04) this.froze = true;
    };
    const specs: GoalSpec[] = [
      { id: 'safe', label: 'Shelter in a safe point', met: () => this.checkpoint >= 0 },
      { id: 'shore', label: 'Reach the adults on the shore', met: () => this.finishes > 0 },
      { id: 'freeze', label: 'Freeze till a watching racer looks away', met: () => this.froze },
      { id: 'hide', label: 'Hide from a racer in a burrow or bush', met: () => this.hidingFromHunter(), hold: 1 },
      { id: 'outrun', label: 'Outrun a racer snake', met: () => this.outran },
      { id: 'unseen', label: 'Cross without being chased', met: () => this.state === 'home' && !this.chasedThisRun },
      { id: 'fast', label: `Cross in under ${FAST} seconds`, met: () => this.state === 'home' && this.time < FAST },
    ];
    this.goals = new Goals(specs);
  }

  /** Whether some racer is chasing or nosing after the lizard as it lies hidden. */
  private hidingFromHunter() {
    if (this.state !== 'running' && this.state !== 'ready') return false;
    this.player.feetAt(1, this.feet);
    if (!coverAt(this.bushes, this.feet.x, this.feet.z)) return false;
    return this.racers.list.some((r) => r.prey === this.prey && (r.state === 'chase' || r.state === 'search'));
  }

  /** How much danger the lizard's in: a snake watching it, or after it. */
  get danger(): 'none' | 'watched' | 'chased' {
    let level: 'none' | 'watched' | 'chased' = 'none';
    if (this.state !== 'running' && this.state !== 'ready') return level;
    for (const r of this.racers.list) {
      if (r.prey !== this.prey) continue;
      if (r.state === 'chase' || r.state === 'strike') return 'chased';
      if (r.state === 'alert' || r.state === 'search') level = 'watched';
    }
    return level;
  }

  /** Whether the lizard is held still (lying caught). */
  get held() {
    return this.state === 'caught';
  }

  private caught() {
    if (this.state !== 'running' && this.state !== 'ready') return;
    this.state = 'caught';
    this.catches++;
    this.caughtLeft = CAUGHT_TIME;
    this.visual.downed = true;
    this.onCaught?.();
  }

  /** In a safe point's crevice now. */
  get safe() {
    this.player.feetAt(1, this.feet);
    return safePointAt(this.feet.x, this.feet.z) >= 0;
  }

  /** Back at the last safe point reached, the clock still running, the snakes called off. */
  private respawn() {
    const p = SAFE_POINTS[this.checkpoint];
    this.state = 'running';
    this.visual.downed = false;
    this.player.setFeet(this.feet.set(p.x, terrainHeight(p.x, p.z), p.z), p.yaw);
    this.racers.callOff(this.prey);
    this.onRespawn?.(this.checkpoint);
  }

  /** Back in the nest burrow, clock reset, the snakes called off. */
  restart() {
    this.state = 'ready';
    this.time = 0;
    this.attempts++;
    this.checkpoint = -1;
    this.chasedThisRun = false;
    this.visual.downed = false;
    this.player.setFeet(this.feet.set(NEST.x, terrainHeight(NEST.x, NEST.z), NEST.z), NEST.yaw);
    this.racers.callOff(this.prey);
    this.onReset?.();
  }

  /** Each physics step, with whether there's movement input this step. */
  step(dt: number, moving: boolean) {
    if (this.state === 'ready' && moving) this.state = 'running';
    if (this.state === 'running') {
      this.time += dt;
      if (this.danger === 'chased') this.chasedThisRun = true;
      this.player.feetAt(1, this.feet);
      const safe = safePointAt(this.feet.x, this.feet.z);
      if (safe > this.checkpoint) {
        this.checkpoint = safe;
        this.racers.callOff(this.prey);
        this.onSafe?.(safe);
      }
      if (Math.hypot(this.feet.x - COLONY.x, this.feet.z - COLONY.z) < COLONY.r) {
        this.state = 'home';
        this.finishes++;
        if (this.best === null || this.time < this.best) this.best = this.time;
        this.racers.callOff(this.prey);
        this.onHome?.();
      }
    }
    if (this.state === 'caught') {
      this.caughtLeft -= dt;
      if (this.caughtLeft <= 0) {
        if (this.checkpoint >= 0) this.respawn();
        else this.restart();
      }
    }
    this.goals.step(dt);
  }
}
