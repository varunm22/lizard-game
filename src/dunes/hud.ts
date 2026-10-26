import { goToLevel, LEVEL_NAMES, nextLevel, type Level } from '../level';

/**
 * A run's screen (the dunes', and the lagoon's with its own words): an intro card until the lizard first moves, the run's clock and how far the
 * light is (with an arrow toward it) at the top, a warning while a snake is watching or after the
 * lizard, a big message when it's caught or makes it, and the controls row at the bottom.
 */
export interface DunesHud {
  /** The bottom-left corner, where the goals go. */
  corner: HTMLElement;
  intro(show: boolean): void;
  /** The clock (s) and best time, and the way to the finish: metres and the bearing on screen (radians, 0 straight ahead, positive to the right). */
  status(time: number, best: number | null, distance: number, bearing: number): void;
  /** 'watched' while a snake has its head up at the lizard, 'chased' while one is after it. */
  danger(level: 'none' | 'watched' | 'chased'): void;
  /** A big message, its line of detail, and keys to press with what each does (the end screen's). */
  message(title: string | null, detail?: string, keys?: [string, string][]): void;
  /** Black over the whole screen, from 0 (none) to 1 (all), as a stage is left. */
  fade(amount: number): void;
}

const CSS = `
.dunes-intro{position:fixed;left:50%;top:42%;transform:translate(-50%,-50%);max-width:min(440px,calc(100vw - 32px));box-sizing:border-box;
  padding:16px 20px;border-radius:12px;background:#fffffff0;font:15px/1.45 system-ui,sans-serif;color:#3a3326;box-shadow:0 6px 24px #0003;
  transition:opacity .6s;pointer-events:none}
.dunes-intro h2{margin:0 0 6px;font:700 20px system-ui,sans-serif;color:#5a4a20}
.dunes-intro ul{margin:8px 0 8px 18px;padding:0}
.dunes-intro .go{font-weight:600;color:#8a6a10}
.dunes-intro.hidden{opacity:0}
.dunes-top{position:fixed;left:50%;top:12px;transform:translateX(-50%);display:flex;gap:14px;align-items:center;padding:6px 14px;border-radius:10px;
  background:#fffc;font:600 15px system-ui,sans-serif;color:#3a3326;pointer-events:none;white-space:nowrap}
.dunes-top .best{font-weight:500;color:#7a6a50}
.dunes-top .arrow{display:inline-block;color:#c8901a;font-size:18px;line-height:1}
.dunes-danger{position:fixed;left:50%;top:56px;transform:translateX(-50%);padding:5px 14px;border-radius:9px;font:600 15px system-ui,sans-serif;
  pointer-events:none;opacity:0;transition:opacity .25s;white-space:nowrap}
.dunes-danger.watched{opacity:1;background:#fff3c8f0;color:#7a5a00}
.dunes-danger.chased{opacity:1;background:#ffd6ccf0;color:#9a2a10}
.dunes-edge{position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 90px #c0301800;transition:box-shadow .3s}
.dunes-edge.chased{box-shadow:inset 0 0 90px #c03018aa}
.dunes-message{position:fixed;left:50%;top:30%;transform:translate(-50%,-50%);padding:12px 22px;border-radius:12px;background:#fffffff0;
  text-align:center;font:700 24px system-ui,sans-serif;color:#3a3326;box-shadow:0 6px 24px #0003;pointer-events:none;opacity:0;transition:opacity .3s}
.dunes-message small{display:block;margin-top:4px;font:500 14px system-ui,sans-serif;color:#6a5a40}
.dunes-message.show{opacity:1}
.dunes-message .keys{display:flex;justify-content:center;gap:16px;margin-top:10px;font:500 14px system-ui,sans-serif;color:#3a3326}
.dunes-message kbd{display:inline-block;min-width:1.4em;margin-right:6px;padding:2px 6px;border-radius:6px;border:1px solid #c8b890;
  border-bottom-width:3px;background:#fff;font:700 13px system-ui,sans-serif;color:#3a3326;text-align:center}
.dunes-fade{position:fixed;inset:0;z-index:30;background:#000;opacity:0;pointer-events:none}
`;

const CONTROLS: [string, string][] = [
  ['WASD', 'move'],
  ['Shift', 'run'],
  ['Space', 'jump'],
  ['R', 'restart'],
  ['Q / E', 'camera'],
];

