import { expect, test } from '@playwright/test';

test('plants lean out of the way as the lizard walks through, without blocking it, then spring back', async ({ page }) => {
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

  // The poppy in the first patch, between the spawn and the log. Start a body length short of it
  // and walk straight over it (the lizard travels -Z facing yaw pi).
  const poppy = plants.find((p) => p.kind === 'poppy' && Math.hypot(p.x - 0.16, p.z + 0.22) < 0.01)!;
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, Math.PI), [poppy.x, poppy.z + 0.15]);
  await page.evaluate(() => window.__game!.advance(20, false));

  const walk = await page.evaluate((poppy) => {
    const g = window.__game!;
    const lean = () => {
      const p = g.plants({ x: poppy.x, z: poppy.z, r: 1e-6 })[0];
      return { size: Math.hypot(p.tiltX, p.tiltZ), forward: -p.tiltZ };
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
    // Then watch it spring back.
    const after: number[] = [];
    for (let i = 0; i < 240; i++) {
      g.advance(1, false);
      after.push(lean().forward);
    }
    return { maxLean, passed, steps: k, after };
  }, poppy);

  expect(walk.passed).toBe(true); // nothing held the lizard up
  expect(walk.maxLean).toBeGreaterThan(0.8); // pressed well over, not just brushed
  // Released, it whips back past upright (leans against the way it was pushed) and settles.
  expect(Math.min(...walk.after)).toBeLessThan(-0.1);
  expect(Math.abs(walk.after.at(-1)!)).toBeLessThan(0.01);

  // From the side, walking back through the patch: the poppy pressed over by the body.
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
