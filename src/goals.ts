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
 * The goals list: one per creature (and the algae), each ticked off for good the first time it's
 * met. They start over each time the page loads.
 */
export class Goals {
  readonly list: Goal[];
  /** Called once as each goal is met. */
  onDone: ((goal: Goal) => void) | null = null;
  private held: number[];

  constructor(private specs: GoalSpec[]) {
    this.list = specs.map((s) => ({ id: s.id, label: s.label, done: false }));
    this.held = specs.map(() => 0);
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
    this.onDone?.(goal);
  }
}
