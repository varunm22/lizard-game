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

test('reef: algae in the shallows, coral deeper, fish school in the sea and keep off the bottom', async ({ page }) => {
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
      // Seaweed keeps to the shallows and coral to the deep, overlapping between 14 and 22 cm.
      deepestAlgae: Math.max(...g.algae().map((a) => waterY - a.y)),
      shallowestCoral: Math.min(...corals.filter((c) => !['urchin', 'sea_star'].includes(c.kind)).map((c) => waterY - c.y)),
      mixed: corals.filter((c) => c.kind.startsWith('coral') && waterY - c.y < 0.22).length,
      shallowUrchins: corals.filter((c) => c.kind === 'urchin' && waterY - c.y < 0.12).length,
    };
  });
  expect(reef.kinds).toEqual(['coral_cauliflower', 'coral_lobe', 'sea_fan', 'sea_star', 'sun_coral', 'urchin']);
  expect(reef.count).toBeGreaterThan(200);
  expect(reef.deepestAlgae).toBeLessThan(0.22);
  expect(reef.shallowestCoral).toBeGreaterThan(0.14);
  expect(reef.mixed).toBeGreaterThan(0);
  expect(reef.shallowUrchins).toBeGreaterThan(0);
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
    const corals = window.__game!.corals().filter((c) => c.kind.startsWith('coral') || c.kind === 'sea_fan');
    const crowd = (c: { x: number; z: number }) => corals.filter((o) => Math.hypot(o.x - c.x, o.z - c.z) < 0.25).length;
    const best = corals.reduce((a, c) => (crowd(c) > crowd(a) ? c : a));
    return { x: best.x, y: best.y + 0.03, z: best.z };
  });
  await viewUnderwater(page, garden);
  await screenshot(page, 'reef/corals.png');
  // Where the seaweed of the shallows gives way to coral.
  const edge = await page.evaluate(() => {
    const g = window.__game!;
    const { waterY } = g.ocean();
    const c = g.corals().find((c) => c.kind === 'coral_cauliflower' && waterY - c.y < 0.2 && (c.z < -1 || c.z > 3))!;
    return { x: c.x, y: c.y + 0.03, z: c.z };
  });
  await viewUnderwater(page, edge);
  await screenshot(page, 'reef/zones.png');
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

test('reef: dropping into the water onto a fish touches it, and it darts off', async ({ page }) => {
  const errors = await bootGame(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    const { waterY } = g.ocean();
    // The fish nearest the surface, from 8 cm over it, as off a running jump.
    const f = g.fish().sort((a, b) => b.y - a.y)[0];
    g.teleport(f.x, f.z, 0, waterY + 0.08);
    let k = 0;
    for (; k < 40 && g.fishTouched() === 0; k++) g.advance(1);
    return { steps: k, touched: g.fishTouched(), goal: g.goals().find((x) => x.id === 'fish')!.done, darting: g.fish().filter((f) => f.darting).length };
  });
  await screenshot(page, 'reef/plunge.png');
  expect(run.touched).toBe(1);
  expect(run.steps).toBeLessThan(30);
  expect(run.goal).toBe(true);
  expect(run.darting).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('reef: a fish chased into the shallows is cornered and touched', async ({ page }) => {
  const errors = await bootGame(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    const { waterY } = g.ocean();
    // A school by the shore (named by its home), chased from half a metre out to sea at a run, always at its nearest fish.
    const mine = () => g.fish().filter((f) => f.school === '2.600,-0.593');
    const m = mine();
    const c = { x: m.reduce((a, f) => a + f.x, 0) / m.length, z: m.reduce((a, f) => a + f.z, 0) / m.length };
    g.teleport(c.x + 0.5, c.z, -Math.PI / 2, waterY - 0.03);
    let k = 0;
    let depth = 0;
    for (; k < 15 * 60 && g.fishTouched() === 0; k++) {
      const p = g.player();
      const f = mine().reduce((a, f) => (Math.hypot(f.x - p.x, f.z - p.z) < Math.hypot(a.x - p.x, a.z - p.z) ? f : a));
      const turn = Math.atan2(f.x - p.x, f.z - p.z) - p.yaw;
      g.setInput({ move: { x: Math.max(-1, Math.min(1, -Math.atan2(Math.sin(turn), Math.cos(turn)) * 3)), y: 1 }, run: true, jump: false });
      g.advance(1);
      depth = waterY - g.terrainHeight(f.x, f.z);
    }
    g.setInput(null);
    return { touched: g.fishTouched(), depth, goal: g.goals().find((x) => x.id === 'fish')!.done };
  });
  await screenshot(page, 'reef/cornered.png');
  // Driven in toward the shallows, it runs out of room and one is caught.
  expect(run.touched).toBe(1);
  expect(run.depth).toBeLessThan(0.12);
  expect(run.goal).toBe(true);
  expect(errors).toEqual([]);
});
