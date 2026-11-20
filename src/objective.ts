import { LEVEL } from './level';
import { objectiveDone, saveObjectiveDone } from './progress';

/** What a stage asks, as its run tells it: the one thing that finishes the stage, a hint toward it, and whether it's done this run. */
export interface ObjectiveView {
  text: string;
  hint: string;
  done: boolean;
}

const CSS = `
.objective{padding:7px 12px 8px;border-radius:10px;background:#fffc;font:14.4px system-ui,sans-serif;color:#2f3a2a;max-width:300px;box-sizing:border-box}
.objective .title{display:flex;justify-content:space-between;align-items:center;gap:10px;
  font:600 11px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.08em;color:#8a6a10}
.objective .cleared{display:none;color:#3a8a3a}
.objective.cleared .cleared{display:inline}
.objective .text{font-weight:600}
.objective .hint{font-size:13px;color:#5a6a50;margin-top:2px}
.objective.done .text::before{content:'✓ ';color:#3a8a3a}
.objective.new{animation:objective-new 1.6s ease-out}
@keyframes objective-new{0%{background:#ffd84a00}15%{background:#ffe38acc}100%{background:#fffc}}
`;

/**
 * The stage's objective, in its own box over the goals in the bottom-left corner: the one thing
 * that finishes the stage and a hint toward it, kept apart from the side goals' checklist under it.
 * A new hint flashes, so it's seen. Once the objective has been done on a visit it's kept in the
 * browser (`progress.ts`), and the box and the stage picker both mark the stage cleared.
 */
export function createObjectivePanel(parent: HTMLElement): { show(o: ObjectiveView): void } {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const box = document.createElement('div');
  box.className = 'objective';
  const title = document.createElement('div');
  title.className = 'title';
  title.append(
    Object.assign(document.createElement('span'), { textContent: 'Objective' }),
    Object.assign(document.createElement('span'), { className: 'cleared', textContent: '✓ Cleared' }),
  );
  const text = document.createElement('div');
  text.className = 'text';
  const hint = document.createElement('div');
  hint.className = 'hint';
  box.append(title, text, hint);
  parent.prepend(box);

  let cleared = objectiveDone();
  box.classList.toggle('cleared', cleared);
  return {
    show(o) {
      if (o.done && !cleared) {
        cleared = true;
        saveObjectiveDone(LEVEL);
        box.classList.add('cleared');
      }
      box.classList.toggle('done', o.done);
      if (text.textContent !== o.text) text.textContent = o.text;
      if (hint.textContent !== o.hint) {
        hint.textContent = o.hint;
        box.classList.remove('new');
        void box.offsetWidth;
        box.classList.add('new');
      }
    },
  };
}
