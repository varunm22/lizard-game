import { createHitFlash, createVitalsPanel } from './vitalsPanel';

/** What the bars show, each 0 to 1, with the way health and warmth are heading (per second). */
export interface HudVitals {
  health: number;
  warmth: number;
  fullness: number;
  air: number;
  healthRate: number;
  warmthRate: number;
}

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

  const vitalsPanel = createVitalsPanel();

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

  const flash = createHitFlash();

  return {
    corner,
    hideHint() {
      el.style.opacity = '0';
    },
    flash,
    vitals: vitalsPanel,
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
