import { expect, test, type Page } from '@playwright/test';

async function boot(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true);
  return errors;
}

test('other marine iguanas bask on the lava shore, lying across the sun, and sneeze salt', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await boot(page);
  const start = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    return { iguanas: g.iguanas(), shoreX: g.iguanas().map((i) => g.shoreX(i.z)), waterY: g.ocean().waterY, clips: g.lizard().clips };
  });
  expect(start.iguanas.length).toBeGreaterThanOrEqual(2);
  for (const [i, ig] of start.iguanas.entries()) {
    // Up on the shore, out of the water, basking (idle) with the player's own clips.
    expect(ig.x).toBeLessThan(start.shoreX[i]);
    expect(ig.x).toBeGreaterThan(start.shoreX[i] - 0.6);
    expect(ig.y).toBeGreaterThan(start.waterY);
    expect(ig.grounded).toBe(true);
    expect(ig.swimming).toBe(false);
    expect(ig.activity).toBe('bask');
    expect(ig.clip).toBe('idle');
    // On bare black lava, not the beach.
    expect(ig.lava).toBeGreaterThan(0.8);
  }

  // A sneeze: the head comes up and jerks down, and a puff of salt spray comes out of the nose.
  const sneeze = await page.evaluate(() => {
    const g = window.__game!;
    const before = g.iguanas()[0].sneezes;
    g.iguanaDo(0, 'sneeze');
    let spray = 0;
    let sneezing = false;
    for (let k = 0; k < 120 && spray === 0; k++) {
      g.advance(1, false);
      sneezing ||= g.iguanas()[0].sneezing;
      spray = g.saltSpray();
    }
    const ig = g.iguanas()[0];
    // Side on, a little ahead.
    const fx = Math.sin(ig.yaw);
    const fz = Math.cos(ig.yaw);
    g.viewFrom({ x: fz * 0.14 + fx * 0.05, y: 0.04, z: -fx * 0.14 + fz * 0.05 }, { x: ig.x + fx * 0.08, y: ig.y + 0.025, z: ig.z + fz * 0.08 });
    g.advance(3);
    return { sneezes: g.iguanas()[0].sneezes - before, sneezing, spray, after: g.saltSpray() };
  });
  expect(sneeze.sneezing).toBe(true);
  expect(sneeze.sneezes).toBe(1);
  expect(sneeze.spray).toBeGreaterThan(5);
  await page.screenshot({ path: 'test-results/screenshots/iguana-sneeze.png' });
  // The spray settles in a second.
  expect(await page.evaluate(() => (window.__game!.advance(60, false), window.__game!.saltSpray()))).toBe(0);

  // Left to themselves for a minute, each sneezes now and then; those that don't go to feed stay
  // basking on the shore, now and then shuffling to a new spot, and lie across the sun's rays.
  const later = await page.evaluate(() => {
    const g = window.__game!;
    const before = g.iguanas().map((i) => i.sneezes);
    const fed = new Set<number>();
    for (let s = 0; s < 60; s++) {
      g.advance(60, false);
      g.iguanas().forEach((i, n) => i.activity !== 'bask' && i.activity !== 'shuffle' && fed.add(n));
    }
    return { sneezes: g.iguanas().map((i, n) => i.sneezes - before[n]), fed: [...fed], now: g.iguanas() };
  });
  for (const n of later.sneezes) expect(n).toBeGreaterThan(0);
  await page.evaluate(() => {
    const g = window.__game!;
    const ig = g.iguanas().find((i) => i.activity === 'bask' && !i.swimming) ?? g.iguanas()[0];
    g.viewFrom({ x: -0.2, y: 0.09, z: 0.16 }, { x: ig.x, y: ig.y + 0.02, z: ig.z });
    g.advance(2);
  });
  await page.screenshot({ path: 'test-results/screenshots/iguana-bask.png' });
  await page.evaluate(() => window.__game!.viewFrom(null));
  const sunYaw = Math.atan2(2.5, 1.7);
  for (const [i, ig] of later.now.entries()) {
    if (later.fed.includes(i) || ig.activity !== 'bask') continue;
    expect(ig.swimming).toBe(false);
    expect(Math.abs(ig.z - ig.home.z)).toBeLessThan(0.3);
    expect(ig.lava).toBeGreaterThan(0.8);
    // Broadside: facing within about 25° of square to the sun.
    expect(Math.abs(Math.cos(ig.yaw - sunYaw))).toBeLessThan(0.45);
  }
  expect(errors).toEqual([]);
});

