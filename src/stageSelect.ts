import { goToLevel, LEVEL, type Level } from './level';
import islandTile from './assets/stages/island.jpg';
import dunesTile from './assets/stages/dunes.jpg';
import lagoonTile from './assets/stages/lagoon.jpg';

/** The stages, in the order the picker shows them, each with a still from the game. */
const STAGES: { id: Level; name: string; blurb: string; image: string }[] = [
  { id: 'island', name: 'Galápagos island', blurb: 'Roam the shore and the reef: iguanas, crabs, the tortoise and the hawk.', image: islandTile },
  { id: 'dunes', name: 'Nesting dunes', blurb: 'Hatch, then cross the dunes to the colony past the racer snakes.', image: dunesTile },
  { id: 'lagoon', name: 'Mangrove lagoon', blurb: 'Slip past the lava herons and float a log across the channel.', image: lagoonTile },
];

const CSS = `
.stage-button{position:fixed;right:16px;top:12px;padding:6px 14px;border:0;border-radius:9px;background:#fffc;cursor:pointer;
  font:600 14px system-ui,sans-serif;color:#2f3a2a;z-index:10;box-shadow:0 2px 8px #0002}
.stage-button:hover{background:#fff}
.stage-modal{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:16px;
  background:#1d241acc;opacity:0;pointer-events:none;transition:opacity .2s}
.stage-modal.open{opacity:1;pointer-events:auto}
.stage-panel{position:relative;width:min(760px,100%);max-height:100%;overflow:auto;box-sizing:border-box;padding:18px 20px 20px;
  border-radius:14px;background:#fbf8ef;box-shadow:0 10px 40px #0005;transform:translateY(8px) scale(.98);transition:transform .2s}
.stage-modal.open .stage-panel{transform:none}
.stage-panel h2{margin:0 0 14px;font:700 20px system-ui,sans-serif;color:#2f3a2a}
.stage-close{position:absolute;right:12px;top:10px;width:32px;height:32px;border:0;border-radius:8px;background:none;cursor:pointer;
  font:22px/1 system-ui,sans-serif;color:#5a6a50}
.stage-close:hover{background:#0000000f}
.stage-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
.stage-tile{display:flex;flex-direction:column;padding:0;border:2px solid transparent;border-radius:12px;overflow:hidden;
  background:#fff;cursor:pointer;text-align:left;font:inherit;color:inherit;box-shadow:0 2px 10px #0001;transition:transform .15s,box-shadow .15s,border-color .15s}
.stage-tile:hover,.stage-tile:focus-visible{transform:translateY(-2px);box-shadow:0 6px 18px #0002;border-color:#c8901a;outline:none}
.stage-tile.current{border-color:#4aa84a}
.stage-tile img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover}
.stage-tile .info{padding:10px 12px 12px}
.stage-tile .name{display:flex;justify-content:space-between;align-items:center;gap:8px;font:600 16px system-ui,sans-serif;color:#2f3a2a}
.stage-tile .badge{font:600 11px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:#fff;background:#4aa84a;
  padding:2px 7px;border-radius:6px}
.stage-tile .blurb{margin-top:4px;font:13.5px/1.4 system-ui,sans-serif;color:#5a6a50}
`;

/**
 * The "Select stage" button in the top-right corner and the picker it opens: a tile per stage with
 * a still from it, the one being played marked. Picking another loads it; Escape, the close button
 * or a click outside the panel shuts it. Not in tests.
 */
export function stageSelect() {
  if (new URLSearchParams(location.search).has('test')) return;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const button = document.createElement('button');
  button.className = 'stage-button';
  button.textContent = 'Select stage';
  document.body.appendChild(button);

  const modal = document.createElement('div');
  modal.className = 'stage-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Select stage');
  const panel = document.createElement('div');
  panel.className = 'stage-panel';
  const title = document.createElement('h2');
  title.textContent = 'Select stage';
  const close = document.createElement('button');
  close.className = 'stage-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  const grid = document.createElement('div');
  grid.className = 'stage-grid';
  for (const stage of STAGES) {
    const tile = document.createElement('button');
    tile.className = 'stage-tile';
    tile.dataset.stage = stage.id;
    const img = document.createElement('img');
    img.src = stage.image;
    img.alt = '';
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.append(stage.name);
    if (stage.id === LEVEL) {
      tile.classList.add('current');
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'Playing';
      name.append(badge);
    }
    const blurb = document.createElement('div');
    blurb.className = 'blurb';
    blurb.textContent = stage.blurb;
    info.append(name, blurb);
    tile.append(img, info);
    tile.addEventListener('click', () => {
      if (stage.id === LEVEL) setOpen(false);
      else goToLevel(stage.id);
    });
    grid.append(tile);
  }
  panel.append(close, title, grid);
  modal.append(panel);
  document.body.appendChild(modal);

  const setOpen = (open: boolean) => {
    modal.classList.toggle('open', open);
    // Focus off the button (Space jumps), onto the current tile while open, and off the tiles once shut.
    if (open) (grid.querySelector('.current') as HTMLElement | null)?.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  };
  button.addEventListener('click', () => {
    button.blur();
    setOpen(true);
  });
  close.addEventListener('click', () => setOpen(false));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) setOpen(false);
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && modal.classList.contains('open')) setOpen(false);
  });
}
