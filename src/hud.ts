/** What the bars show, each 0 to 1, with the way health and warmth are heading (per second). */
export interface HudVitals {
  health: number;
  warmth: number;
  fullness: number;
  air: number;
  healthRate: number;
  warmthRate: number;
}

/** A rate this small (per second) shows no arrow. */
const STEADY = 0.0005;

/** The card at the start: what each bar in the corner means, and what the stage asks. */
const INTRO =
  '<h2>Galápagos colony</h2>' +
  'Your bars, bottom right:' +
  '<ul><li><b class="health">Health:</b> the hawk and the tortoise\'s feet take it. It mends slowly while you\'re warm and fed.</li>' +
  '<li><b class="warmth">Warmth:</b> lie still in the sun to bask, best on black lava. Cold slows you down.</li>' +
  '<li><b class="food">Food:</b> bite algae in the sea with <b>F</b>. It runs down over time.</li>' +
  '<li><b class="air">Air:</b> runs down under water. Come up before it\'s gone.</li></ul>' +
  'Then find a way over the <b>lava crack</b> in the forest to the west.<br>' +
  '<span class="go">Move to start.</span>';

const CSS = `
.island-intro{position:fixed;left:50%;top:42%;transform:translate(-50%,-50%);max-width:min(460px,calc(100vw - 32px));box-sizing:border-box;
  padding:16px 20px;border-radius:12px;background:#fffffff0;font:15px/1.45 system-ui,sans-serif;color:#2f3a2a;box-shadow:0 6px 24px #0003;
  transition:opacity .6s;pointer-events:none}
.island-intro h2{margin:0 0 6px;font:700 20px system-ui,sans-serif;color:#2f5a2a}
.island-intro ul{margin:8px 0 8px 18px;padding:0}
.island-intro .health{color:#c8402e}.island-intro .warmth{color:#d87a1a}.island-intro .food{color:#4a8a2a}.island-intro .air{color:#3a7ab8}
.island-intro .go{font-weight:600;color:#3a7a2a}
.island-intro.hidden{opacity:0}
.objective{padding:7px 12px 8px;border-radius:10px;background:#fffc;font:14.4px system-ui,sans-serif;color:#2f3a2a;max-width:300px}
.objective .title{font:600 11px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.08em;color:#8a6a10}
.objective .text{font-weight:600}
.objective .hint{font-size:13px;color:#5a6a50;margin-top:2px}
.objective.new{animation:objective-new 1.6s ease-out}
@keyframes objective-new{0%{background:#ffd84a00}15%{background:#ffe38acc}100%{background:#fffc}}
.island-banner{position:fixed;left:50%;top:60px;transform:translateX(-50%);padding:8px 26px;border-radius:14px;font:800 30px system-ui,sans-serif;
  letter-spacing:.02em;box-shadow:0 4px 16px #0003;pointer-events:none;opacity:0;transition:opacity .25s;white-space:nowrap;background:#ffd6ccf0;color:#9a2a10}
.island-banner.show{opacity:1}
.island-message{position:fixed;left:50%;top:30%;transform:translate(-50%,-50%);padding:12px 22px;border-radius:12px;background:#fffffff0;
  text-align:center;font:700 24px system-ui,sans-serif;color:#2f3a2a;box-shadow:0 6px 24px #0003;pointer-events:none;opacity:0;transition:opacity .3s}
.island-message small{display:block;margin-top:4px;font:500 14px system-ui,sans-serif;color:#5a6a50}
.island-message.show{opacity:1}
.island-message .keys{display:flex;justify-content:center;gap:16px;margin-top:10px;font:500 14px system-ui,sans-serif}
.island-message kbd{display:inline-block;min-width:1.4em;margin-right:6px;padding:2px 6px;border-radius:6px;border:1px solid #b8c8a0;
  border-bottom-width:3px;background:#fff;font:700 13px system-ui,sans-serif;color:#2f3a2a;text-align:center}
`;

/**
 * The controls, listed at the bottom in the middle until a few seconds after the player starts
 * moving; the goals (`goalsPanel.ts`) in the bottom-left `corner`; bars in the other
 * corner for health, warmth, food and air; "[F] to eat" while algae is within a bite; a red flash round the edges as a strike lands; and the
 * countdown while it lies knocked down.
 */
