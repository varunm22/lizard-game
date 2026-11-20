import { LEVEL, type Level } from './level';

/**
 * How many side goals each stage has, for the stage picker's bars before a stage has been played.
 * The stage's objective, the one thing that finishes it, isn't one of them (`objective.ts`).
 */
export const GOAL_COUNT: Record<Level, number> = { island: 6, dunes: 3, lagoon: 4, tunnels: 3 };

const key = (level: Level) => `lizard-goals-${level}`;
const objectiveKey = (level: Level) => `lizard-objective-${level}`;

/** The goal each stage once had for finishing it, before the objective was split out of the goals. */
const OLD_FINISH_GOAL: Partial<Record<Level, string>> = { dunes: 'shore', lagoon: 'cross', tunnels: 'out' };

function read(level: Level): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(key(level)) ?? '[]');
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** The goals ticked off on `level` so far, kept in the browser across visits. */
export function goalsDone(level: Level = LEVEL): string[] {
  const old = OLD_FINISH_GOAL[level];
  return old ? read(level).filter((id) => id !== old) : read(level);
}

export function saveGoalsDone(ids: string[], level: Level = LEVEL) {
  try {
    localStorage.setItem(key(level), JSON.stringify(ids));
  } catch {
    // Storage blocked: they start over next visit.
  }
}

/** Whether `level`'s objective has been done on some visit; a finish ticked as a goal before the split counts. */
export function objectiveDone(level: Level = LEVEL): boolean {
  try {
    if (localStorage.getItem(objectiveKey(level)) === '1') return true;
  } catch {
    return false;
  }
  const old = OLD_FINISH_GOAL[level];
  return old !== undefined && read(level).includes(old);
}

export function saveObjectiveDone(level: Level = LEVEL) {
  try {
    localStorage.setItem(objectiveKey(level), '1');
  } catch {
    // Storage blocked.
  }
}