test('a hungry iguana goes down to the sea, puts its snout to the algae and eats them, and comes back out to bask', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await boot(page);
  const { waterY } = await page.evaluate(() => window.__game!.ocean());
  await page.evaluate(() => (window.__game!.advance(2, false), window.__game!.iguanaDo(1, 'feed')));
  let swam = false;
  let shot = false;
  let back = false;
  /** For each patch it grazed: the closest its drawn snout came to the fronds, and whether it was under water. */
  const grazed = new Map<number, { touch: number; under: boolean }>();
  // Run it in half-second pieces, stopping early the first time its snout is in the fronds under water, for a picture.
  for (let s = 0; s < 360 && !back; s++) {
    const r = await page.evaluate(
      ([waterY, wantShot]) => {
        const g = window.__game!;
        let swam = false;
        let shot = false;
        const seen: { id: number; touch: number; under: boolean }[] = [];
        for (let k = 0; k < 30; k++) {
          g.advance(1, false);
          const ig = g.iguanas()[1];
          swam ||= ig.swimming;
          if (ig.activity !== 'graze' || !ig.meal || ig.touch === null) continue;
          const under = ig.swimming && ig.meal.y < waterY;
          seen.push({ id: ig.meal.id, touch: ig.touch, under });
          if (under && wantShot && ig.touch < 0.015) {
            // Side on, from a little behind, under the water with it.
            g.viewFrom({ x: Math.cos(ig.yaw) * 0.14 - Math.sin(ig.yaw) * 0.04, y: 0.015, z: -Math.sin(ig.yaw) * 0.14 - Math.cos(ig.yaw) * 0.04 }, { x: ig.meal.x, y: ig.meal.y + 0.01, z: ig.meal.z });
            g.advance(1);
            shot = true;
            break;
          }
        }
        const ig = g.iguanas()[1];
        return { swam, shot, seen, back: ig.meals > 0 && ig.activity === 'bask' && !ig.swimming };
      },
      [waterY, !shot] as const,
    );
    swam ||= r.swam;
    back = r.back;
    for (const v of r.seen) grazed.set(v.id, { touch: Math.min(v.touch, grazed.get(v.id)?.touch ?? Infinity), under: v.under || !!grazed.get(v.id)?.under });
    if (r.shot) {
      shot = true;
      await page.screenshot({ path: 'test-results/screenshots/iguana-graze.png' });
      await page.evaluate(() => window.__game!.viewFrom(null));
    }
  }
  const trip = await page.evaluate((ids) => {
    const g = window.__game!;
    const end = g.iguanas()[1];
    const left = new Set(g.algae().map((a) => a.id));
    return { end, shoreX: g.shoreX(end.z), eaten: ids.filter((id) => !left.has(id)).length };
  }, [...grazed.keys()]);
  // It grazed at least one patch with its snout right in the fronds, and ate it: the patch is gone.
  expect(grazed.size).toBeGreaterThan(0);
  const touched = [...grazed.values()].filter((v) => v.touch < 0.018);
  expect(touched.length).toBeGreaterThan(0);
  expect(trip.eaten).toBeGreaterThan(0);
  expect(trip.end.bites).toBeGreaterThanOrEqual(6);
  expect(trip.end.meals).toBe(1);
  // Grazing under the sea meant swimming there.
  if ([...grazed.values()].some((v) => v.under)) expect(swam).toBe(true);
  // And it came back out onto the shore to bask.
  expect(back).toBe(true);
  expect(trip.end.x).toBeLessThan(trip.shoreX);
  expect(trip.end.y).toBeGreaterThan(waterY);
  expect(errors).toEqual([]);
});

