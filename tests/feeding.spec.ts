import { expect, test, type Page } from '@playwright/test';

async function boot(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true);
  // Keep the hawk from striking the lizard mid-test (hawk.spec.ts is about it).
  await page.evaluate(() => window.__game!.hawkDo('off'));
  return errors;
}

test('F bites: the head lifts with the mouth open, lunges and snaps shut, and nothing is eaten with no algae at the mouth', async ({ page }) => {
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(30, false);
    const rest = g.lizard().jawOpen;
    const started = g.bite();
    const again = g.bite();
    let open = 0;
    let headDip = 0;
    const head0 = g.lizard().head.y;
    let steps = 0;
    for (; steps < 120 && g.lizard().biting; steps++) {
      g.advance(1, false);
      open = Math.max(open, g.lizard().jawOpen);
      headDip = Math.max(headDip, head0 - g.lizard().head.y);
    }
    g.advance(2, false);
    return { rest, started, again, open, headDip, steps, after: g.lizard().jawOpen, feeding: g.feeding() };
  });
  expect(r.rest).toBeLessThan(0.01);
  expect(r.started).toBe(true);
  // One bite at a time.
  expect(r.again).toBe(false);
  // The mouth opens wide, and shuts again by the end, after about 0.6 s.
  expect(r.open).toBeGreaterThan(0.35);
  expect(r.after).toBeLessThan(0.01);
  expect(r.steps).toBeGreaterThan(30);
  expect(r.steps).toBeLessThan(45);
  expect(r.feeding).toEqual({ bites: 1, mouthfuls: 0, lastBite: null });
  expect(errors).toEqual([]);
});

test('biting algae at the snout trims it down, and enough bites eat it', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const { waterY } = g.ocean();
    // Algae just above the water on the lava, on fairly level ground, where the lizard can stand with its snout over it.
    const pick = g.algae().filter((a) => a.grown > 0.99 && a.y > waterY + 0.003);
    for (const a of pick) {
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        // The snout is about 6.5 cm ahead of the feet.
        const x = a.x - fx * 0.062;
        const z = a.z - fz * 0.062;
        const ground = g.groundAt(x, z);
        if (ground === null || ground < waterY + 0.002 || Math.abs(ground - a.y) > 0.01) continue;
        g.teleport(x, z, yaw, ground + 0.002);
        g.advance(30, false);
        const p = g.player();
        const s = g.lizard().snout;
        if (!p.grounded || p.swimming || Math.hypot(s.x - a.x, s.z - a.z) > 0.012 || s.y > a.y + 0.03) continue;
        const got: ({ id: number; ate: boolean } | null)[] = [];
        for (let b = 0; b < 8 && g.algae().some((o) => o.id === a.id); b++) {
          g.bite();
          for (let k = 0; k < 40; k++) g.advance(1, false);
          got.push(g.feeding().lastBite);
        }
        return { found: true, id: a.id, got, gone: !g.algae().some((o) => o.id === a.id), feeding: g.feeding() };
      }
    }
    return { found: false };
  });
  expect(r.found).toBe(true);
  // Every bite got that patch, and the sixth ate the last of it.
  expect(r.got!.length).toBe(6);
  expect(r.got!.every((b) => b?.id === r.id)).toBe(true);
  expect(r.got!.map((b) => b!.ate)).toEqual([false, false, false, false, false, true]);
  expect(r.gone).toBe(true);
  expect(r.feeding).toMatchObject({ bites: 6, mouthfuls: 6 });
  expect(errors).toEqual([]);
});

test('a wild iguana grazing plays the bite, and each bite takes some of the patch', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await boot(page);
  await page.evaluate(() => (window.__game!.advance(2, false), window.__game!.iguanaDo(0, 'feed')));
  let sawBiting = false;
  let bites = 0;
  let shot = false;
  for (let s = 0; s < 240 && bites < 2; s++) {
    const r = await page.evaluate((wantShot) => {
      const g = window.__game!;
      let biting = false;
      let shot = false;
      for (let k = 0; k < 30; k++) {
        g.advance(1, false);
        const ig = g.iguanas()[0];
        biting ||= ig.biting;
        if (wantShot && ig.biting && ig.meal) {
          // Mid-bite, side on.
          const c = Math.cos(ig.yaw);
          const n = Math.sin(ig.yaw);
          for (let j = 0; j < 9; j++) g.advance(1, false);
          g.viewFrom({ x: c * 0.11 - n * 0.02, y: 0.02, z: -n * 0.11 - c * 0.02 }, { x: ig.meal.x, y: ig.meal.y + 0.012, z: ig.meal.z });
          g.advance(1);
          shot = true;
          break;
        }
      }
      return { biting, shot, bites: g.iguanas()[0].bites };
    }, !shot);
    sawBiting ||= r.biting;
    bites = r.bites;
    if (r.shot) {
      shot = true;
      await page.screenshot({ path: 'test-results/screenshots/iguana-bite.png' });
      await page.evaluate(() => window.__game!.viewFrom(null));
    }
  }
  expect(sawBiting).toBe(true);
  expect(bites).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});
