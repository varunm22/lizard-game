import * as THREE from 'three';
import { Goals, type GoalSpec } from '../goals';
import type { PlayerController } from '../player/controller';
import type { LizardVisual } from '../player/visual';
import { terrainHeight } from '../world/terrain';
import type { DriftLog } from './driftLog';
import type { Heron, HeronPrey, Herons } from './herons';
import { FINISH, SAFE_POINTS, START } from './layout';
import type { Swimmers } from './swimmers';

export type RunState = 'ready' | 'running' | 'caught' | 'home';

/** In a heron's bill this long (s) before the lizard is put back. */
export const CAUGHT_TIME = 2.5;
/** Riding the log while it drifts this long (s) counts for the ride goal. */
const RIDE = 1;

/** The safe point (x, z) is in, by index, or -1. */
export function safePointAt(x: number, z: number): number {
  return SAFE_POINTS.findIndex((p) => Math.hypot(x - p.x, z - p.z) < p.r);
}

/**
 * One go at the lagoon: from the lava coast to the lava field across the channel. The clock starts
 * as the lizard first moves. Halfway is a safe point among old mangrove roots: once the lizard has
 * reached it, a heron's catch puts it back there (the clock still running); caught before that, it's
 * back at the start. Reaching the field wins it. R starts over at any time, the log back in its pool.
 * Also keeps the lagoon's goals, ticked off for good the first time each is met.
 */
export class LagoonRun {
  state: RunState = 'ready';
  time = 0;
  best: number | null = null;
  attempts = 1;
  catches = 0;
  finishes = 0;
  checkpoint = -1;
  private caughtLeft = 0;
  readonly prey: HeronPrey;
  readonly goals: Goals;
  /** Things the goals wait on, set by the herons' callbacks. */
  private hid = false;
  private dove = false;
  private slipped = false;
  private feet = new THREE.Vector3();
  onReset: (() => void) | null = null;
  onCaught: ((by: Heron) => void) | null = null;
  onHome: (() => void) | null = null;
  onSafe: ((index: number) => void) | null = null;
  onRespawn: ((index: number) => void) | null = null;

  constructor(
    private player: PlayerController,
    private visual: LizardVisual,
    private herons: Herons,
    private log: DriftLog,
    swimmers: Swimmers,
  ) {
    const free = () => this.state === 'ready' || this.state === 'running';
    this.prey = {
      feet: (out) => player.feetAt(1, out),
      facing: () => player.yaw,
      speed: () => player.horizontalSpeed,
      swimming: () => player.swimming,
      huntable: () => {
        if (!free()) return false;
        player.feetAt(1, this.feet);
        return safePointAt(this.feet.x, this.feet.z) < 0;
      },
      caught: (by) => this.caught(by),
    };
    herons.onLose = (_h, why) => {
      if (why === 'tangle') this.hid = true;
      else if (why === 'deep') this.dove = true;
      else if (why === 'away') this.slipped = true;
    };
    const specs: GoalSpec[] = [
      { id: 'safe', label: "Shelter in the old mangroves' roots", met: () => this.checkpoint >= 0 },
      { id: 'cross', label: 'Cross the channel to the lava field', met: () => this.finishes > 0 },
      { id: 'hide', label: 'Hide in the roots from a stalking heron', met: () => this.hid },
      { id: 'deep', label: 'Escape a heron into deep water', met: () => this.dove },
      { id: 'slip', label: 'Slip away from a stalking heron', met: () => this.slipped },
      { id: 'channel', label: 'Float the driftwood out into the channel', met: () => log.reachedChannel > 0 },
      { id: 'bridge', label: 'Jam the log across the narrows', met: () => log.state === 'jammed' },
      { id: 'ride', label: 'Ride the drifting log', met: () => log.ridden >= RIDE },
      { id: 'shark', label: 'Swim beside a shark pup', met: () => swimmers.nearShark },
      { id: 'rays', label: 'Swim with the golden rays', met: () => swimmers.nearRay },
    ];
    this.goals = new Goals(specs);
  }

  get danger(): 'none' | 'watched' | 'chased' {
    if (this.state !== 'running' && this.state !== 'ready') return 'none';
    return this.herons.danger;
  }

  get held() {
    return this.state === 'caught';
  }

  get safe() {
    this.player.feetAt(1, this.feet);
    return safePointAt(this.feet.x, this.feet.z) >= 0;
  }

  private caught(by: Heron) {
    if (this.state !== 'running' && this.state !== 'ready') return;
    this.state = 'caught';
    this.catches++;
    this.caughtLeft = CAUGHT_TIME;
    this.visual.downed = true;
    this.onCaught?.(by);
  }

  private respawn() {
    const p = SAFE_POINTS[this.checkpoint];
    this.state = 'running';
    this.visual.downed = false;
    this.player.setFeet(this.feet.set(p.x, terrainHeight(p.x, p.z), p.z), p.yaw);
    this.herons.callOff();
    this.onRespawn?.(this.checkpoint);
  }

  /** Back at the start, the clock reset, the log back in its pool, the herons back at their spots. */
  restart() {
    this.state = 'ready';
    this.time = 0;
    this.attempts++;
    this.checkpoint = -1;
    this.visual.downed = false;
    this.player.setFeet(this.feet.set(START.x, terrainHeight(START.x, START.z), START.z), START.yaw);
    this.log.reset();
    this.herons.reset();
    this.onReset?.();
  }

  step(dt: number, moving: boolean) {
    if (this.state === 'ready' && moving) this.state = 'running';
    if (this.state === 'running') {
      this.time += dt;
      this.player.feetAt(1, this.feet);
      const safe = safePointAt(this.feet.x, this.feet.z);
      if (safe > this.checkpoint) {
        this.checkpoint = safe;
        this.herons.callOff();
        this.onSafe?.(safe);
      }
      if (Math.hypot(this.feet.x - FINISH.x, this.feet.z - FINISH.z) < FINISH.r) {
        this.state = 'home';
        this.finishes++;
        if (this.best === null || this.time < this.best) this.best = this.time;
        this.herons.callOff();
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
