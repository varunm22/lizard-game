import { expect, test } from '@playwright/test';
import { bootGame } from './helpers/bootGame';
import { screenshot } from './helpers/screenshot';

test('the start card says what the bars are, and goes once the lizard moves; the objective says what to do', async ({ page }) => {
  const errors = await bootGame(page);
  const intro = page.locator('.island-intro');
  await expect(intro).toContainText('Health');
  await expect(intro).toContainText('Warmth');
  await expect(intro).toContainText('Food');
  await expect(intro).toContainText('Air');
  await expect(intro).not.toHaveClass(/hidden/);
  await expect(page.locator('.objective')).toContainText('Cross the lava crack');
  await page.evaluate(() => {
    const g = window.__game!;
    g.setInput({ move: { x: 0, y: 1 } }, 30);
    g.advance(40, false);
  });
  await expect(intro).toHaveClass(/hidden/);
  expect(errors).toEqual([]);
});

test('walking into a fig noses it along the ground ahead of the snout', async ({ page }) => {
  const errors = await bootGame(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    g.clearPlants(0.1, 0.05, 0.1, -0.7, 0.15);
    g.teleport(0.1, 0.05, Math.PI);
    g.figPlace(0, 0.105, -0.03);
    g.advance(10, false);
    g.setInput({ move: { x: 0, y: 1 } }, 90);
    g.advance(90, false);
    return { fig: g.figs()[0], snout: g.lizard().snout };
  });
  // It went the way the lizard walked (-Z), most of the way it walked, and is still just ahead of it.
  expect(run.fig.state).toBe('lying');
  expect(run.fig.pushed).toBeGreaterThan(30);
  expect(run.fig.z).toBeLessThan(-0.25);
  expect(run.fig.z).toBeLessThan(run.snout.z);
  expect(Math.abs(run.fig.x - run.snout.x)).toBeLessThan(0.02);
  expect(errors).toEqual([]);
});

test('the tortoise goes for a fig over a nearer flower, and only eats grass when hungry', async ({ page }) => {
  const errors = await bootGame(page);
  const fig = await page.evaluate(() => {
    const g = window.__game!;
    // Out in its meadow, facing +X: a flower a little to its left, a fig further off to its right.
    const [x, z] = [-0.3, 2.1];
    g.clearPlants(x - 0.9, z, x + 0.9, z, 0.6);
    g.tortoisePlace(x, z, Math.PI / 2, 20);
    g.sprout('lecocarpus', x + 0.2, z + 0.25, true);
    g.figPlace(0, x + 0.45, z - 0.6);
    g.advance(20, false);
    const first = g.tortoise().heading;
    const d0 = Math.hypot(g.tortoise().x - (x + 0.45), g.tortoise().z - (z - 0.6));
    g.advance(8 * 60, false);
    const t = g.tortoise();
    return { first, d0, d1: Math.hypot(t.x - (x + 0.45), t.z - (z - 0.6)) };
  });
  expect(fig.first?.kind).toBe('fig');
  expect(fig.d1).toBeLessThan(fig.d0 - 0.12);

  const grass = await page.evaluate(() => {
    const g = window.__game!;
    const [x, z] = [-0.9, 2.4];
    g.clearPlants(x - 0.5, z, x + 0.5, z, 0.4);
    // Just eaten: grass right at its mouth doesn't tempt it.
    g.tortoisePlace(x, z, 0, 0);
    const m = g.tortoise().mouth;
    g.sprout('grass', m.x, m.z + 0.05, true);
    g.advance(60, false);
    const fed = g.tortoise().heading?.kind;
    // Hungry, it goes for it and eats it.
    g.tortoisePlace(x, z, 0, 60);
    g.sprout('grass', m.x, m.z + 0.05, true);
    g.advance(30, false);
    const hungry = g.tortoise().heading?.kind;
    let ate = false;
    for (let s = 0; s < 8 * 60 && !ate; s += 30) {
      g.advance(30, false);
      ate = g.tortoise().sinceMeal < 1;
    }
    return { fed, hungry, ate };
  });
  expect(grass.fed).toBe('wander');
  expect(grass.hungry).toBe('plant');
  expect(grass.ate).toBe(true);
  expect(errors).toEqual([]);
});

