import { expect, test } from '@playwright/test';

test('boots: heightfield matches the drawn ground, obstacles sit on it, lizard loads idle', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true);
  await page.evaluate(() => window.__game!.advance(30));

  // Sample a grid away from obstacles: the collider and the height function agree to within a mm.
  const samples = await page.evaluate(() => {
    const g = window.__game!;
    const out: { x: number; z: number; mesh: number; physics: number | null }[] = [];
    for (let x = -1.7; x <= 1.7; x += 0.43) {
      for (let z = 1.7; z >= 0.2; z -= 0.37) out.push({ x, z, mesh: g.terrainHeight(x, z), physics: g.groundAt(x, z) });
    }
    return out;
  });
  const heights = samples.map((s) => s.mesh);
  expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.03); // not flat
  for (const s of samples) {
    expect(s.physics).not.toBeNull();
    expect(Math.abs(s.physics! - s.mesh)).toBeLessThan(0.002);
  }

  // Obstacles sit on the ground, not floating or buried.
  const obstacles = await page.evaluate(() => window.__game!.obstacles());
  expect(obstacles.map((o) => o.name).sort()).toEqual(['log', 'pebble', 'rock-big', 'rock-island', 'rock-mid', 'rock-sunk']);
  for (const o of obstacles) {
    const top = await page.evaluate(([x, z]) => window.__game!.groundAt(x, z), [o.x, o.z]);
    const ground = await page.evaluate(([x, z]) => window.__game!.terrainHeight(x, z), [o.x, o.z]);
    expect(top! - ground).toBeGreaterThan(o.height * 0.8);
  }

  const lizard = await page.evaluate(() => window.__game!.lizard());
  expect([...lizard.clips].sort()).toEqual(['fall', 'idle', 'jump', 'land', 'run', 'swim', 'walk']);
  expect(await page.evaluate(() => window.__game!.player().state)).toBe('idle');
  expect(await page.evaluate(() => window.__game!.lizard().current)).toBe('idle');
  await page.screenshot({ path: 'test-results/screenshots/spawn.png' });
  expect(errors).toEqual([]);
});
