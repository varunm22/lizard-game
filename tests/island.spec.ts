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
