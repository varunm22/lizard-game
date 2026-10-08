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
} {
  const corner = document.createElement('div');
  corner.style.cssText =
    'position:fixed;left:16px;bottom:16px;display:flex;flex-direction:column;align-items:flex-start;gap:8px;pointer-events:none';
  document.body.appendChild(corner);
  // The controls, in one short row at the bottom in the middle; they stay 3 s once it moves, then fade.
  const el = document.createElement('div');
  el.className = 'controls-hint';
  el.style.cssText =
    'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);padding:6px 14px;border-radius:10px;background:#fffc;' +
    'font:14px system-ui,sans-serif;color:#2f3a2a;display:flex;flex-wrap:wrap;justify-content:center;gap:4px 16px;' +
    'max-width:calc(100vw - 32px);box-sizing:border-box;transition:opacity 1.5s ease 3s;pointer-events:none';
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