export function clock(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** A stage's own words: the intro card (HTML) and the warnings while watched and chased. */
export interface HudText {
  intro: string;
  watched: string;
  chased: string;
}

/** The keys on the end screen: R for another go, C on to the next stage. */
export const endKeys = (level: Level): [string, string][] => [
  ['R', 'play again'],
  ['C', `next: ${LEVEL_NAMES[nextLevel(level)]}`],
];

/** Load the stage after `level`. */
export const nextStage = (level: Level) => goToLevel(nextLevel(level));

/**
 * R starts the run over at any time; C, once it's won, goes on to the next stage. A stage can play
 * something first with `onContinue`, calling `go` when it's done; C is ignored while it plays.
 */
export function runKeys(level: Level, run: { state: string; restart(): void }, onContinue?: (go: () => void) => void) {
  let leaving = false;
  window.addEventListener('keydown', (e) => {
    if (e.repeat || leaving) return;
    if (e.code === 'KeyR') run.restart();
    else if (e.code === 'KeyC' && run.state === 'home') {
      leaving = true;
      if (onContinue) onContinue(() => nextStage(level));
      else nextStage(level);
    }
  });
}

export const DUNES_TEXT: HudText = {
  intro:
    '<h2>Nesting dunes</h2>' +
    'Reach the adults under the <b>golden light</b>.' +
    '<ul><li>Racers see <b>movement</b>: freeze when one looks up.</li>' +
    '<li>Hide in <b>burrows</b> and under <b>saltbushes</b>.</li></ul>' +
    '<span class="go">Move to start.</span>',
  watched: 'Freeze!',
  chased: 'Run!',
};

export function createDunesHud(text: HudText = DUNES_TEXT): DunesHud {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const corner = document.createElement('div');
  corner.style.cssText = 'position:fixed;left:16px;bottom:16px;display:flex;flex-direction:column;align-items:flex-start;gap:8px;pointer-events:none';
  document.body.appendChild(corner);

  const intro = document.createElement('div');
  intro.className = 'dunes-intro';
  intro.innerHTML = text.intro;
  document.body.appendChild(intro);

  const top = document.createElement('div');
  top.className = 'dunes-top';
  const time = document.createElement('span');
  const best = document.createElement('span');
  best.className = 'best';
  const way = document.createElement('span');
  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = '▲';
  const dist = document.createElement('span');
  way.append(arrow, ' ', dist);
  top.append(time, way, best);
  document.body.appendChild(top);

  const danger = document.createElement('div');
  danger.className = 'dunes-danger';
  document.body.appendChild(danger);
  const edge = document.createElement('div');
  edge.className = 'dunes-edge';
  document.body.appendChild(edge);

  const message = document.createElement('div');
  message.className = 'dunes-message';
  document.body.appendChild(message);

  const fade = document.createElement('div');
  fade.className = 'dunes-fade';
  document.body.appendChild(fade);

  const controls = document.createElement('div');
  controls.style.cssText =
    'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);padding:6px 14px;border-radius:10px;background:#fffc;' +
    'font:14px system-ui,sans-serif;color:#2f3a2a;display:flex;flex-wrap:wrap;justify-content:center;gap:4px 16px;' +
    'width:max-content;max-width:calc(100vw - 32px);box-sizing:border-box;pointer-events:none';
  for (const [keys, does] of CONTROLS) {
    const item = document.createElement('span');
    item.style.whiteSpace = 'nowrap';
    const k = document.createElement('b');
    k.style.fontWeight = '600';
    k.textContent = keys;
    item.append(k, ` ${does}`);
    controls.append(item);
  }
  document.body.appendChild(controls);

  let lastDanger = '';
  return {
    corner,
    intro(show) {
      intro.classList.toggle('hidden', !show);
    },
    status(t, b, d, bearing) {
      time.textContent = clock(t);
      best.textContent = b === null ? '' : `best ${clock(b)}`;
      dist.textContent = `${d.toFixed(1)} m`;
      arrow.style.transform = `rotate(${bearing}rad)`;
    },
    danger(level) {
      if (level === lastDanger) return;
      lastDanger = level;
      danger.className = `dunes-danger ${level}`;
      edge.className = `dunes-edge ${level}`;
      danger.textContent = level === 'watched' ? text.watched : level === 'chased' ? text.chased : '';
    },
    fade(amount) {
      fade.style.opacity = amount.toFixed(3);
    },
    message(title, detail, keys) {
      message.classList.toggle('show', title !== null);
      if (title === null) return;
      message.textContent = title;
      if (detail) {
        const small = document.createElement('small');
        small.textContent = detail;
        message.append(small);
      }
      if (keys) {
        const row = document.createElement('div');
        row.className = 'keys';
        for (const [key, does] of keys) {
          const item = document.createElement('span');
          const k = document.createElement('kbd');
          k.textContent = key;
          item.append(k, does);
          row.append(item);
        }
        message.append(row);
      }
    },
  };
}