test('algae sprout now and then on the rocks, growing in from nothing', async ({ page }) => {
  const errors = await boot(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const ids = (list: { id: number }[]) => new Set(list.map((a) => a.id));
    const before = g.algae();
    // Left alone for two minutes, a few new patches come up by themselves.
    g.advance(120 * 60, false);
    const later = g.algae();
    const old = ids(before);
    const fresh = later.filter((a) => !old.has(a.id));
    // One sprouted now starts from nothing and grows in.
    const id = g.sproutAlgae()!;
    const at = (n: number) => g.algae().find((a) => a.id === n)!;
    const seedling = at(id);
    g.advance(20 * 60, false);
    const half = at(id).grown;
    g.advance(30 * 60, false);
    return { before: before.length, fresh, seedling, half, full: at(id).grown, wet: g.ocean().waterY };
  });
  expect(run.fresh.length).toBeGreaterThanOrEqual(2);
  expect(run.fresh.length).toBeLessThan(20);
  for (const a of [...run.fresh, run.seedling]) expect(a.y).toBeLessThan(run.wet + 0.02);
  expect(run.seedling.grown).toBe(0);
  expect(run.half).toBeGreaterThan(0.3);
  expect(run.half).toBeLessThan(0.7);
  expect(run.full).toBe(1);
  expect(errors).toEqual([]);
});

test('an iguana on its way goes round the lizard lying across its path instead of walking into it', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await boot(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    // Send it off to feed, and once it's walking, lie the lizard across its way 20 cm ahead.
    g.iguanaDo(0, 'feed');
    let ig = g.iguanas()[0];
    for (let k = 0; k < 900 && !(ig.activity === 'to_food' && ig.state === 'walk' && !ig.swimming); k++) {
      g.advance(1, false);
      ig = g.iguanas()[0];
    }
    g.advance(30, false);
    ig = g.iguanas()[0];
    const dx = Math.sin(ig.yaw);
    const dz = Math.cos(ig.yaw);
    const start = { x: ig.x, z: ig.z };
    const px = ig.x + dx * 0.2;
    const pz = ig.z + dz * 0.2;
    g.teleport(px, pz, ig.yaw + Math.PI / 2);
    const p = g.player();
    // The lizard's body as a segment, snout to hips (its capsule's straight part, and the caps).
    const lx = Math.sin(p.yaw);
    const lz = Math.cos(p.yaw);
    const gap = (x: number, z: number) => {
      const t = Math.max(-0.06, Math.min(0.06, (x - p.x) * lx + (z - p.z) * lz));
      return Math.hypot(x - (p.x + lx * t), z - (p.z + lz * t));
    };
    let closest = Infinity;
    let past = false;
    for (let k = 0; k < 600 && !past; k++) {
      g.advance(1, false);
      ig = g.iguanas()[0];
      // Its own body too: from its hips to its snout.
      const fx = Math.sin(ig.yaw);
      const fz = Math.cos(ig.yaw);
      for (const s of [-0.06, 0, 0.06]) closest = Math.min(closest, gap(ig.x + fx * s, ig.z + fz * s));
      past = (ig.x - start.x) * dx + (ig.z - start.z) * dz > 0.32;
    }
    const after = g.player();
    return { closest, past, pushed: Math.hypot(after.x - p.x, after.z - p.z), activity: ig.activity };
  });
  // It got past the lizard without touching it (two bodies 12 mm in radius touch at 24 mm) or pushing it.
  expect(run.past).toBe(true);
  expect(run.closest).toBeGreaterThan(0.035);
  expect(run.pushed).toBeLessThan(0.002);
  expect(errors).toEqual([]);
});

