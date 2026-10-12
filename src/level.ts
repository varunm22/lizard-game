/**
 * Which world this page loads: the home island (the default), or the nesting dunes where the
 * lizard hatches and runs for the shore past the racer snakes (`?level=dunes`).
 */
export type Level = 'island' | 'dunes';

export const LEVEL: Level = new URLSearchParams(location.search).get('level') === 'dunes' ? 'dunes' : 'island';
