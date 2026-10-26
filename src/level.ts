/**
 * Which level this page plays: the island (the default), the nesting dunes (`?level=dunes`), the
 * mangrove lagoon (`?level=lagoon`) or the lava tunnels (`?level=tunnels`).
 */
export type Level = 'island' | 'dunes' | 'lagoon' | 'tunnels';

/** The stages, in the order they're played. */
export const LEVELS: readonly Level[] = ['island', 'dunes', 'lagoon', 'tunnels'];

export const LEVEL_NAMES: Record<Level, string> = {
  island: 'Galápagos island',
  dunes: 'Nesting dunes',
  lagoon: 'Mangrove lagoon',
  tunnels: 'Lava tunnels',
};

/** The stage after `level`; after the last, back to the first. */
export const nextLevel = (level: Level): Level => LEVELS[(LEVELS.indexOf(level) + 1) % LEVELS.length];

const known = (name: string | null): Level => (LEVELS as readonly (string | null)[]).includes(name) ? (name as Level) : 'island';

const KEY = 'lizard-level';

function chosen(): Level {
  const param = new URLSearchParams(location.search).get('level');
  if (param) return known(param);
  // Where the URL can't carry it (an embedded preview), the stage picker remembers it for the tab.
  try {
    return known(sessionStorage.getItem(KEY));
  } catch {
    return 'island';
  }
}

export const LEVEL: Level = chosen();

/** Load `level`, remembering it for the tab where the URL can't carry it (an embedded preview). */
export function goToLevel(level: Level) {
  try {
    sessionStorage.setItem(KEY, level);
  } catch {
    // Storage blocked: the URL alone carries it.
  }
  const params = new URLSearchParams(location.search);
  params.set('level', level);
  location.search = params.toString();
}
