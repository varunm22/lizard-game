import { expect, test, type Page } from '@playwright/test';
import { bootGame } from './helpers/bootGame';
import { screenshot } from './helpers/screenshot';

/**
 * Look at `at` from 30 cm off under the water, from whichever side has open water between: the camera
 * clear of every rock and over the sea floor.
 */
async function viewUnderwater(page: Page, at: { x: number; y: number; z: number }) {
  await page.evaluate((at) => {
    const g = window.__game!;
    const { waterY } = g.ocean();
    const rocks = g.obstacles();
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * 2 * Math.PI;
      const off = { x: Math.cos(a) * 0.3, y: Math.min(0.08, waterY - 0.02 - at.y), z: Math.sin(a) * 0.3 };
      const clear = [0.33, 0.66, 1].every((t) => {
        const x = at.x + off.x * t;
        const z = at.z + off.z * t;
        return g.terrainHeight(x, z) < at.y + off.y * t - 0.03 && rocks.every((o) => Math.hypot(o.x - x, o.z - z) > o.radius + 0.03);
      });
      if (!clear) continue;
      g.viewFrom(off, at);
      g.advance(1);
      return;
    }
  }, at);
}

test('reef: corals grow under water, fish school in the sea and keep off the bottom', async ({ page }) => {
  const errors = await bootGame(page);
  const reef = await page.evaluate(() => {
    const g = window.__game!;
    const { waterY } = g.ocean();
    const corals = g.corals();
    return {
      waterY,
      kinds: [...new Set(corals.map((c) => c.kind))].sort(),
      count: corals.length,
      // Every coral and urchin is wholly under the surface, growing from the floor or a rock.
      dry: corals.filter((c) => c.top > waterY).length,
      floating: corals.filter((c) => c.y > g.terrainHeight(c.x, c.z) + 0.25).length,
    };
  });
  expect(reef.kinds).toEqual(['coral_cauliflower', 'coral_lobe', 'sea_fan', 'sun_coral', 'urchin']);
  expect(reef.count).toBeGreaterThan(100);
  expect(reef.dry).toBe(0);
  expect(reef.floating).toBe(0);

  const fish = await page.evaluate(() => {
    const g = window.__game!;
    const { waterY } = g.ocean();
    const start = g.fish();
    const strays: string[] = [];
    // Ten seconds of swimming, checked every half second.
    for (let k = 0; k < 20; k++) {
      g.advance(30);
      for (const f of g.fish()) {
        if (f.y > waterY || f.y < f.bottom || Math.abs(f.z) > 3.95 || f.x > 3.95 || f.x < 1) strays.push(`${f.species} at ${f.x.toFixed(2)},${f.y.toFixed(3)},${f.z.toFixed(2)}`);
      }
    }
    const end = g.fish();
    return {
      species: [...new Set(start.map((f) => f.species))].sort(),
      count: start.length,
      schools: new Set(start.map((f) => f.school)).size,
      strays,
      moved: end.filter((f, i) => Math.hypot(f.x - start[i].x, f.z - start[i].z) > 0.1).length,
    };
  });
  expect(fish.species).toEqual(['angel', 'salema', 'sergeant', 'surgeon']);
  expect(fish.count).toBeGreaterThan(100);
  expect(fish.schools).toBeGreaterThanOrEqual(12);
  expect(fish.strays).toEqual([]);
  expect(fish.moved).toBeGreaterThan(fish.count * 0.8);

  // A sergeant major school among the rocks, from beside it under the water.
  const sergeants = await page.evaluate(() => {
    const school = window.__game!.fish().filter((f) => f.species === 'sergeant');
    const at = school.filter((f) => f.school === school[0].school);
    return { x: at.reduce((a, f) => a + f.x, 0) / at.length, y: at.reduce((a, f) => a + f.y, 0) / at.length, z: at.reduce((a, f) => a + f.z, 0) / at.length };
  });
  await viewUnderwater(page, sergeants);
  await screenshot(page, 'reef/sergeants.png');
  // The thickest patch of reef, from just above the corals.
  const garden = await page.evaluate(() => {
    const corals = window.__game!.corals().filter((c) => c.kind !== 'urchin');
    const crowd = (c: { x: number; z: number }) => corals.filter((o) => Math.hypot(o.x - c.x, o.z - c.z) < 0.25).length;
    const best = corals.reduce((a, c) => (crowd(c) > crowd(a) ? c : a));
    return { x: best.x, y: best.y + 0.03, z: best.z };
  });
  await viewUnderwater(page, garden);
  await screenshot(page, 'reef/corals.png');
  await page.evaluate(() => window.__game!.viewFrom(null));
  expect(errors).toEqual([]);
});

test('reef: a school darts away from the lizard swimming into it, then settles', async ({ page }) => {
  const errors = await bootGame(page);
  const first = await page.evaluate(() => {
    const g = window.__game!;
    const salema = g.fish().filter((f) => f.species === 'salema');
    const school = salema.filter((f) => f.school === salema[0].school);
    const c = { x: school.reduce((a, f) => a + f.x, 0) / school.length, y: school.reduce((a, f) => a + f.y, 0) / school.length, z: school.reduce((a, f) => a + f.z, 0) / school.length };
    const near = () => {
      const p = g.player();
      return Math.min(...g.fish().filter((f) => f.school === school[0].school).map((f) => Math.hypot(f.x - p.x, f.y - p.y, f.z - p.z)));
    };
    // Into the middle of the school, under the water.
    g.teleport(c.x, c.z, 0, Math.max(c.y - 0.02, g.terrainHeight(c.x, c.z) + 0.005));
    const before = near();
    g.advance(20);
    const mine = () => g.fish().filter((f) => f.school === school[0].school);
    return { size: school.length, before, darting: mine().filter((f) => f.darting).length, fast: Math.max(...mine().map((f) => f.speed)) };
  });
  await screenshot(page, 'reef/scatter.png');
  const result = await page.evaluate((first) => {
    const g = window.__game!;
    const salema = g.fish().filter((f) => f.species === 'salema');
    const mine = () => g.fish().filter((f) => f.school === salema[0].school);
    const near = () => {
      const p = g.player();
      return Math.min(...mine().map((f) => Math.hypot(f.x - p.x, f.y - p.y, f.z - p.z)));
    };
    g.advance(40);
    const after = near();
    // The lizard swims off; the school calms down again.
    g.teleport(0.1, 0.05, Math.PI);
    g.advance(180);
    return { ...first, after, calm: mine().filter((f) => f.darting).length, top: Math.max(...mine().map((f) => f.speed)) };
  }, first);
  expect(result.before).toBeLessThan(0.05);
  expect(result.darting).toBeGreaterThan(result.size / 2);
  expect(result.fast).toBeGreaterThan(0.2);
  expect(result.after).toBeGreaterThan(0.12);
  expect(result.calm).toBe(0);
  expect(result.top).toBeLessThan(0.15);
  expect(errors).toEqual([]);
});
