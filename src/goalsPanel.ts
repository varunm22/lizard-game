import type { Goal } from './goals';

const CSS = `
.goals{padding:8px 12px 10px;border-radius:10px;background:#fffc;font:14.4px system-ui,sans-serif;color:#2f3a2a;min-width:220px}
.goals-head{display:flex;justify-content:space-between;align-items:center;gap:12px;font-weight:600;cursor:pointer;pointer-events:auto;user-select:none}
.goals-head .count{font-weight:500;color:#5a6a50;display:inline-block}
.goals-head .count.bump{animation:goal-bump .6s ease-out}
.goals-head .fold{font-size:11px;color:#5a6a50;transition:transform .2s}
.goals.folded .fold{transform:rotate(-90deg)}
.goals.folded .goals-list{display:none}
.goals-list{display:grid;gap:5px;margin-top:7px}
.goal{display:flex;align-items:center;gap:8px;padding:2px 6px;margin:0 -6px;border-radius:6px}
.goal.done .label{color:#5a6a50}
.goal.just{animation:goal-glow 1.8s ease-out}
.goal .box{position:relative;flex:none;width:16px;height:16px;border-radius:4px;border:2px solid #7a8a70;background:#fff8;box-sizing:border-box}
.goal.done .box{border-color:#3a8a3a;background:#4aa84a}
.goal.just .box{animation:goal-pop .55s cubic-bezier(.3,1.6,.5,1)}
.goal .box svg{position:absolute;left:-2px;top:-2px;width:16px;height:16px;overflow:visible}
.goal .box path{fill:none;stroke:#fff;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:16;stroke-dashoffset:16}
.goal.done .box path{stroke-dashoffset:0}
.goal.just .box path{transition:stroke-dashoffset .35s ease-out .18s}
.goal .spark{position:absolute;left:50%;top:50%;width:5px;height:5px;margin:-2.5px;border-radius:50%;opacity:0;pointer-events:none}
.goal.just .spark{animation:goal-spark .7s ease-out .1s}
.goal-toast{position:fixed;left:50%;top:18%;transform:translate(-50%,-50%);padding:10px 18px;border-radius:10px;background:#fffe;
  font:600 19px system-ui,sans-serif;color:#2f5a2a;box-shadow:0 4px 18px #0003;pointer-events:none;opacity:0;white-space:nowrap}
.goal-toast small{display:block;font:500 12px system-ui,sans-serif;color:#5a6a50;text-transform:uppercase;letter-spacing:.08em;text-align:center}
.goal-toast.show{animation:goal-toast 2.8s ease-out forwards}
@keyframes goal-pop{0%{transform:scale(1)}40%{transform:scale(1.6)}100%{transform:scale(1)}}
@keyframes goal-glow{0%{background:#ffd84a00}15%{background:#ffd84acc}100%{background:#ffd84a00}}
@keyframes goal-bump{0%{transform:scale(1)}30%{transform:scale(1.35);color:#2f8a2f}100%{transform:scale(1)}}
@keyframes goal-spark{0%{opacity:1;transform:translate(0,0) scale(1)}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(.3)}}
@keyframes goal-toast{0%{opacity:0;transform:translate(-50%,-30%) scale(.8)}12%{opacity:1;transform:translate(-50%,-50%) scale(1.06)}
  20%{transform:translate(-50%,-50%) scale(1)}80%{opacity:1}100%{opacity:0;transform:translate(-50%,-60%)}}
`;

const SPARK_COLORS = ['#ffd84a', '#4aa84a', '#e8902a', '#3a8ac8'];

/**
 * The goals tab in the bottom-left corner: a checkbox per goal, folded away by clicking its title.
 * A goal met pops its box, draws the tick, throws a few sparks, flashes its row and shows its name
 * big for a moment, so it's plain you just did it.
 */
export function createGoalsPanel(parent: HTMLElement, goals: readonly Goal[]): { done(goal: Goal): void } {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'goals';
  const head = document.createElement('div');
  head.className = 'goals-head';
  const title = document.createElement('span');
  title.textContent = 'Goals';
  const right = document.createElement('span');
  const count = document.createElement('span');
  count.className = 'count';
  const fold = document.createElement('span');
  fold.className = 'fold';
  fold.textContent = ' ▼';
  right.append(count, fold);
  head.append(title, right);
  head.addEventListener('click', () => panel.classList.toggle('folded'));
  const list = document.createElement('div');
  list.className = 'goals-list';
  panel.append(head, list);
  parent.appendChild(panel);

  const rows = new Map<string, HTMLElement>();
  for (const g of goals) {
    const row = document.createElement('div');
    row.className = 'goal';
    row.dataset.goal = g.id;
    const box = document.createElement('span');
    box.className = 'box';
    box.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 8.5l2.6 2.6L12 5.5"/></svg>';
    for (let i = 0; i < 8; i++) {
      const spark = document.createElement('span');
      spark.className = 'spark';
      const a = (i / 8) * Math.PI * 2 + 0.3;
      spark.style.setProperty('--dx', `${Math.cos(a) * 22}px`);
      spark.style.setProperty('--dy', `${Math.sin(a) * 22}px`);
      spark.style.background = SPARK_COLORS[i % SPARK_COLORS.length];
      box.appendChild(spark);
    }
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = g.label;
    row.append(box, label);
    list.appendChild(row);
    rows.set(g.id, row);
  }

  const toast = document.createElement('div');
  toast.className = 'goal-toast';
  document.body.appendChild(toast);

  const showCount = () => {
    count.textContent = `${goals.filter((g) => g.done).length}/${goals.length}`;
  };
  showCount();
  // Restart a CSS animation on an element that may still be playing it.
  const replay = (el: HTMLElement, cls: string) => {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  };

  return {
    done(goal) {
      const row = rows.get(goal.id);
      if (!row) return;
      // Unfold to show it being ticked.
      panel.classList.remove('folded');
      row.classList.add('done');
      replay(row, 'just');
      showCount();
      replay(count, 'bump');
      const all = goals.every((g) => g.done);
      toast.innerHTML = '';
      const small = document.createElement('small');
      small.textContent = all ? 'All goals done!' : 'Goal complete';
      toast.append(small, `✓ ${goal.label}`);
      replay(toast, 'show');
    },
  };
}
