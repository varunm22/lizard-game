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
    // Broadside: facing within about 25° of square to the sun.
    expect(Math.abs(Math.cos(ig.yaw - sunYaw))).toBeLessThan(0.45);
  }
  expect(errors).toEqual([]);
});

test('a hungry iguana goes down to the sea, grazes algae, and comes back out to bask', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await boot(page);
  const { waterY } = await page.evaluate(() => window.__game!.ocean());
  await page.evaluate(() => (window.__game!.advance(2, false), window.__game!.iguanaDo(1, 'feed')));
  let swam = false;
  let grazedUnder = false;
  let back = false;
  const grazes: { snout: number; level: number }[] = [];
  // Run it in half-second pieces, stopping early at the start of its first graze under water for a picture.
  for (let s = 0; s < 360 && !back; s++) {
    const r = await page.evaluate(
      ([waterY, wantShot]) => {
        const g = window.__game!;
        let swam = false;
        let started: { snout: number; level: number; under: boolean } | null = null;
        for (let k = 0; k < 30; k++) {
          const was = g.iguanas()[1].activity === 'graze';
          g.advance(1, false);
          const ig = g.iguanas()[1];
          swam ||= ig.swimming;
          if (ig.activity === 'graze' && !was && ig.meal) {
            const sx = ig.x + Math.sin(ig.yaw) * 0.08;
            const sz = ig.z + Math.cos(ig.yaw) * 0.08;
            started = { snout: Math.hypot(sx - ig.meal.x, sz - ig.meal.z), level: Math.abs(ig.y - ig.meal.y), under: ig.swimming && ig.meal.y < waterY };
            if (started.under && wantShot) {
              // Side on, from a little behind, under the water with it.
              g.viewFrom({ x: Math.cos(ig.yaw) * 0.16 - Math.sin(ig.yaw) * 0.06, y: 0.02, z: -Math.sin(ig.yaw) * 0.16 - Math.cos(ig.yaw) * 0.06 }, { x: ig.x, y: ig.y + 0.02, z: ig.z });
              g.advance(20);
              break;
            }
          }
        }
        const ig = g.iguanas()[1];
        return { swam, started, back: ig.meals > 0 && ig.activity === 'bask' && !ig.swimming };
      },
      [waterY, !grazedUnder] as const,
    );
    swam ||= r.swam;
    back = r.back;
    if (r.started) {
      grazes.push(r.started);
      if (r.started.under && !grazedUnder) {
        grazedUnder = true;
        await page.screenshot({ path: 'test-results/screenshots/iguana-graze.png' });
        await page.evaluate(() => window.__game!.viewFrom(null));
      }
    }
  }
  const trip = await page.evaluate(() => {
    const g = window.__game!;
    const end = g.iguanas()[1];
    return { end, shoreX: g.shoreX(end.z) };
  });
  // It grazed at least one patch, its snout at the algae, and ate.
  expect(grazes.length).toBeGreaterThan(0);
  for (const gz of grazes) {
    expect(gz.snout).toBeLessThan(0.05);
    expect(gz.level).toBeLessThan(0.05);
  }
  expect(trip.end.bites).toBeGreaterThan(3);
  expect(trip.end.meals).toBe(1);
  // Grazing under the sea meant swimming there.
  if (grazedUnder) expect(swam).toBe(true);
  // And it came back out onto the shore to bask.
  expect(back).toBe(true);
  expect(trip.end.x).toBeLessThan(trip.shoreX);
  expect(trip.end.y).toBeGreaterThan(waterY);
  expect(errors).toEqual([]);
});
