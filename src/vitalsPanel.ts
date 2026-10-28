import type { HudVitals } from './hud';

/** A rate this small (per second) shows no arrow. */
const STEADY = 0.0005;

/** The bars in the bottom-right corner for health, warmth, food and air; returns the function that sets them. */
export function createVitalsPanel(): (v: HudVitals) => void {
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

  return (v: HudVitals) => {
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
  };
}

/** A red flash round the edges of the screen as a strike lands; returns the function that sets it off. */
export function createHitFlash(): () => void {
  const flash = document.createElement('div');
  flash.style.cssText =
    'position:fixed;inset:0;pointer-events:none;opacity:0;' +
    'background:radial-gradient(ellipse at center,transparent 45%,rgba(160,20,10,0.6) 100%)';
  document.body.appendChild(flash);

  return () => {
    // Show at once, then fade.
    flash.style.transition = 'none';
    flash.style.opacity = '1';
    void flash.offsetWidth;
    flash.style.transition = 'opacity 0.5s ease-out';
    flash.style.opacity = '0';
  };
}

/** The "[F] to eat" prompt over the lizard, shown while algae is within a bite; returns its show/hide. */
export function createEatPrompt(): (show: boolean) => void {
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
  let shown = false;
  return (show) => {
    if (show === shown) return;
    shown = show;
    eat.style.opacity = show ? '1' : '0';
    eat.dataset.shown = show ? '1' : '';
  };
}
