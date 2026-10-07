/**
 * A small controls hint in the corner that fades once the player starts moving; while the hawk has
 * struck, marks for the hits the lizard can still take; and the countdown while it lies knocked down.
 */
export function createHud(): { hideHint(): void; wounds(hits: number, max: number, countdown: number | null): void } {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;left:16px;bottom:16px;padding:6px 10px;border-radius:6px;background:#fffc;' +
    'font:14px system-ui,sans-serif;color:#2f3a2a;transition:opacity 1.5s;pointer-events:none';
  el.textContent = 'W/S move · A/D steer, or look around when still · Shift run · Space jump, or tilt up when swimming · F bite · drag or Q/E orbit · wheel zoom';
  document.body.appendChild(el);

  const marks = document.createElement('div');
  marks.style.cssText =
    'position:fixed;left:16px;top:16px;display:flex;gap:6px;transition:opacity 0.6s;opacity:0;pointer-events:none';
  document.body.appendChild(marks);
  const dots: HTMLElement[] = [];

  const banner = document.createElement('div');
  banner.style.cssText =
    'position:fixed;left:50%;top:38%;transform:translate(-50%,-50%);padding:10px 18px;border-radius:8px;' +
    'background:#fffd;font:600 20px system-ui,sans-serif;color:#3a2a20;text-align:center;display:none;pointer-events:none';
  document.body.appendChild(banner);
  let shown = '';

  return {
    hideHint() {
      el.style.opacity = '0';
    },
    wounds(hits, max, countdown) {
      while (dots.length < max) {
        const d = document.createElement('div');
        d.style.cssText = 'width:14px;height:14px;border-radius:50%;border:2px solid #3a2a20;box-sizing:border-box';
        marks.appendChild(d);
        dots.push(d);
      }
      marks.style.opacity = hits > 0 ? '1' : '0';
      dots.forEach((d, i) => (d.style.background = i < max - hits ? '#e0a83a' : 'transparent'));
      const text = countdown === null ? '' : `Caught by the hawk. Back in ${countdown}…`;
      if (text !== shown) {
        shown = text;
        banner.textContent = text;
        banner.style.display = text ? 'block' : 'none';
      }
    },
  };
}
