import { expect, test, type Page } from '@playwright/test';

async function boot(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true);
  return errors;
}

test('the hawk loads with its clips and sits on a perch, calm, at the start', async ({ page }) => {
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(60, false);
    return { clips: g.hawkClips(), hawk: g.hawk(), wounds: g.wounds() };
  });
  for (const c of ['glide', 'flap', 'stoop', 'strike', 'perch', 'land', 'take_off']) expect(r.clips).toContain(c);
  expect(r.hawk.state).toBe('perch');
  expect(r.hawk.clip).toBe('perch');
  expect(r.hawk.perch).toBeGreaterThanOrEqual(0);
  expect(r.hawk.speed).toBeLessThan(1e-3);
  expect(r.hawk.hunting).toBe(false);
  expect(r.wounds).toMatchObject({ hits: 0, down: false, countdown: null });
  expect(errors).toEqual([]);
});

test('hunting in the open, three strikes jerk the lizard aside, knock it down and it comes back at the spawn', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const spawn = g.player();
    g.hawkDo('hunt');
    const hits: { jerk: number; flinched: boolean; clip: string | null }[] = [];
    let downAt = -1;
    let i = 0;
    for (; i < 60 * 60 && hits.length < 3; i++) {
      const before = g.player();
      const was = g.wounds().hits;
      g.advance(1, false);
      if (g.wounds().hits > was) {
        const clip = g.hawk().clip;
        g.advance(8, false);
        const after = g.player();
        hits.push({ jerk: Math.hypot(after.x - before.x, after.z - before.z), flinched: g.wounds().flinching, clip });
        if (g.wounds().down) downAt = i;
      }
    }
    // Lying down: input does nothing, the collapse clip plays and the countdown runs.
    g.advance(50, false);
    const lying = g.player();
    g.setInput({ move: { x: 0, y: 1 }, run: true }, 60);
    g.advance(60, false);
    const moved = Math.hypot(g.player().x - lying.x, g.player().z - lying.z);
    const down = { wounds: g.wounds(), clip: g.lizard().current, moved };
    let back = -1;
    for (let j = 0; j < 5 * 60; j++) {
      g.advance(1, false);
      if (!g.wounds().down) {
        back = j;
        break;
      }
    }
    g.advance(2, false);
    return { spawn, hits, downAt, down, back, after: g.player(), wounds: g.wounds() };
  });
  expect(r.hits).toHaveLength(3);
  for (const h of r.hits) {
    // Each strike throws the lizard a few cm sideways and it flinches.
    expect(h.jerk).toBeGreaterThan(0.025);
    expect(h.flinched).toBe(true);
    expect(h.clip).toBe('strike');
  }
  expect(r.downAt).toBeGreaterThan(0);
  expect(r.down.wounds.down).toBe(true);
  expect(r.down.wounds.countdown).not.toBeNull();
  expect(r.down.clip).toBe('collapse');
  expect(r.down.moved).toBeLessThan(0.005);
  // Back up after the collapse and the 3 s countdown (about 1.85 s were already spent lying there).
  expect(r.back).toBeGreaterThan(60);
  expect(r.back).toBeLessThan(3 * 60);
  expect(r.wounds.hits).toBe(0);
  expect(Math.hypot(r.after.x - r.spawn.x, r.after.z - r.spawn.z)).toBeLessThan(0.02);
  expect(errors).toEqual([]);
});

test('hiding under water, the hawk loses interest and the hits heal', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    g.hawkDo('hunt');
    let i = 0;
    for (; i < 60 * 60 && g.wounds().hits < 1; i++) g.advance(1, false);
    const hit = g.wounds().hits;
    // Dive out of sight: deep in the open sea, east of the shore.
    const { waterY } = g.ocean();
    const z = 0.2;
    g.teleport(g.shoreX(z) + 1.3, z, Math.PI / 2, waterY - 0.08);
    g.advance(2, false);
    const seen = g.inSight({ x: g.hawk().x, y: g.hawk().y, z: g.hawk().z }, g.player().x, g.player().y + 0.02, g.player().z);
    let lost = -1;
    for (let j = 0; j < 8 * 60; j++) {
      g.advance(1, false);
      if (!g.hawk().hunting) {
        lost = j;
        break;
      }
    }
    const atLoss = g.wounds();
    g.advance(4 * 60, false);
    return { hit, seen, lost, atLoss, healed: g.wounds(), hawk: g.hawk() };
  });
  expect(r.hit).toBeGreaterThanOrEqual(1);
  expect(r.seen).toBe(false);
  // Out of sight for about 3 s, it gives up and heads back to a perch.
  expect(r.lost).toBeGreaterThan(2 * 60);
  expect(r.lost).toBeLessThan(5 * 60);
  expect(r.atLoss.hunted).toBe(false);
  expect(r.healed.hits).toBe(0);
  expect(r.healed.down).toBe(false);
  expect(['return', 'land', 'perch', 'soar']).toContain(r.hawk.state);
  expect(errors).toEqual([]);
});
