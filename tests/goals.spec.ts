import { test, expect } from '@playwright/test';
import { bootGame } from './helpers/bootGame';
import { screenshot } from './helpers/screenshot';

test('the goals tab lists one unticked goal per creature, and ticking one off animates it', async ({ page }) => {
  const errors = await bootGame(page);
  const before = await page.evaluate(() => window.__game!.goals());
  expect(before.map((g) => g.id)).toEqual(['hawk', 'tortoise', 'crab', 'iguana', 'algae']);
  expect(before.every((g) => !g.done)).toBe(true);
  const rows = page.locator('.goals .goal');
  await expect(rows).toHaveCount(5);
  await expect(page.locator('.goals .count')).toHaveText('0/5');
  // The tab sits in the bottom-left corner.
  const box = (await page.locator('.goals').boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeLessThan(40);
  expect(box.y + box.height).toBeGreaterThan(view.height - 40);

  // Folded away by its title, it unfolds by itself to show a goal being ticked.
  await page.locator('.goals-head').click();
  await expect(page.locator('.goals-list')).toBeHidden();
  expect(await page.evaluate(() => window.__game!.completeGoal('tortoise'))).toBe(true);
  expect(await page.evaluate(() => window.__game!.completeGoal('tortoise'))).toBe(false);
  await expect(page.locator('.goals-list')).toBeVisible();
  const row = page.locator('.goals .goal[data-goal="tortoise"]');
  await expect(row).toHaveClass(/done/);
  await expect(row).toHaveClass(/just/);
  await expect(page.locator('.goals .count')).toHaveText('1/5');
  await expect(page.locator('.goal-toast')).toHaveClass(/show/);
  await expect(page.locator('.goal-toast')).toContainText('Ride a giant tortoise');
  // Caught mid-pop for people to look at.
  await page.waitForTimeout(250);
  await screenshot(page, 'goals-tick.png');
  expect(await page.evaluate(() => window.__game!.goals().filter((g) => g.done).map((g) => g.id))).toEqual(['tortoise']);
  expect(errors).toEqual([]);
});

test('riding the tortoise for a moment ticks off its goal', async ({ page }) => {
  const errors = await bootGame(page);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const t = g.tortoise();
    g.teleport(t.x, t.z, t.yaw, t.y + 0.16);
    let rode = 0;
    for (let i = 0; i < 120; i++) {
      g.advance(1, false);
      if (g.tortoise().ridden) rode++;
    }
    return { rode, done: g.goals().find((o) => o.id === 'tortoise')!.done };
  });
  expect(r.rode).toBeGreaterThan(60);
  expect(r.done).toBe(true);
  expect(errors).toEqual([]);
});

test('diving out of sight as the hawk stoops dodges it, and once it gives up the hunt the hawk goal is ticked', async ({ page }) => {
  const errors = await bootGame(page, { hawk: true });
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    g.hawkDo('hunt');
    let i = 0;
    for (; i < 60 * 60 && g.hawk().state !== 'stoop'; i++) g.advance(1, false);
    const stooped = g.hawk().state === 'stoop';
    // Down deep in the open sea, east of the shore, where it can't see the lizard.
    const { waterY } = g.ocean();
    const z = 0.2;
    g.teleport(g.shoreX(z) + 1.3, z, Math.PI / 2, waterY - 0.08);
    for (let j = 0; j < 60 && g.hawk().state === 'stoop'; j++) g.advance(1, false);
    g.advance(1, false);
    const goal = () => g.goals().find((o) => o.id === 'hawk')!.done;
    // Dodging one dive isn't surviving: the hawk is still after it.
    const dodged = { hawk: g.hawk(), done: goal() };
    // Out of sight it loses interest within a few seconds.
    for (let j = 0; j < 6 * 60 && !goal(); j++) g.advance(1, false);
    return { stooped, dodged, hawk: g.hawk(), hits: g.wounds().hits, done: goal() };
  });
  expect(r.stooped).toBe(true);
  expect(r.hits).toBe(0);
  expect(r.dodged.hawk.dodged).toBe(1);
  expect(r.dodged.hawk.survived).toBe(0);
  expect(r.dodged.done).toBe(false);
  expect(r.hawk.survived).toBe(1);
  expect(r.done).toBe(true);
  expect(errors).toEqual([]);
});
