/**
 * The beach's own bits of screen, beside the run's (`createDunesHud`): the shoving bar while locked
 * head to head with a rival (how far each has pushed, and when he eases off for a butt), and a ring
 * filling as the lizard claims a vacant rock.
 */
export interface BeachHud {
  /** The match's push (-1 lost, 1 won), and whether he's easing off now; null hides it. */
  shove(push: number | null, easing: boolean): void;
  /** How far through claiming a rock (0 to 1), or null. */
  claim(t: number | null): void;
}

const CSS = `
.beach-shove{position:fixed;left:50%;top:118px;transform:translateX(-50%);width:min(320px,calc(100vw - 32px));padding:8px 12px 10px;
  border-radius:12px;background:#fffffff0;box-shadow:0 4px 16px #0003;font:600 14px system-ui,sans-serif;color:#3a3326;text-align:center;
  pointer-events:none;opacity:0;transition:opacity .2s}
.beach-shove.show{opacity:1}
.beach-shove .bar{position:relative;height:14px;margin-top:6px;border-radius:7px;background:linear-gradient(90deg,#d9826a,#eee6d6 50%,#6fb3a8)}
.beach-shove .mid{position:absolute;left:50%;top:-3px;bottom:-3px;width:2px;background:#3a3326}
.beach-shove .knob{position:absolute;top:-4px;width:12px;height:22px;margin-left:-6px;border-radius:5px;background:#3a3326}
.beach-shove .hint{margin-top:6px;font:500 13px system-ui,sans-serif;color:#6a5a40}
.beach-shove .hint.butt{color:#1d7a6a;font-weight:700}
.beach-claim{position:fixed;left:50%;top:40%;transform:translate(-50%,-50%);width:54px;height:54px;border-radius:50%;pointer-events:none;
  opacity:0;transition:opacity .2s}
.beach-claim.show{opacity:1}
`;

export function createBeachHud(): BeachHud {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const box = document.createElement('div');
  box.className = 'beach-shove';
  box.innerHTML = 'Shove! <div class="bar"><div class="mid"></div><div class="knob"></div></div><div class="hint"></div>';
  document.body.appendChild(box);
  const knob = box.querySelector('.knob') as HTMLElement;
  const hint = box.querySelector('.hint') as HTMLElement;
  const ring = document.createElement('div');
  ring.className = 'beach-claim';
  document.body.appendChild(ring);
  let lastEasing: boolean | null = null;
  return {
    shove(push, easing) {
      box.classList.toggle('show', push !== null);
      if (push === null) return;
      knob.style.left = `${(50 + 50 * Math.max(-1, Math.min(1, push))).toFixed(1)}%`;
      if (easing === lastEasing) return;
      lastEasing = easing;
      hint.classList.toggle('butt', easing);
      hint.textContent = easing ? 'He eases off: Space to butt!' : 'Hold W to push back';
    },
    claim(t) {
      ring.classList.toggle('show', t !== null);
      if (t === null) return;
      const deg = Math.round(360 * t);
      ring.style.background = `conic-gradient(#6fb3a8 ${deg}deg, #fff8 ${deg}deg)`;
      ring.style.mask = ring.style.webkitMask = 'radial-gradient(circle, transparent 18px, #000 19px)';
    },
  };
}
