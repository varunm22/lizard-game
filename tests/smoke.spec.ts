import { expect, test } from '@playwright/test';

test('scene boots, physics runs, and rocks settle on the ground', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true);

  // Let physics run for ~2 s of game time so everything falls and comes to rest.
  await page.waitForFunction(() => (window.__game?.physicsSteps ?? 0) >= 120);
  await page.waitForTimeout(500);

  const bodies = await page.evaluate(() => window.__game!.bodies());
  expect(bodies.length).toBeGreaterThan(0);
  for (const b of bodies) {
    expect(b.y).toBeGreaterThan(0); // resting on the ground, not fallen through
    expect(b.y).toBeLessThan(0.15); // and not still hanging in the air
  }

  await page.screenshot({ path: 'test-results/screenshots/scene.png' });
  expect(errors).toEqual([]);
});

test('lizard loads with all of its animation clips', async ({ page }) => {
  await page.goto('/?clip=walk&angle=0.3');
  await page.waitForFunction(() => window.__game?.ready === true);
  const lizard = await page.evaluate(() => window.__game!.lizard());
  expect([...lizard.clips].sort()).toEqual(['fall', 'idle', 'jump', 'land', 'run', 'walk']);
  expect(lizard.current).toBe('walk');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/screenshots/lizard-walk.png' });
});