export function createHud(): {
  /** The bottom-left corner, where the goals go. */
  corner: HTMLElement;
  hideHint(): void;
  vitals(v: HudVitals): void;
  down(countdown: number | null): void;
  flash(): void;
  /** Show the "[F] to eat" prompt, while algae is within a bite. */
  canEat(show: boolean): void;
  /** The card at the start saying what the bars are, until the lizard first moves. */
  intro(show: boolean): void;
  /** The stage's objective over the goals, and a hint toward it. */
  objective(text: string, hint: string): void;
  /** A big word at the top of the screen (like the dunes' "Freeze!"), e.g. "Stuck!" down in the lava crack; null hides it. */
  banner(text: string | null): void;
  /** Fade the screen to black (0 to 1), as the lizard walks out at the end. */
  fade(amount: number): void;
  /** The end screen: a big message, its line of detail, and keys with what each does; null hides it. */
  message(title: string | null, detail?: string, keys?: [string, string][]): void;
} {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const corner = document.createElement('div');
  corner.style.cssText =
    'position:fixed;left:16px;bottom:16px;display:flex;flex-direction:column;align-items:flex-start;gap:8px;pointer-events:none';
  document.body.appendChild(corner);
  const objective = document.createElement('div');
  objective.className = 'objective';
  const objectiveText = document.createElement('div');
  objectiveText.className = 'text';
  const objectiveHint = document.createElement('div');
  objectiveHint.className = 'hint';
  objective.append(Object.assign(document.createElement('div'), { className: 'title', textContent: 'Objective' }), objectiveText, objectiveHint);
  corner.appendChild(objective);

  const intro = document.createElement('div');
  intro.className = 'island-intro';
  intro.innerHTML = INTRO;
  document.body.appendChild(intro);

  const message = document.createElement('div');
  message.className = 'island-message';
  document.body.appendChild(message);
  const black = document.createElement('div');
  black.style.cssText = 'position:fixed;inset:0;z-index:30;background:#000;opacity:0;pointer-events:none';
  document.body.appendChild(black);
  const shout = document.createElement('div');
  shout.className = 'island-banner';
  document.body.appendChild(shout);
  // The controls, in one short row at the bottom in the middle; they stay 3 s once it moves, then fade.
  // Sized to its content: left at 50% alone would cap it at half the window and wrap it below ~870 px.
  const el = document.createElement('div');
  el.className = 'controls-hint';
  el.style.cssText =
    'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);padding:6px 14px;border-radius:10px;background:#fffc;' +
    'font:14px system-ui,sans-serif;color:#2f3a2a;display:flex;flex-wrap:wrap;justify-content:center;gap:4px 16px;' +
    'width:max-content;max-width:calc(100vw - 32px);box-sizing:border-box;transition:opacity 1.5s ease 3s;pointer-events:none';
  const CONTROLS: [string, string][] = [
    ['WASD', 'move'],
    ['Shift', 'run'],
    ['Space', 'jump'],
    ['F', 'bite'],
    ['Q / E', 'camera'],
  ];
  for (const [keys, does] of CONTROLS) {
    const item = document.createElement('span');
    item.style.whiteSpace = 'nowrap';
    const k = document.createElement('b');
    k.style.fontWeight = '600';
    k.textContent = keys;
    item.append(k, ` ${does}`);
    el.append(item);
  }
  document.body.appendChild(el);

  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;right:16px;bottom:16px;padding:10px 12px;border-radius:10px;background:#fffc;' +
    'font:14.4px system-ui,sans-serif;color:#2f3a2a;display:grid;grid-template-columns:auto 144px 12px;' +
    'gap:6px 10px;align-items:center;pointer-events:none';
  document.body.appendChild(panel);
  const bar = (label: string, color: string) => {
    const name = document.createElement('div');
    name.textContent = label;
    const track = document.createElement('div');
    track.style.cssText = 'height:11px;border-radius:6px;background:#0002;overflow:hidden';
    const fill = document.createElement('div');
    fill.style.cssText = `height:100%;width:100%;border-radius:6px;background:${color}`;
    track.appendChild(fill);
    const trend = document.createElement('div');
    trend.style.cssText = 'font-size:11px;line-height:1;text-align:center';
    panel.append(name, track, trend);
    return { fill, trend, rows: [name, track, trend] };
  };
  const bars = {
    health: bar('Health', '#c8402e'),
    warmth: bar('Warmth', '#e8902a'),
    fullness: bar('Food', '#5a9a3a'),
    air: bar('Air', '#3a8ac8'),
  };
  const arrow = (el: HTMLElement, rate: number) => {
    el.textContent = rate > STEADY ? '▲' : rate < -STEADY ? '▼' : '';
    el.style.color = rate > 0 ? '#3a7a2a' : '#a03020';
  };

  const banner = document.createElement('div');
  banner.style.cssText =
    'position:fixed;left:50%;top:38%;transform:translate(-50%,-50%);padding:10px 18px;border-radius:8px;' +
    'background:#fffd;font:600 20px system-ui,sans-serif;color:#3a2a20;text-align:center;display:none;pointer-events:none';
  document.body.appendChild(banner);
  let shown = '';

  // Over the lizard, just above the middle of the view (it's drawn a little below the middle).
  const eat = document.createElement('div');
  eat.className = 'eat-prompt';
  eat.style.cssText =
    'position:fixed;left:50%;top:44%;transform:translate(-50%,-50%);padding:6px 14px;border-radius:8px;' +
    'background:#fffd;font:600 17px system-ui,sans-serif;color:#2f3a2a;pointer-events:none;' +
    'opacity:0;transition:opacity .15s';
  eat.innerHTML =
    '<span style="display:inline-block;min-width:1.2em;padding:1px 6px;margin-right:6px;border:2px solid #2f3a2a;' +
    'border-radius:5px;text-align:center;font-size:15px">F</span>to eat';
  document.body.appendChild(eat);
  let eatShown = false;

  const flash = document.createElement('div');
  flash.style.cssText =
    'position:fixed;inset:0;pointer-events:none;opacity:0;' +
    'background:radial-gradient(ellipse at center,transparent 45%,rgba(160,20,10,0.6) 100%)';
  document.body.appendChild(flash);

  return {
    corner,
    hideHint() {
      el.style.opacity = '0';
    },
    flash() {
      // Show at once, then fade.
      flash.style.transition = 'none';
      flash.style.opacity = '1';
      void flash.offsetWidth;
      flash.style.transition = 'opacity 0.5s ease-out';
      flash.style.opacity = '0';
    },
    vitals(v) {
      bars.health.fill.style.width = `${v.health * 100}%`;
      bars.warmth.fill.style.width = `${v.warmth * 100}%`;
      // Freezing shows blue, warm enough to run at full speed orange, and in between a mix of the two.
      const t = Math.min(1, Math.max(0, (v.warmth - 0.15) / 0.35));
      const mix = (cold: number, warm: number) => Math.round(cold + (warm - cold) * t);
      bars.warmth.fill.style.background = `rgb(${mix(74, 232)},${mix(144, 144)},${mix(217, 42)})`;
      bars.fullness.fill.style.width = `${v.fullness * 100}%`;
      bars.air.fill.style.width = `${v.air * 100}%`;
      // Air only matters in the water: faint while it's full.
      for (const el of bars.air.rows) el.style.opacity = v.air < 1 ? '1' : '0.35';
      arrow(bars.health.trend, v.healthRate);
      arrow(bars.warmth.trend, v.warmthRate);
    },
    canEat(show) {
      if (show === eatShown) return;
      eatShown = show;
      eat.style.opacity = show ? '1' : '0';
      eat.dataset.shown = show ? '1' : '';
    },
    intro(show) {
      intro.classList.toggle('hidden', !show);
    },
    objective(text, hint) {
      if (objectiveText.textContent !== text) objectiveText.textContent = text;
      if (objectiveHint.textContent !== hint) {
        objectiveHint.textContent = hint;
        // A new hint flashes, so it's seen.
        objective.classList.remove('new');
        void objective.offsetWidth;
        objective.classList.add('new');
      }
    },
    fade(amount) {
      const o = amount.toFixed(3);
      if (black.style.opacity !== o) black.style.opacity = o;
    },
    banner(text) {
      shout.classList.toggle('show', text !== null);
      if (text !== null && shout.textContent !== text) shout.textContent = text;
    },
    message(title, detail, keys) {
      message.classList.toggle('show', title !== null);
      if (title === null) return;
      message.textContent = title;
      if (detail) message.append(Object.assign(document.createElement('small'), { textContent: detail }));
      if (keys) {
        const row = document.createElement('div');
        row.className = 'keys';
        for (const [key, does] of keys) {
          const item = document.createElement('span');
          item.append(Object.assign(document.createElement('kbd'), { textContent: key }), does);
          row.append(item);
        }
        message.append(row);
      }
    },
    down(countdown) {
      const text = countdown === null ? '' : `Respawn in ${countdown}`;
      if (text !== shown) {
        shown = text;
        banner.textContent = text;
        banner.style.display = text ? 'block' : 'none';
      }
    },
  };
}
