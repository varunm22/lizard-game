import { expect, test, type Page } from '@playwright/test';

async function boot(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true);
  return errors;
}

test('crabs live on the lava shore and the rock piles, standing on the rock out of the sea, and get about', async ({ page }) => {
  const errors = await boot(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const { waterY } = g.ocean();
    // How far each is off the surface under it (looking from just above it: it may be in under the
    // ledge of a slab), and above the sea. Rays onto a rock's convex hull come out a few mm apart from
    // different heights, so "on the rock" is within a few mm (it stands 7 mm tall).
    const check = () =>
      g.crabs().map((c) => ({ gap: c.y - g.groundAt(c.x, c.z, c.y + 0.03)!, dry: c.y - waterY, state: c.state, x: c.x, z: c.z, onPile: c.onPile, hops: c.hops }));
    const start = check();
    let worstGap = 0;
    let wettest = Infinity;
    const states = new Set<string>();
    for (let i = 0; i < 40; i++) {
      g.advance(60, false);
      for (const c of check()) {
        states.add(c.state);
        if (c.state !== 'hop') worstGap = Math.max(worstGap, Math.abs(c.gap));
        wettest = Math.min(wettest, c.dry);
      }
    }
    const end = check();
    return {
      clips: g.crabClips(),
      start,
      moved: end.map((c, i) => Math.hypot(c.x - start[i].x, c.z - start[i].z)),
      hops: end.reduce((n, c) => n + c.hops, 0),
      worstGap,
      wettest,
      states: [...states],
      shoreX: start.map((c) => g.shoreX(c.z)),
    };
  });

  expect(run.clips).toEqual(expect.arrayContaining(['idle', 'walk_left', 'walk_right', 'run_left', 'run_right', 'graze', 'hop_left', 'hop_right', 'duck', 'display']));
  expect(run.start.length).toBeGreaterThanOrEqual(8);
  expect(run.start.filter((c) => c.onPile).length).toBeGreaterThanOrEqual(4);
  // All on the coast, on the rock and dry from the start.
  for (const [i, c] of run.start.entries()) {
    expect(Math.abs(c.x - run.shoreX[i])).toBeLessThan(1.2);
    expect(Math.abs(c.gap)).toBeLessThan(0.006);
    expect(c.dry).toBeGreaterThan(0);
  }
  // Over 40 s they wander (hopping up and down steps), graze, and keep to the rock and out of the water.
  expect(run.moved.filter((d) => d > 0.03).length).toBeGreaterThanOrEqual(run.start.length / 2);
  expect(run.hops).toBeGreaterThan(0);
  expect(run.states).toEqual(expect.arrayContaining(['walk', 'graze']));
  expect(run.worstGap).toBeLessThan(0.006);
  expect(run.wettest).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('a crab runs off sideways when the lizard comes close', async ({ page }) => {
  const errors = await boot(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const i = g.crabs().findIndex((c) => !c.onPile);
    const c0 = g.crabs()[i];
    // Lizard 15 cm to its west, facing it.
    g.teleport(c0.x - 0.15, c0.z, Math.PI / 2);
    g.advance(10, false);
    const fled = g.crabs()[i];
    g.advance(110, false);
    const p = g.player();
    const later = g.crabs()[i];
    return {
      first: { state: fled.state, clip: fled.clip },
      before: Math.hypot(c0.x - p.x, c0.z - p.z),
      after: Math.hypot(later.x - p.x, later.z - p.z),
      later: later.state,
    };
  });

  expect(run.first.state).toBe('flee');
  expect(run.first.clip).toMatch(/^run_(left|right)$/);
  // Two seconds on it has put good distance between itself and the lizard.
  expect(run.after - run.before).toBeGreaterThan(0.1);
  expect(errors).toEqual([]);
});

test('a crab under the lizard is pushed out from under it, and two crabs never stand in each other', async ({ page }) => {
  const errors = await boot(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const i = g.crabs().findIndex((c) => !c.onPile);
    const c0 = g.crabs()[i];
    // Sent walking, it pays the lizard no mind, so the lizard can end up right on top of it.
    g.crabGo(i, c0.x, c0.z - 0.3);
    g.teleport(c0.x, c0.z, Math.PI / 2);
    g.advance(3, false);
    const p = g.player();
    const c = g.crabs()[i];
    // Distance from the crab to the lizard's spine (the capsule, 4.8 cm either side of its feet).
    const fx = Math.sin(p.yaw);
    const fz = Math.cos(p.yaw);
    const along = Math.max(-0.048, Math.min(0.048, (c.x - p.x) * fx + (c.z - p.z) * fz));
    const underLizard = Math.hypot(c.x - (p.x + fx * along), c.z - (p.z + fz * along));
    // Two crabs put down on the same spot, the lizard well away.
    g.teleport(0, 0, 0);
    const j = g.crabs().findIndex((k, n) => !k.onPile && n !== i);
    g.crabPlace(i, c0.x, c0.z);
    g.crabPlace(j, c0.x, c0.z);
    g.advance(3, false);
    const [a, b] = [g.crabs()[i], g.crabs()[j]];
    return { underLizard, apart: Math.hypot(a.x - b.x, a.z - b.z) };
  });

  expect(run.underLizard).toBeGreaterThan(0.022);
  expect(run.apart).toBeGreaterThan(0.027);
  expect(errors).toEqual([]);
});

test('a crab climbs a rock pile to the crest, hopping up its steps', async ({ page }) => {
  const errors = await boot(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const pile = g.rockPiles()[0];
    // Put a crab on the lava at the foot of the pile and send it along the spine to the crest.
    g.crabPlace(0, pile.x0 - 0.05, pile.z);
    const crestX = pile.x0 + (pile.x1 - pile.x0) * 0.42;
    g.crabGo(0, crestX, pile.z);
    let c = g.crabs()[0];
    for (let s = 0; s < 3600 && Math.abs(c.x - crestX) > 0.02; s += 60) {
      g.advance(60, false);
      c = g.crabs()[0];
    }
    return { c, crestX, crestY: g.ocean().waterY + pile.peak };
  });

  expect(Math.abs(run.c.x - run.crestX)).toBeLessThan(0.02);
  expect(run.c.y).toBeGreaterThan(run.crestY - 0.03);
  expect(run.c.hops).toBeGreaterThan(1);
  expect(errors).toEqual([]);

  // A close look at it up there, and at one grazing on the shore.
  await page.evaluate(() => {
    const g = window.__game!;
    const c = g.crabs()[0];
    g.viewFrom({ x: -0.05, y: 0.035, z: 0.06 }, c);
    g.advance(1);
  });
  await page.screenshot({ path: 'test-results/screenshots/crab-pile.png' });
  await page.evaluate(() => {
    const g = window.__game!;
    const c = g.crabs().find((k) => !k.onPile)!;
    g.viewFrom({ x: -0.06, y: 0.04, z: 0.07 }, c);
    g.advance(1);
  });
  await page.screenshot({ path: 'test-results/screenshots/crab-shore.png' });
});
