import * as THREE from 'three';
import { Goals, type GoalSpec } from '../goals';
import type { PlayerController } from '../player/controller';
import { FINISH, FLOORS, HOLES, lightAt, overHole, SKYLIGHTS, START, START_Y } from './layout';

export type RunState = 'ready' | 'running' | 'home';

/** Out of the tunnels within this (s) for the quick-run goal. */
const QUICK = 60;
/** Feet within this of a floor's height (m), standing, count as on that floor. */
const ON_FLOOR = 0.05;
/** In this much sun (0 to 1) within this far of a skylight (m) counts as basking under it. */
const BASK_SUN = 0.5;
const BASK_REACH = 0.45;

/**
 * One go through the tunnels, from the sunlit chamber at the west end to the jameo. The clock starts
 * as the lizard first moves; reaching the jameo's floor wins it; R starts over. Also keeps track of
 * the floor the lizard last stood on, to tell a fall through a hole (landing on the lower floor
 * from the upper) from a climb up a rubble pile (standing on the upper floor again, having walked
 * up), and of the gap leapt, and keeps the stage's goals.
 */
export class TunnelsRun {
  state: RunState = 'ready';
  time = 0;
  best: number | null = null;
  attempts = 1;
  finishes = 0;
  /** Falls through a hole, by hole name, and climbs up a rubble pile. */
  readonly drops: string[] = [];
  climbs = 0;
  /** Times the gap was cleared in a jump, landing on the upper floor beyond it. */
  leaps = 0;
  swam = false;
  /** Which skylights the lizard has basked under. */
  readonly basked = SKYLIGHTS.map(() => false);
  readonly goals: Goals;
  /** The floor the lizard last stood on (0 lower, 1 upper), and where it last left the upper floor. */
  private floor = 1;
  private leftUpper = new THREE.Vector3();
  /** Over the gap in the air on this jump. */
  private overGap = false;
  private feet = new THREE.Vector3();
  private lit = { sun: 0, glow: 0 };
  onReset: (() => void) | null = null;
  onHome: (() => void) | null = null;
  onDrop: ((hole: string) => void) | null = null;
  onClimb: (() => void) | null = null;
  onLeap: (() => void) | null = null;

  constructor(private player: PlayerController) {
    const specs: GoalSpec[] = [
      { id: 'drop', label: 'Drop through a hole to the lower tunnels', met: () => this.drops.length > 0 },
      { id: 'climb', label: 'Climb a rubble pile back up through the roof', met: () => this.climbs > 0 },
      { id: 'leap', label: 'Leap the gap at a run', met: () => this.leaps > 0 },
      { id: 'bask', label: `Bask under all ${SKYLIGHTS.length} skylights`, met: () => this.basked.every(Boolean) },
      { id: 'swim', label: 'Swim the flooded tunnel', met: () => this.swam },
      { id: 'out', label: 'Find the way out to the jameo', met: () => this.finishes > 0 },
      { id: 'quick', label: `Get out in under ${QUICK} s`, met: () => this.best !== null && this.best < QUICK },
    ];
    this.goals = new Goals(specs);
  }

  /** Back at the start on the upper floor, the clock reset. */
  restart() {
    this.state = 'ready';
    this.time = 0;
    this.attempts++;
    this.floor = 1;
    this.overGap = false;
    this.player.setFeet(this.feet.set(START.x, START_Y, START.z), START.yaw);
    this.onReset?.();
  }

  /** Which floor feet at height y stand on, or -1 between them (on a rubble pile). */
  static floorOf(y: number): number {
    if (Math.abs(y - FLOORS[1]) < ON_FLOOR) return 1;
    if (y < FLOORS[0] + ON_FLOOR) return 0;
    return -1;
  }

  step(dt: number, moving: boolean) {
    if (this.state === 'ready' && moving) this.state = 'running';
    const p = this.player;
    p.feetAt(1, this.feet);
    if (p.swimming) this.swam = true;
    // In the air over the gap: a leap, if it comes down on the upper floor.
    if (!p.grounded && HOLES.some((h) => h.kind === 'gap' && overHole(this.feet.x, this.feet.z) === h) && this.feet.y > FLOORS[1] - 0.02) this.overGap = true;
    if (p.grounded || p.swimming) {
      const floor = p.swimming ? 0 : TunnelsRun.floorOf(this.feet.y);
      if (floor === 1 && this.overGap) {
        this.leaps++;
        this.onLeap?.();
      }
      this.overGap = false;
      if (floor === 0 && this.floor === 1) {
        const hole = overHole(this.leftUpper.x, this.leftUpper.z, 0.12) ?? overHole(this.feet.x, this.feet.z, 0.05);
        if (hole) {
          this.drops.push(hole.name);
          this.onDrop?.(hole.name);
        }
      } else if (floor === 1 && this.floor === 0) {
        this.climbs++;
        this.onClimb?.();
      }
      if (floor >= 0) this.floor = floor;
      if (floor === 1) this.leftUpper.copy(this.feet);
      if (!p.swimming) {
        lightAt(this.feet.x, this.feet.y + 0.03, this.feet.z, this.lit);
        if (this.lit.sun > BASK_SUN) {
          SKYLIGHTS.forEach((s, i) => {
            if (Math.hypot(this.feet.x - s.x, this.feet.z - s.z) < s.r + BASK_REACH && floor === 1) this.basked[i] = true;
          });
        }
      }
    }
    if (this.state === 'running') {
      this.time += dt;
      if (Math.hypot(this.feet.x - FINISH.x, this.feet.z - FINISH.z) < FINISH.r && this.feet.y < FLOORS[0] + 0.1) {
        this.state = 'home';
        this.finishes++;
        if (this.best === null || this.time < this.best) this.best = this.time;
        this.onHome?.();
      }
    }
    this.goals.step(dt);
  }
}