test('led to a fig at the dead tree, the tortoise knocks the tree down across the crack, and the lizard walks over it to finish', async ({ page }) => {
  const errors = await bootGame(page);
  const knock = await page.evaluate(() => {
    const g = window.__game!;
    const s = g.snag();
    // A fig at the foot of the dead tree, the tortoise coming up the trail toward it.
    g.figPlace(0, s.x + 0.07, s.z);
    g.tortoisePlace(s.x + 0.55, s.z + 0.12, -Math.PI / 2 - 0.2, 10);
    const states: string[] = [];
    for (let k = 0; k < 24 && g.snag().state !== 'fallen'; k++) {
      g.advance(60, false);
      states.push(g.snag().state);
    }
    g.advance(30, false);
    const c = g.crack(s.z);
    return { snag: g.snag(), crack: c, progress: g.islandRun().progress, hint: g.islandRun().hint, onBridge: g.groundAt(c.x, s.z)! - g.terrainHeight(c.x, s.z) };
  });
  expect(knock.snag.state).toBe('fallen');
  // Lying across the crack, its tip on the far rim, and something to stand on over the middle.
  expect(knock.snag.tip.x).toBeLessThan(knock.crack.x - knock.crack.half);
  expect(knock.onBridge).toBeGreaterThan(knock.crack.depth * 0.8);
  expect(knock.progress).toBe('bridged');
  expect(knock.hint).toContain('Walk over');

  const cross = await page.evaluate(() => {
    const g = window.__game!;
    const s = g.snag();
    g.clearPlants(s.x + 0.3, s.z, s.x - 0.9, s.z, 0.1);
    g.teleport(s.x + 0.12, s.z, -Math.PI / 2);
    g.advance(20, false);
    g.setInput({ move: { x: 0, y: 1 } }, 5 * 60);
    let lowest = Infinity;
    for (let k = 0; k < 5 * 60 && g.islandRun().state !== 'home'; k++) {
      g.advance(1, false);
      lowest = Math.min(lowest, g.player().y);
    }
    g.setInput(null);
    return { run: g.islandRun(), lowest, rim: g.terrainHeight(s.x, s.z) };
  });
  // Over without dropping in, and the stage is done.
  expect(cross.lowest).toBeGreaterThan(cross.rim - 0.03);
  expect(cross.run.falls).toBe(0);
  expect(cross.run.state).toBe('home');
  await expect(page.locator('.island-message')).toHaveClass(/show/);
  await expect(page.locator('.island-message')).toContainText('next:');
  await screenshot(page, 'crossing-home.png');
  expect(errors).toEqual([]);
});

test('the crack is too wide to jump: a lizard that falls in is back up on the rim it went in from', async ({ page }) => {
  const errors = await bootGame(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    const z = -0.2;
    const c = g.crack(z);
    g.clearPlants(c.x + c.half + 0.6, z, c.x, z, 0.1);
    g.teleport(c.x + c.half + 0.35, z, -Math.PI / 2);
    g.advance(20, false);
    // A running jump at it.
    g.setInput({ move: { x: 0, y: 1 }, run: true }, 2 * 60);
    let deepest = Infinity;
    for (let k = 0; k < 2 * 60; k++) {
      if (k === 30) g.setInput({ move: { x: 0, y: 1 }, run: true, jump: true }, 90);
      g.advance(1, false);
      deepest = Math.min(deepest, g.player().y - g.terrainHeight(c.x + c.half + 0.3, z));
    }
    g.setInput(null);
    g.advance(60, false);
    return { run: g.islandRun(), p: g.player(), c, deepest };
  });
  expect(run.deepest).toBeLessThan(-0.1);
  expect(run.run.falls).toBe(1);
  expect(run.run.state).toBe('playing');
  // Back on the colony's side, by the rim, on its feet.
  expect(run.p.x).toBeGreaterThan(run.c.x + run.c.half);
  // (It may have run on a little, facing away from the crack.)
  expect(run.p.x).toBeLessThan(run.c.x + run.c.half + 0.5);
  expect(run.p.grounded).toBe(true);
  expect(errors).toEqual([]);
});
