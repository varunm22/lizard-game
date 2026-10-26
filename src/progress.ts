import { LEVEL, type Level } from './level';

/** How many goals each stage has, for the stage picker's bars before a stage has been played. */
export const GOAL_COUNT: Record<Level, number> = { island: 6, dunes: 4, lagoon: 10, tunnels: 7 };

const key = (level: Level) => `lizard-goals-${level}`;

/** The goals ticked off on `level` so far, kept in the browser across visits. */
export function goalsDone(level: Level = LEVEL): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(key(level)) ?? '[]');
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function saveGoalsDone(ids: string[], level: Level = LEVEL) {
  try {
    localStorage.setItem(key(level), JSON.stringify(ids));
  } catch {
    // Storage blocked: they start over next visit.
  }
}
