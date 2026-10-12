/** Which level this page plays: the island (the default) or the nesting dunes (`?level=dunes`). */
export type Level = 'island' | 'dunes';

const KEY = 'lizard-level';

function chosen(): Level {
  const param = new URLSearchParams(location.search).get('level');
  if (param) return param === 'dunes' ? 'dunes' : 'island';
  // Where the URL can't carry it (an embedded preview), the stage picker remembers it for the tab.
  try {
    return sessionStorage.getItem(KEY) === 'dunes' ? 'dunes' : 'island';
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
