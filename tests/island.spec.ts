import { expect, test, type Page } from '@playwright/test';

/** Like the other specs, every test drives time itself with `window.__game.advance`. */
async function boot(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true);
  return errors;
}

test('trees are solid: the lizard can walk into a trunk and round it, never through or up it', async ({ page }) => {
  const errors = await boot(page);
  // A forest tree with open ground for 30 cm south of it (+Z), so the walk up to it is clear.
  const tree = await page.evaluate(() => {
    const g = window.__game!;
    const obstacles = g.obstacles();
    const plants = g.plants();
    return obstacles.find(
      (t) =>
        t.kind === 'tree' &&
        t.x < -1.5 &&
        obstacles.every((o) => o === t || Math.hypot(o.x - t.x, o.z - t.z - 0.2) > o.radius + 0.25) &&
        plants.every((p) => Math.abs(p.x - t.x) > 0.03 || p.z < t.z || p.z > t.z + 0.4),
    )!;
  });
  expect(tree).toBeTruthy();
  expect(tree.height).toBeGreaterThan(0.5);

  const walk = await page.evaluate((t) => {
    const g = window.__game!;
    g.teleport(t.x, t.z + t.radius + 0.25, Math.PI);
    g.advance(20, false);
    const start = g.player();
    g.setInput({ move: { x: 0, y: 1 } }, 240);
    let closest = Infinity;
    let highest = -Infinity;
    let stalled = 0;
    for (let k = 0; k < 240; k++) {
      g.advance(1, k === 239);
      const p = g.player();
      closest = Math.min(closest, Math.hypot(p.x - t.x, p.z - t.z));
      highest = Math.max(highest, p.y - g.terrainHeight(p.x, p.z));
      if (p.speed < 0.1) stalled++;
    }
    g.setInput(null);
    return { start, closest, highest, stalled, end: g.player() };
  }, tree);
  // It met the trunk head on and was held up there (rather than walking on through), its body
  // (1.2 cm half-width) never got inside the bark, and it never left the ground to go up it.
  expect(walk.stalled).toBeGreaterThan(10);
  expect(walk.closest).toBeGreaterThan(tree.radius + 0.012);
  expect(walk.highest).toBeLessThan(0.02);
  expect(walk.end.climbing).toBe(false);
  await page.screenshot({ path: 'test-results/screenshots/forest.png' });
  expect(errors).toEqual([]);
});

test('algae grow on the rocky shore at and under the waterline, and each patch can be removed', async ({ page }) => {
  const errors = await boot(page);
  const { waterY } = await page.evaluate(() => window.__game!.ocean());
  const algae = await page.evaluate(() => window.__game!.algae());
  expect(algae.length).toBeGreaterThan(300);
  expect(new Set(algae.map((a) => a.kind))).toEqual(new Set(['green', 'red']));
  // Only by the sea: every patch is in the splash zone or below it, most of them under water.
  for (const a of algae) expect(a.y).toBeLessThan(waterY + 0.02);
  expect(algae.filter((a) => a.y < waterY).length).toBeGreaterThan(algae.length * 0.7);

  // Swim among them, then take the nearest patch away: it's gone for good and nothing else is.
  const patch = algae.find((a) => a.y < waterY - 0.08)!;
  await page.evaluate(([x, z, y]) => window.__game!.teleport(x - 0.15, z, Math.PI / 2, y), [patch.x, patch.z, patch.y + 0.02]);
  await page.evaluate(() => {
    const g = window.__game!;
    g.viewFrom({ x: -0.12, y: 0.06, z: 0.14 });
    g.advance(5);
  });
  await page.screenshot({ path: 'test-results/screenshots/algae.png' });
  const eaten = await page.evaluate((p) => {
    const g = window.__game!;
    const near = g.algae({ x: p.x, y: p.y, z: p.z, r: 0.05 });
    const before = g.algae().length;
    return { nearest: near[0].id, removed: g.removeAlgae(p.id), again: g.removeAlgae(p.id), left: g.algae(), before };
  }, patch);
  expect(eaten.nearest).toBe(patch.id);
  expect(eaten.removed).toBe(true);
  expect(eaten.again).toBe(false);
  expect(eaten.left.length).toBe(eaten.before - 1);
  expect(eaten.left.some((a) => a.id === patch.id)).toBe(false);
  await page.evaluate(() => window.__game!.advance(1));
  expect(errors).toEqual([]);
});

test('rock piles on the rocky shore can be climbed to the crest, from the lava and out of the sea', async ({ page }) => {
  const errors = await boot(page);
  const runs = await page.evaluate(() => {
    const g = window.__game!;
    const w = g.ocean().waterY;
    /** Walk (or swim, tilting up) along the pile's spine toward +X or -X, steering back onto it; the highest point reached above the water. */
    const climb = (pile: { z: number }, dir: number, steps: number) => {
      let highest = -Infinity;
      for (let k = 0; k < steps; k++) {
        const p = g.player();
        let err = Math.atan2(0.2 * dir, pile.z - p.z) - p.yaw;
        err = Math.atan2(Math.sin(err), Math.cos(err));
        g.setInput({ move: { x: Math.max(-1, Math.min(1, -3 * err)), y: 1 }, jump: p.swimming && k % 40 < 20 }, 1);
        g.advance(1, false);
        highest = Math.max(highest, p.y - w);
      }
      g.setInput(null);
      return highest;
    };
    return g.rockPiles().map((pile) => {
      const slabs = g.obstacles().filter((o) => o.name.startsWith(pile.name)).length;
      g.teleport(pile.x0 - 0.12, pile.z, Math.PI / 2);
      g.advance(10, false);
      const fromLand = climb(pile, 1, 360);
      g.teleport(pile.x1 + 0.25, pile.z, -Math.PI / 2, w - 0.01);
      g.advance(10, false);
      const fromSea = climb(pile, -1, 360);
      return { name: pile.name, peak: pile.peak, slabs, fromLand, fromSea };
    });
  });
  expect(runs.length).toBe(2);
  for (const r of runs) {
    // A heap of slabs, and the lizard got all the way up both ways (the crest is level to within a couple of cm).
    expect(r.slabs).toBeGreaterThan(30);
    expect(r.fromLand).toBeGreaterThan(r.peak - 0.03);
    expect(r.fromSea).toBeGreaterThan(r.peak - 0.03);
  }
  await page.evaluate(() => {
    const g = window.__game!;
    const pile = g.rockPiles()[0];
    g.teleport(pile.x0 + 0.55, pile.z, Math.PI / 2, g.ocean().waterY + pile.peak + 0.01);
    g.advance(30, false);
    g.viewFrom({ x: -0.35, y: 0.25, z: 0.45 });
    g.advance(1);
  });
  await page.screenshot({ path: 'test-results/screenshots/rock-pile.png' });
  expect(errors).toEqual([]);
});