test('an iguana looking for somewhere to bask comes and lies down beside the lizard basking nearby', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await boot(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const ig0 = g.iguanas()[0];
    // A bare stretch of black lava 25-60 cm along the shore from it, no rock, log or cactus near.
    const yaw = ig0.yaw;
    let spot: { x: number; z: number } | null = null;
    for (const d of [0.25, -0.25, 0.3, -0.3, 0.35, -0.35, 0.4, -0.4, 0.45, -0.45, 0.5, -0.5, 0.55, -0.55, 0.6, -0.6]) {
      const z = ig0.z + d;
      for (const up of [0.15, 0.2, 0.25, 0.1, 0.3]) {
        const x = g.shoreX(z) - up;
        const ok = [-0.1, -0.05, 0, 0.05, 0.1].every((s) => {
          const px = x + Math.sin(yaw) * s;
          const pz = z + Math.cos(yaw) * s;
          for (const side of [-0.06, 0, 0.06]) {
            const qx = px + Math.cos(yaw) * side;
            const qz = pz - Math.sin(yaw) * side;
            if (g.lava(qx, qz) < 0.9 || Math.abs(g.groundAt(qx, qz)! - g.terrainHeight(qx, qz)) > 0.003) return false;
          }
          return true;
        });
        // With room all round to come and lie alongside.
        const roomy = g.obstacles().every((o) => Math.hypot(o.x - x, o.z - z) > o.radius + 0.09);
        if (ok && roomy) {
          spot = { x, z };
          break;
        }
      }
      if (spot) break;
    }
    if (!spot) throw new Error('no bare lava near the iguana');
    g.teleport(spot.x, spot.z, yaw);
    g.advance(30, false);
    g.iguanaDo(0, 'move');
    let ig = g.iguanas()[0];
    let mate: string | number | null = null;
    for (let k = 0; k < 1500; k++) {
      g.advance(1, false);
      ig = g.iguanas()[0];
      mate ??= ig.mate;
      if (k > 300 && ig.activity === 'bask' && ig.state === 'idle') break;
    }
    g.advance(240, false);
    ig = g.iguanas()[0];
    const p = g.player();
    g.viewFrom({ x: -0.18, y: 0.14, z: 0.12 }, { x: (ig.x + p.x) / 2, y: p.y + 0.02, z: (ig.z + p.z) / 2 });
    g.advance(2);
    return { mate, ig, p, apart: Math.hypot(ig.x - p.x, ig.z - p.z) };
  });
  await page.screenshot({ path: 'test-results/screenshots/iguana-bask-together.png' });
  // It went to the lizard, and lies alongside it, the same way round, on the lava.
  expect(run.mate).toBe('player');
  expect(run.ig.activity).toBe('bask');
  expect(run.apart).toBeLessThan(0.07);
  expect(Math.abs(Math.cos(run.ig.yaw - run.p.yaw))).toBeGreaterThan(0.9);
  expect(run.ig.lava).toBeGreaterThan(0.8);
  expect(errors).toEqual([]);
});

test('crabs groom the other iguanas too, hopping onto a still one and off again when it moves', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await boot(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    // Keep the lizard out of it, inland.
    g.teleport(0, 0, 0);
    let groomed: { crab: number; iguana: number } | null = null;
    for (let s = 0; s < 120 && !groomed; s++) {
      g.advance(30, false);
      const i = g.crabs().findIndex((c) => c.state === 'groom' && typeof c.grooming === 'number');
      if (i >= 0) groomed = { crab: i, iguana: g.crabs()[i].grooming as number };
    }
    if (!groomed) return { groomed, count: g.crabs().length };
    const c = g.crabs()[groomed.crab];
    const ig = g.iguanas()[groomed.iguana];
    g.viewFrom({ x: Math.cos(ig.yaw) * 0.16, y: 0.1, z: -Math.sin(ig.yaw) * 0.16 }, { x: ig.x, y: ig.y + 0.02, z: ig.z });
    g.advance(2);
    // Up on its back, then off again once the iguana gets up.
    const onBack = c.y - ig.y;
    g.iguanaDo(groomed.iguana, 'feed');
    let off = false;
    for (let k = 0; k < 600 && !off; k++) {
      g.advance(1, false);
      const now = g.crabs()[groomed.crab];
      off = now.state !== 'groom' && now.state !== 'hop';
    }
    return { groomed, count: g.crabs().length, onBack, off, igState: g.iguanas()[groomed.iguana].activity };
  });
  await page.screenshot({ path: 'test-results/screenshots/crab-grooms-iguana.png' });
  expect(run.count).toBeGreaterThanOrEqual(15);
  expect(run.groomed).not.toBeNull();
  expect(run.onBack).toBeGreaterThan(0.015);
  expect(run.off).toBe(true);
  expect(errors).toEqual([]);
});
