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
 * A small controls hint in the corner that fades once the player starts moving; bars in the other
 * corner for health, warmth, food and air; a red flash round the edges as a strike lands; and the
 * countdown while it lies knocked down.
 */
export function createHud(): {
  hideHint(): void;
  vitals(v: HudVitals): void;
  down(countdown: number | null): void;
  flash(): void;
} {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;left:16px;bottom:16px;padding:6px 10px;border-radius:6px;background:#fffc;' +
    'font:14px system-ui,sans-serif;color:#2f3a2a;transition:opacity 1.5s;pointer-events:none';
  el.textContent = 'W/S move · A/D steer, or look around when still · Shift run · Space jump, or tilt up when swimming · F bite · drag or Q/E orbit · wheel zoom';
  document.body.appendChild(el);

  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;right:16px;bottom:16px;padding:8px 10px;border-radius:8px;background:#fffc;' +
    'font:12px system-ui,sans-serif;color:#2f3a2a;display:grid;grid-template-columns:auto 120px 10px;' +
    'gap:5px 8px;align-items:center;pointer-events:none';
  document.body.appendChild(panel);
  const bar = (label: string, color: string) => {
    const name = document.createElement('div');
    name.textContent = label;
    const track = document.createElement('div');
    track.style.cssText = 'height:9px;border-radius:5px;background:#0002;overflow:hidden';
    const fill = document.createElement('div');
    fill.style.cssText = `height:100%;width:100%;border-radius:5px;background:${color}`;
    track.appendChild(fill);
    const trend = document.createElement('div');
    trend.style.cssText = 'font-size:9px;line-height:1;text-align:center';
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

  const flash = document.createElement('div');
  flash.style.cssText =
    'position:fixed;inset:0;pointer-events:none;opacity:0;' +
    'background:radial-gradient(ellipse at center,transparent 45%,rgba(160,20,10,0.6) 100%)';
  document.body.appendChild(flash);

  return {
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
