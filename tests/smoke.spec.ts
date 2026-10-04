import { expect, test } from '@playwright/test';

test('boots: heightfield matches the drawn ground, obstacles sit on it, lizard loads idle', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true);
  await page.evaluate(() => window.__game!.advance(30));

  // Sample a grid over forest, clearing, beach and sea floor, away from obstacles: the collider and
  // the height function agree to within a mm.
  const samples = await page.evaluate(() => {
    const g = window.__game!;
    const obstacles = g.obstacles();
    const clear = (x: number, z: number) => obstacles.every((o) => Math.hypot(o.x - x, o.z - z) > o.radius + 0.3);
    const out: { x: number; z: number; mesh: number; physics: number | null }[] = [];
    for (let x = -3.5; x <= 3.5; x += 0.29) {
      for (let z = 3.5; z >= -3.5; z -= 0.27) if (clear(x, z)) out.push({ x, z, mesh: g.terrainHeight(x, z), physics: g.groundAt(x, z) });
    }
    return out;
  });
  expect(samples.length).toBeGreaterThan(100);
  const heights = samples.map((s) => s.mesh);
  expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.3); // not flat: hills down to the sea floor
  for (const s of samples) {
    expect(s.physics).not.toBeNull();
    expect(Math.abs(s.physics! - s.mesh)).toBeLessThan(0.002);
  }

  // Obstacles stand on the ground, not floating or buried: the landmarks the tests use, and the
  // island's scattered trees, logs, rocks and cactus.
  const obstacles = await page.evaluate(() => {
    const g = window.__game!;
    return g.obstacles().map((o) => ({ ...o, top: g.groundAt(o.x, o.z)!, ground: g.terrainHeight(o.x, o.z) }));
  });
  const names = obstacles.map((o) => o.name);
  for (const n of ['log', 'pebble', 'rock-big', 'rock-island', 'rock-mid', 'rock-sunk']) expect(names).toContain(n);
  const count = (kind: string) => obstacles.filter((o) => o.kind === kind).length;
  expect(count('tree')).toBeGreaterThan(30);
  expect(count('rock')).toBeGreaterThan(100);
  expect(count('log')).toBeGreaterThan(4);
  for (const o of obstacles) {
    expect(o.top - o.ground, o.name).toBeGreaterThan(o.height * 0.6);
    expect(o.top - o.ground, o.name).toBeLessThan(o.height + 0.01);
  }

  const lizard = await page.evaluate(() => window.__game!.lizard());
  expect([...lizard.clips].sort()).toEqual(['fall', 'idle', 'jump', 'land', 'run', 'swim', 'walk']);
  expect(await page.evaluate(() => window.__game!.player().state)).toBe('idle');
  expect(await page.evaluate(() => window.__game!.lizard().current)).toBe('idle');
  await page.screenshot({ path: 'test-results/screenshots/spawn.png' });
  expect(errors).toEqual([]);
});
