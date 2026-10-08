import { expect, test } from '@playwright/test';
import { bootGame } from './helpers/bootGame';
import { screenshot } from './helpers/screenshot';

test('basking: lying still in the sun warms the lizard, best on lava, better up on a rock than on the ground, and better beside other lizards', async ({ page }) => {
  const errors = await bootGame(page, { vitals: true, iguanas: [0, 1] });
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    // Lie still at (x, z) for 2 s, from half warm, and read how fast it warms and what it lay on.
    const bask = (x: number, z: number, y?: number) => {
      g.teleport(x, z, 0, y);
      g.setVitals({ warmth: 0.5, health: 1, fullness: 0.7 });
      g.advance(120, false);
      const v = g.vitals();
      return { rate: v.rate.warmth, ...v.climate, grounded: g.player().grounded, moved: Math.hypot(g.player().x - x, g.player().z - z) };
    };
    // The first spot of each kind the sun fully reaches.
    const sunny = (spots: [number, number, number?][], ok: (b: ReturnType<typeof bask>) => boolean) => {
      for (const [x, z, y] of spots) {
        const b = bask(x, z, y);
        if (b.sun === 1 && b.grounded && ok(b)) return { x, z, ...b };
      }
      return null;
    };
    const grid: [number, number][] = [];
    for (let x = -1; x <= 1.2; x += 0.1) for (let z = -3; z <= 3.4; z += 0.1) grid.push([x, z]);
    // Away from the other iguanas, so it's alone.
    const igs = g.iguanas();
    const alone = ([x, z]: [number, number]) => igs.every((i) => Math.hypot(i.x - x, i.z - z) > 0.5);
    const ground = sunny(
      grid.filter((p) => alone(p) && g.lava(p[0], p[1]) < 0.05 && (g.groundAt(p[0], p[1]) ?? -1) > 0.02 && Math.abs(g.groundAt(p[0], p[1])! - g.terrainHeight(p[0], p[1])) < 0.002),
      (b) => b.surfaceKind === 'ground' && b.company === 0,
    );
    const lava = sunny(
      grid.filter((p) => alone(p) && g.lava(p[0], p[1]) > 0.95 && (g.groundAt(p[0], p[1]) ?? -1) > g.ocean().waterY + 0.03 && Math.abs(g.groundAt(p[0], p[1])! - g.terrainHeight(p[0], p[1])) < 0.002),
      (b) => b.surfaceKind === 'lava' && b.company === 0,
    );
    const rocks = g.obstacles().filter((o) => o.kind === 'rock' && g.lava(o.x, o.z) < 0.05 && o.height > 0.03);
    const rock = sunny(
      rocks.map((o) => [o.x, o.z, g.groundAt(o.x, o.z)! + 0.002] as [number, number, number]),
      (b) => b.surfaceKind === 'raised' && b.company === 0,
    );
    // Two iguanas brought to lie beside it on that same lava.
    let company = null;
    if (lava) {
      g.iguanaPlace(0, lava.x + 0.07, lava.z, 0, 60);
      g.iguanaPlace(1, lava.x - 0.07, lava.z, 0, 60);
      g.advance(2, false);
      company = bask(lava.x, lava.z);
    }
    // In a tree's shade it cools: a spot beside a trunk, away from the sun.
    let shade = null;
    for (const t of g.obstacles().filter((o) => o.kind === 'tree')) {
      const b = bask(t.x - 0.1, t.z - 0.07);
      if (b.grounded && b.sun < 0.5) {
        shade = b;
        break;
      }
    }
    return { ground, lava, rock, company, shade };
  });
  for (const b of [r.ground, r.lava, r.rock, r.company]) {
    expect(b).not.toBeNull();
    expect(b!.moved).toBeLessThan(0.01);
  }
  expect(r.ground!.rate).toBeGreaterThan(0);
  expect(r.rock!.rate).toBeGreaterThan(r.ground!.rate * 1.2);
  expect(r.lava!.rate).toBeGreaterThan(r.rock!.rate);
  expect(r.company!.company).toBe(2);
  expect(r.company!.rate).toBeGreaterThan(r.lava!.rate * 1.4);
  expect(r.shade).not.toBeNull();
  expect(r.shade!.rate).toBeLessThan(0);
  expect(errors).toEqual([]);
});

