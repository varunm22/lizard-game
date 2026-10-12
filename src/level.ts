/** Which level this page plays: the island (the default) or the nesting dunes (`?level=dunes`). */
export type Level = 'island' | 'dunes';

const KEY = 'lizard-level';

function chosen(): Level {
  const param = new URLSearchParams(location.search).get('level');
  if (param) return param === 'dunes' ? 'dunes' : 'island';
  // Where the URL can't carry it (an embedded preview), the switch remembers it for the tab.
  try {
    return sessionStorage.getItem(KEY) === 'dunes' ? 'dunes' : 'island';
  } catch {
    return 'island';
  }
}

export const LEVEL: Level = chosen();

/** A small link in the top-right corner to the other level (not in tests). */
export function levelSwitch() {
  if (new URLSearchParams(location.search).has('test')) return;
  const other: Level = LEVEL === 'dunes' ? 'island' : 'dunes';
  const a = document.createElement('a');
  a.textContent = other === 'dunes' ? 'Nesting dunes →' : '← Island';
  a.href = `?level=${other}`;
  a.style.cssText =
    'position:fixed;right:16px;top:12px;padding:5px 12px;border-radius:9px;background:#fffc;font:600 14px system-ui,sans-serif;' +
    'color:#2f3a2a;text-decoration:none;z-index:10';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    try {
      sessionStorage.setItem(KEY, other);
    } catch {
      // Storage blocked: the URL alone carries it.
    }
    const params = new URLSearchParams(location.search);
    params.set('level', other);
    location.search = params.toString();
  });
  document.body.appendChild(a);
}
