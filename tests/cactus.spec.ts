import { expect, test } from '@playwright/test';
import { bootGame } from './helpers/bootGame';
import { screenshot } from './helpers/screenshot';

test('cactus: landing or crawling on top pricks the lizard (10% health) and it hops off; brushing past does not', async ({ page }) => {
  const errors = await bootGame(page);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    // A step first, so the colliders are in the scene's queries.
    g.advance(1, false);
    const cacti = g.obstacles().filter((o) => o.kind === 'cactus');
    const top = (c: (typeof cacti)[number]) => g.groundAt(c.x, c.z)!;
    const off = (c: (typeof cacti)[number]) => Math.hypot(g.player().x - c.x, g.player().z - c.z);
    // Run from a fresh full bar, `steps` steps with the given input, noting whether it hopped.
    const run = (steps: number, move: { x: number; y: number }) => {
      g.setVitals({ health: 1 });
      g.setInput({ move, run: false, jump: false });
      let hopped = false;
      for (let i = 0; i < steps; i++) {
        g.advance(1, false);
        hopped ||= g.player().state === 'jump';
      }
      g.setInput(null);
      return { hopped, health: g.vitals().health, grounded: g.player().grounded };
    };

    // Dropped onto the top of each cactus, as if it jumped up: off again within a second, a tenth down.
    const dropped = cacti.map((c) => {
      g.teleport(c.x, c.z, 0, top(c) + 0.004);
      const res = run(60, { x: 0, y: 0 });
      return { ...res, off: off(c) - c.radius };
    });

    // Walking into one it crawls up over the rim (they're all within climbing height), is pricked
    // and hops off; it lets go of the controls once pricked.
    const c = cacti[0];
    g.teleport(c.x - c.radius - 0.08, c.z, Math.PI / 2);
    g.setVitals({ health: 1 });
    g.setInput({ move: { x: 0, y: 1 }, run: false, jump: false });
    let climbed = false;
    for (let i = 0; i < 150 && g.vitals().health === 1; i++) {
      g.advance(1, false);
      climbed ||= g.player().climbing;
    }
    g.setInput(null);
    g.advance(60, false);
    const crawl = { climbed, health: g.vitals().health, grounded: g.player().grounded, off: off(c) - c.radius };

    // Walking along beside a cactus, its flank brushing the trunk: no harm.
    const brushes = cacti.map((c) => {
      g.teleport(c.x - 0.15, c.z + c.radius + 0.014, Math.PI / 2);
      return run(90, { x: 0, y: 1 }).health;
    });
    return { count: cacti.length, dropped, crawl, brushes };
  });
  expect(errors).toEqual([]);
  expect(r.count).toBeGreaterThan(4);
  for (const d of r.dropped) {
    expect(d.health).toBeCloseTo(0.9, 5);
    expect(d.hopped).toBe(true);
    expect(d.grounded).toBe(true);
    // Its centre well past the rim.
    expect(d.off).toBeGreaterThan(0.04);
  }
  expect(r.crawl.climbed).toBe(true);
  expect(r.crawl.health).toBeCloseTo(0.9, 5);
  expect(r.crawl.grounded).toBe(true);
  expect(r.crawl.off).toBeGreaterThan(0.04);
  for (const h of r.brushes) expect(h).toBe(1);
});

test('cactus: a wild iguana running into one goes round it, never up onto it', async ({ page }) => {
  const errors = await bootGame(page, { iguanas: [0] });
  const r = await page.evaluate(() => {
    const g = window.__game!;
    // A step first, so the colliders are in the scene's queries.
    g.advance(1, false);
    const cacti = g.obstacles().filter((o) => o.kind === 'cactus');
    // A few of them: every one is low enough for the player to crawl onto.
    return cacti.slice(0, 3).map((c) => {
      const top = g.groundAt(c.x, c.z)!;
      // Lined up on it from the west, startled from behind so it bolts straight at it.
      g.iguanaPlace(0, c.x - c.radius - 0.1, c.z, Math.PI / 2, 60);
      g.advance(1, false);
      g.iguanaScare(0, c.x - 1, c.z);
      let highest = -Infinity;
      for (let i = 0; i < 180; i++) {
        g.advance(1, false);
        const ig = g.iguanas()[0];
        if (Math.hypot(ig.x - c.x, ig.z - c.z) < c.radius + 0.02) highest = Math.max(highest, ig.y);
      }
      return top - highest;
    });
  });
  expect(errors).toEqual([]);
  // Its feet were never over the trunk, or only well below the top.
  for (const gap of r) expect(gap).toBeGreaterThan(0.03);
  await screenshot(page, 'cactus-iguana.png');
});