test('under water the lizard cools and runs out of air, then drowns; at the surface it breathes', async ({ page }) => {
  const errors = await bootGame(page, { vitals: true });
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const { waterY } = g.ocean();
    const z = 0.2;
    g.teleport(g.shoreX(z) + 1.3, z, Math.PI / 2, waterY - 0.08);
    g.setVitals({ warmth: 1, health: 1, fullness: 1, air: 1 });
    g.advance(10 * 60, false);
    const dived = g.vitals();
    // Tapping Space keeps it up at the surface, breathing.
    g.setVitals({ air: 0.5 });
    let breathed = 0;
    for (let i = 0; i < 40; i++) {
      g.setInput({ jump: i % 2 === 0 }, 15);
      g.advance(15, false);
      if (!g.vitals().climate.underwater) breathed++;
    }
    const surfaced = g.vitals();
    // Deep down with no air, it drowns.
    g.setInput(null);
    g.teleport(g.shoreX(z) + 1.3, z, Math.PI / 2, waterY - 0.08);
    g.setVitals({ air: 0, warmth: 1, health: 1 });
    let downAt = -1;
    for (let i = 0; i < 20 * 60; i++) {
      g.advance(1, false);
      if (g.wounds().down) {
        downAt = i;
        break;
      }
    }
    return { dived, breathed, surfaced, downAt, wounds: g.wounds() };
  });
  expect(r.dived.climate.underwater).toBe(true);
  // 10 s under: 40% of its air and 14% of its warmth.
  expect(r.dived.air).toBeCloseTo(0.6, 2);
  expect(r.dived.warmth).toBeCloseTo(0.86, 2);
  expect(r.breathed).toBeGreaterThan(5);
  expect(r.surfaced.air).toBeGreaterThan(0.5);
  // Out of air, 8% of its health a second: down after about 12.5 s.
  expect(r.downAt).toBeGreaterThan(11 * 60);
  expect(r.downAt).toBeLessThan(14 * 60);
  expect(r.wounds.downBy).toBe('air');
  expect(errors).toEqual([]);
});

test('cold, the lizard walks slower and loses health; fed and warm it mends, hungry it does not', async ({ page }) => {
  const errors = await bootGame(page, { vitals: true });
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const walk = (warmth: number) => {
      g.teleport(0.1, 0.05, Math.PI);
      g.advance(10, false);
      g.setVitals({ warmth, frozen: true });
      g.setInput({ move: { x: 0, y: 1 } }, 50);
      // Its speed once it's under way.
      g.advance(20, false);
      let speed = 0;
      for (let i = 0; i < 30; i++) {
        g.advance(1, false);
        speed += g.player().speed / 30;
      }
      g.setVitals({ frozen: false });
      return { speed, scale: g.vitals().speedScale };
    };
    const warm = walk(0.8);
    const cold = walk(0.05);
    g.advance(60, false);
    // Freezing: health drains.
    g.teleport(0.1, 0.05, Math.PI);
    g.setVitals({ warmth: 0.05, health: 0.5, fullness: 0.9 });
    g.advance(60, false);
    const freezing = g.vitals();
    // Warm and fed: it mends. Starving: it doesn't.
    g.setVitals({ warmth: 0.9, health: 0.5, fullness: 0.9 });
    g.advance(120, false);
    const fed = g.vitals();
    g.setVitals({ warmth: 0.9, health: 0.5, fullness: 0.1 });
    g.advance(120, false);
    const hungry = g.vitals();
    g.setVitals({ warmth: 0.9, health: 0.5, fullness: 0 });
    g.advance(120, false);
    const starving = g.vitals();
    return { warm, cold, freezing, fed, hungry, starving };
  });
  expect(r.warm.scale).toBe(1);
  expect(r.cold.scale).toBeLessThan(0.65);
  expect(r.warm.speed).toBeGreaterThan(0.24);
  expect(r.cold.speed / r.warm.speed).toBeCloseTo(r.cold.scale, 1);
  expect(r.freezing.health).toBeLessThan(0.5);
  expect(r.freezing.rate.health).toBeLessThan(0);
  expect(r.fed.health).toBeGreaterThan(0.51);
  expect(r.hungry.health).toBe(0.5);
  expect(r.starving.health).toBeLessThan(0.5);
  expect(errors).toEqual([]);
});

test('the bars show in the bottom corner', async ({ page }) => {
  const errors = await bootGame(page, { vitals: true });
  await page.evaluate(() => {
    const g = window.__game!;
    g.setVitals({ health: 0.6, warmth: 0.35, fullness: 0.5, air: 0.8, frozen: true });
    g.advance(10, false);
  });
  await expect(page.getByText(/^Respawn in/)).toHaveCount(0);
  for (const label of ['Health', 'Warmth', 'Food', 'Air']) {
    const box = await page.getByText(label, { exact: true }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThan(1000);
    expect(box!.y).toBeGreaterThan(600);
  }
  await screenshot(page, 'vitals-hud.png');
  // At no health it goes down, and a 5 s countdown to the respawn shows at once.
  const down = await page.evaluate(() => {
    const g = window.__game!;
    g.setVitals({ health: 0 });
    g.advance(1, false);
    return g.wounds().countdown;
  });
  await expect(page.getByText('Respawn in 5', { exact: true })).toBeVisible();
  const steps = await page.evaluate(() => {
    const g = window.__game!;
    let steps = 1;
    while (g.wounds().down && steps < 10 * 60) {
      g.advance(1, false);
      steps++;
    }
    return steps;
  });
  expect(down).toBe(5);
  expect(steps).toBeGreaterThan(4.9 * 60);
  expect(steps).toBeLessThan(5.1 * 60);
  expect(errors).toEqual([]);
});
