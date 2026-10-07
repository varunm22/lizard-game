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
    // different heights, so "on the rock" is within a few mm (it stands 7 mm tall). Standing at a
    // rock's edge on its legs, the ray straight down can miss the rock, so it also looks 8 mm round it.
    const check = () =>
      g.crabs().map((c) => ({ gap: [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => c.y - g.groundAt(c.x + dx * 0.008, c.z + dz * 0.008, c.y + 0.03)!).reduce((a, b) => (Math.abs(a) < Math.abs(b) ? a : b)), dry: c.y - waterY, state: c.state, x: c.x, z: c.z, onPile: c.onPile, hops: c.hops }));
    const start = check();
    let worstGap = 0;
    let wettest = Infinity;
    const states = new Set<string>();
    for (let i = 0; i < 40; i++) {
      g.advance(60, false);
      for (const c of check()) {
        states.add(c.state);
        // Up on an iguana's back grooming it, it isn't on the rock.
        if (c.state !== 'hop' && c.state !== 'groom') worstGap = Math.max(worstGap, Math.abs(c.gap));
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

test('a crab runs from another iguana coming close too, not just the lizard', async ({ page }) => {
  const errors = await boot(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    // A shore crab with black lava 15 cm to its west for the iguana to stand on.
    const i = g.crabs().findIndex((c) => !c.onPile && g.lava(c.x - 0.15, c.z) > 0.85);
    const c0 = g.crabs()[i];
    // An iguana that has just got there, facing it: up and about, not lain still yet.
    g.iguanaPlace(0, c0.x - 0.15, c0.z, Math.PI / 2);
    g.advance(10, false);
    const fled = g.crabs()[i];
    g.advance(110, false);
    const ig = g.iguanas()[0];
    const later = g.crabs()[i];
    return {
      first: fled.state,
      player: Math.hypot(c0.x - g.player().x, c0.z - g.player().z),
      before: Math.hypot(c0.x - ig.x, c0.z - ig.z),
      after: Math.hypot(later.x - ig.x, later.z - ig.z),
    };
  });
  // The lizard is nowhere near it: it ran from the iguana.
  expect(run.player).toBeGreaterThan(0.5);
  expect(run.first).toBe('flee');
  expect(run.after - run.before).toBeGreaterThan(0.08);
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

test('once the lizard lies still a crab comes and grooms it, riding its back, and hops off when it moves', async ({ page }) => {
  const errors = await boot(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const { waterY } = g.ocean();
    // Lizard 25 cm from a crab on the lava (just out of alarm range), its side toward it, with open
    // rock between them (no boulder in the way).
    const open = (c: { x: number; y: number; z: number }, a: number) => {
      let y = c.y;
      for (let d = 0.01; d <= 0.3; d += 0.01) {
        const h = g.groundAt(c.x + Math.sin(a) * d, c.z + Math.cos(a) * d, y + 0.05)!;
        if (Math.abs(h - y) > 0.01 || h < waterY + 0.003) return false;
        y = h;
      }
      return true;
    };
    let spot: { x: number; z: number; yaw: number } | null = null;
    for (const c of g.crabs().filter((k) => !k.onPile)) {
      for (let k = 0; k < 8 && !spot; k++) {
        const a = (k * Math.PI) / 4;
        if (open(c, a)) spot = { x: c.x + Math.sin(a) * 0.25, z: c.z + Math.cos(a) * 0.25, yaw: a + Math.PI / 2 };
      }
      if (spot) break;
    }
    if (!spot) return { waited: 0, groomed: false };
    g.teleport(spot.x, spot.z, spot.yaw);
    let i = -1;
    let waited = 0;
    for (; waited < 2400 && i < 0; waited += 30) {
      g.advance(30, false);
      i = g.crabs().findIndex((c) => c.state === 'groom' && c.grooming === 'player');
    }
    if (i < 0) return { waited, groomed: false };
    g.advance(120, false);
    const p = g.player();
    const up = g.crabs()[i];
    // A close look at it up there.
    g.viewFrom({ x: -0.07, y: 0.06, z: 0.09 }, up);
    g.advance(1);
    return {
      i,
      waited,
      groomed: true,
      up: { state: up.state, clip: up.clip, height: up.y - p.y, fromFeet: Math.hypot(up.x - p.x, up.z - p.z) },
    };
  });
  await page.screenshot({ path: 'test-results/screenshots/crab-groom.png' });
  // Off it goes when the lizard walks on.
  const off = await page.evaluate((i) => {
    const g = window.__game!;
    g.viewFrom(null);
    g.setInput({ move: { x: 0, y: 1 } }, 60);
    g.advance(120, false);
    const c = g.crabs()[i];
    return { state: c.state, gap: c.y - g.groundAt(c.x, c.z, c.y + 0.03)! };
  }, run.i ?? 0);

  expect(run.groomed).toBe(true);
  // It's up on the lizard's back, picking at its skin, still there two seconds on.
  expect(run.up!.state).toBe('groom');
  expect(run.up!.clip).toBe('graze');
  expect(run.up!.height).toBeGreaterThan(0.015);
  expect(run.up!.fromFeet).toBeLessThan(0.05);
  // Once the lizard moves it has hopped down onto the rock.
  expect(off.state).not.toBe('groom');
  expect(Math.abs(off.gap)).toBeLessThan(0.006);
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
