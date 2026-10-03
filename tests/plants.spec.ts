import { expect, test } from '@playwright/test';

test('plant stems block the lizard and lean a little, thick plants slow it, and they creep back upright', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true);

  const plants = await page.evaluate(() => window.__game!.plants());
  const kinds = new Set(plants.map((p) => p.kind));
  expect([...kinds].sort()).toEqual(['daisy', 'fern', 'grass', 'poppy', 'reed']);
  // Plants stand on the ground and never grow out of the pond's water (reeds in the shallows aside).
  const { waterY } = await page.evaluate(() => window.__game!.pond());
  for (const p of plants.filter((p) => p.kind !== 'reed')) expect(p.y).toBeGreaterThan(waterY);

  // The poppy in the first patch, between the spawn and the log. Walk straight at it from two body
  // lengths away (the lizard travels -Z facing yaw pi): its stem stops the lizard, leaning a little.
  const poppy = plants.find((p) => p.kind === 'poppy' && Math.hypot(p.x - 0.16, p.z + 0.22) < 0.01)!;
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, Math.PI), [poppy.x, poppy.z + 0.3]);
  await page.evaluate(() => window.__game!.advance(20, false));

  const walk = await page.evaluate((poppy) => {
    const g = window.__game!;
    const lean = () => {
      const p = g.plants({ x: poppy.x, z: poppy.z, r: 1e-6 })[0];
      return { x: p.tiltX, z: p.tiltZ, size: Math.hypot(p.tiltX, p.tiltZ) };
    };
    g.setInput({ move: { x: 0, y: 1 } }, 150);
    let maxLean = 0;
    for (let k = 0; k < 150; k++) {
      g.advance(1, false);
      maxLean = Math.max(maxLean, lean().size);
    }
    const stopped = g.player();
    // Back off, then watch it come back upright: lean along the way it was left leaning, each step.
    g.setInput({ move: { x: 0, y: -1 } }, 20);
    g.advance(20, false);
    const left = lean();
    const after: number[] = [];
    for (let i = 0; i < 240; i++) {
      g.advance(1, false);
      const l = lean();
      after.push((l.x * left.x + l.z * left.z) / left.size);
    }
    return { stoppedZ: stopped.z, stoppedSpeed: stopped.speed, maxLean, released: left.size, after };
  }, poppy);

  // Held up by the stem: the capsule's nose (6 cm ahead of the feet, plus the controller's skin)
  // stops just short of it.
  expect(walk.stoppedZ - poppy.z).toBeGreaterThan(0.06);
  expect(walk.stoppedZ - poppy.z).toBeLessThan(0.08);
  expect(walk.stoppedSpeed).toBeLessThan(0.02);
  // The snout pushing on it leans it a little, not flat.
  expect(walk.maxLean).toBeGreaterThan(0.1);
  expect(walk.maxLean).toBeLessThan(0.45);
  // Released, it creeps back: still most of the way over a quarter second later, upright after
  // four seconds, and never swings past upright.
  expect(walk.after[14]).toBeGreaterThan(walk.released * 0.5);
  expect(Math.min(...walk.after)).toBeGreaterThan(-0.01);
  expect(Math.abs(walk.after.at(-1)!)).toBeLessThan(0.01);

  // A straight lane through the thickest grass near the middle of the meadow that clears every stem
  // (the body needs 2 cm each side of its line), so the walk only brushes the tufts beside it.
  const lane = await page.evaluate(() => {
    const ps = window.__game!.plants();
    const grass = ps.filter((p) => p.kind === 'grass' && Math.hypot(p.x, p.z) < 1.2);
    const count = (x: number, z: number) => grass.filter((q) => Math.hypot(q.x - x, q.z - z) < 0.1).length;
    let best = { x: 0, z: 0, n: -1 };
    for (const p of grass) {
      for (let dz = -0.05; dz <= 0.05; dz += 0.005) {
        const z = p.z + dz;
        const blocked = ps.some((q) => q.x > p.x - 0.35 && q.x < p.x + 0.2 && Math.abs(q.z - z) < 0.024);
        const n = count(p.x, z);
        if (!blocked && n > best.n) best = { x: p.x, z, n };
      }
    }
    return best;
  });
  expect(lane.n).toBeGreaterThan(4);
  // Walk along it toward +X (yaw pi/2), starting in the open.
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, Math.PI / 2), [lane.x - 0.3, lane.z]);
  const speeds = await page.evaluate((lane) => {
    const g = window.__game!;
    g.advance(20, false);
    g.setInput({ move: { x: 0, y: 1 } }, 1000);
    g.advance(15, false);
    const open = g.player().speed;
    let inPatch = Infinity;
    for (let k = 0; k < 600 && g.player().x < lane.x + 0.15; k++) {
      g.advance(1, false);
      if (Math.abs(g.player().x - lane.x) < 0.03) inPatch = Math.min(inPatch, g.player().speed);
    }
    const through = g.player().x >= lane.x + 0.15;
    g.setInput(null);
    return { open, inPatch, through };
  }, lane);
  expect(speeds.open).toBeGreaterThan(0.24); // full walking speed in the open
  expect(speeds.inPatch).toBeLessThan(speeds.open * 0.85);
  expect(speeds.through).toBe(true); // slowed, but not stopped

  // From the side, walking back at the poppy from the other side: stopped at its stem.
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, 0), [poppy.x, poppy.z - 0.1]);
  await page.evaluate(() => {
    const g = window.__game!;
    g.setInput({ move: { x: 0, y: 1 } }, 30);
    g.viewFrom({ x: 0.25, y: 0.07, z: 0 });
    g.advance(30);
  });
  await page.screenshot({ path: 'test-results/screenshots/plants-push.png' });
  expect(errors).toEqual([]);
});
