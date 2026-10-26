import { LEVEL } from './level';
import { GOAL_COUNT, goalsDone, saveGoalsDone } from './progress';

/** One thing to do on the island, met once `met` has held for `hold` seconds. */
export interface GoalSpec {
  id: string;
  label: string;
  met: () => boolean;
  /** How long (s) it must keep being met before it counts; 0 counts at once. */
  hold?: number;
}

export interface Goal {
  id: string;
  label: string;
  done: boolean;
}

/**
 * The stage's goals list, each ticked off for good the first time it's met. What's been ticked is
 * kept in the browser (`progress.ts`), so a stage comes back with its goals as they were left and
 * the stage picker can show how far along each is.
 */
export class Goals {
  readonly list: Goal[];
  /** Called once as each goal is met. */
  onDone: ((goal: Goal) => void) | null = null;
  private held: number[];

  constructor(private specs: GoalSpec[]) {
    this.list = specs.map((s) => ({ id: s.id, label: s.label, done: false }));
    this.held = specs.map(() => 0);
    // Tests catch the picker's count going stale.
    if (specs.length !== GOAL_COUNT[LEVEL] && new URLSearchParams(location.search).has('test')) throw new Error(`${LEVEL} has ${specs.length} goals, GOAL_COUNT says ${GOAL_COUNT[LEVEL]}`);
    const done = goalsDone();
    for (const goal of this.list) goal.done = done.includes(goal.id);
    // Goals a stage no longer has don't count toward its bar in the picker.
    const kept = this.list.filter((g) => g.done).map((g) => g.id);
    if (kept.length !== done.length) saveGoalsDone(kept);
  }

  step(dt: number) {
    this.specs.forEach((s, i) => {
      const goal = this.list[i];
      if (goal.done) return;
      this.held[i] = s.met() ? this.held[i] + dt : 0;
      if (this.held[i] >= (s.hold ?? 0) && this.held[i] > 0) this.complete(goal);
    });
  }

  /** Tick a goal off now (tests and screenshots). */
  complete(goal: Goal) {
    if (goal.done) return;
    goal.done = true;
    saveGoalsDone(this.list.filter((g) => g.done).map((g) => g.id));
    this.onDone?.(goal);
  }
}
