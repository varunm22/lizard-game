import { expect, test } from '@playwright/test';

test('plants slow the lizard and give a little as it pushes through, then creep back upright', async ({ page }) => {
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

  // The poppy in the first patch, between the spawn and the log. Start two body lengths short of it
  // and walk straight over it (the lizard travels -Z facing yaw pi).
  const poppy = plants.find((p) => p.kind === 'poppy' && Math.hypot(p.x - 0.16, p.z + 0.22) < 0.01)!;
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, Math.PI), [poppy.x, poppy.z + 0.3]);
  await page.evaluate(() => window.__game!.advance(20, false));

  const walk = await page.evaluate((poppy) => {
    const g = window.__game!;
    const lean = () => {
      const p = g.plants({ x: poppy.x, z: poppy.z, r: 1e-6 })[0];
      return { x: p.tiltX, z: p.tiltZ, size: Math.hypot(p.tiltX, p.tiltZ) };
    };
    g.setInput({ move: { x: 0, y: 1 } }, 1000);
    let maxLean = 0;
    let k = 0;
    // Walk until the tail tip (~0.1 m behind the feet) is past the stem.
    for (; k < 600 && g.player().z > poppy.z - 0.12; k++) {
      g.advance(1, false);
      maxLean = Math.max(maxLean, lean().size);
    }
    g.setInput(null);
    const passed = g.player().z < poppy.z - 0.12;
    // Then watch it come back upright: lean along the way it was left leaning, each step.
    const left = lean();
    const after: number[] = [];
    for (let i = 0; i < 240; i++) {
      g.advance(1, false);
      const l = lean();
      after.push((l.x * left.x + l.z * left.z) / left.size);
    }
    return { maxLean, released: left.size, passed, after };
  }, poppy);

  expect(walk.passed).toBe(true); // nothing held the lizard up
  // It gives a little, not flat.
  expect(walk.maxLean).toBeGreaterThan(0.15);
  expect(walk.maxLean).toBeLessThan(0.45);
  // Released, it creeps back: still most of the way over a quarter second later, upright after
  // four seconds, and never swings past upright.
  expect(walk.after[14]).toBeGreaterThan(walk.released * 0.5);
  expect(Math.min(...walk.after)).toBeGreaterThan(-0.01);
  expect(Math.abs(walk.after.at(-1)!)).toBeLessThan(0.01);

  // The thickest grass near the middle of the meadow slows a walk right down, most at its heart.
  const patch = await page.evaluate(() => {
    const ps = window.__game!.plants().filter((p) => p.kind === 'grass' && Math.hypot(p.x, p.z) < 1.2);
    const count = (p: (typeof ps)[number]) => ps.filter((q) => Math.hypot(q.x - p.x, q.z - p.z) < 0.08).length;
    return ps.reduce((a, b) => (count(b) > count(a) ? b : a));
  });
  // Walk through it along +X (yaw pi/2), starting in the open.
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, Math.PI / 2), [patch.x - 0.3, patch.z]);
  const speeds = await page.evaluate((patch) => {
    const g = window.__game!;
    g.advance(20, false);
    g.setInput({ move: { x: 0, y: 1 } }, 1000);
    g.advance(15, false);
    const open = g.player().speed;
    let inPatch = Infinity;
    for (let k = 0; k < 600 && g.player().x < patch.x + 0.15; k++) {
      g.advance(1, false);
      if (Math.abs(g.player().x - patch.x) < 0.03) inPatch = Math.min(inPatch, g.player().speed);
    }
    const through = g.player().x >= patch.x + 0.15;
    g.setInput(null);
    return { open, inPatch, through };
  }, patch);
  expect(speeds.open).toBeGreaterThan(0.24); // full walking speed in the open
  expect(speeds.inPatch).toBeLessThan(speeds.open * 0.7);
  expect(speeds.through).toBe(true); // slowed, never stopped

  // From the side, walking back through the patch: the poppy leaning a little from the body.
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
