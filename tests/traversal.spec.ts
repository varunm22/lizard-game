import { expect, test, type Page } from '@playwright/test';

/** Wait for `n` more fixed physics steps (1/60 s each), however slowly the headless GPU renders. */
async function steps(page: Page, n: number) {
  const start = await page.evaluate(() => window.__game!.physicsSteps);
  await page.waitForFunction((target) => window.__game!.physicsSteps >= target, start + n, { timeout: 30_000 });
}

const player = (page: Page) => page.evaluate(() => window.__game!.player());

type Drive = { move?: { x: number; y: number }; run?: boolean; jump?: boolean };

/** Hold `input` for exactly `n` physics steps (step-exact, unlike real key presses), then let go. */
async function drive(page: Page, input: Drive, n: number) {
  await page.evaluate(([i, n]) => window.__game!.setInput(i as Drive, n as number), [input, n] as const);
  await steps(page, n + 1);
}

async function boot(page: Page, x: number, z: number, yaw: number) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true);
  await page.evaluate(([x, z, yaw]) => window.__game!.teleport(x, z, yaw), [x, z, yaw]);
  await steps(page, 20);
  return errors;
}

test('WASD keys walk the lizard and it comes to rest', async ({ page }) => {
  const errors = await boot(page, 0.6, 0.6, 0);
  await page.keyboard.down('KeyW');
  await steps(page, 60);
  const mid = await player(page);
  expect(mid.state).toBe('walk');
  expect(mid.speed).toBeGreaterThan(0.22);
  expect(mid.speed).toBeLessThan(0.28);
  expect(await page.evaluate(() => window.__game!.lizard().current)).toBe('walk');
  await page.screenshot({ path: 'test-results/screenshots/walk.png' });
  await page.keyboard.up('KeyW');
  await steps(page, 30);
  expect((await player(page)).state).toBe('idle');
  expect(errors).toEqual([]);
});

test('walking forward for 2 s covers ~0.5 m, following the ground', async ({ page }) => {
  // Open ground, camera behind looking +Z: forward is +Z.
  await boot(page, 0.6, 0.3, 0);
  const start = await player(page);
  expect(start.grounded).toBe(true);
  await drive(page, { move: { x: 0, y: 1 } }, 120);
  const end = await player(page);
  // 2 s at 0.25 m/s, minus a short ramp-up.
  expect(end.z - start.z).toBeGreaterThan(0.45);
  expect(end.z - start.z).toBeLessThan(0.51);
  expect(Math.abs(end.x - start.x)).toBeLessThan(0.01);
  expect(end.grounded).toBe(true);
  const ground = await page.evaluate(([x, z]) => window.__game!.terrainHeight(x, z), [end.x, end.z]);
  expect(Math.abs(end.y - ground)).toBeLessThan(0.006);
  // Facing turned to the direction of travel (+Z is yaw 0).
  expect(Math.abs(end.yaw)).toBeLessThan(0.05);
});

test('running is faster, and strafing is camera-relative', async ({ page }) => {
  await boot(page, 0.6, 0.6, 0);
  await page.evaluate(() => window.__game!.setInput({ move: { x: 1, y: 0 }, run: true }, 90));
  await steps(page, 45);
  const p = await player(page);
  expect(p.state).toBe('run');
  expect(p.speed).toBeGreaterThan(0.55);
  // With the camera looking +Z, "right" is -X; the lizard turned to face it.
  expect(p.x).toBeLessThan(0.6 - 0.2);
  expect(Math.abs(Math.abs(p.yaw) - Math.PI / 2)).toBeLessThan(0.1);
  await page.screenshot({ path: 'test-results/screenshots/run.png' });
});

test('jump rises about 8 cm, falls, lands and settles', async ({ page }) => {
  await boot(page, 0.6, 0.3, 0);
  const start = await player(page);
  await page.evaluate(() => window.__game!.setInput({ jump: true }, 40));
  const seen = new Set<string>();
  let peak = start.y;
  for (let i = 0; i < 40; i++) {
    await steps(page, 1);
    const p = await player(page);
    seen.add(p.state);
    peak = Math.max(peak, p.y);
    if (i === 6) await page.screenshot({ path: 'test-results/screenshots/jump.png' });
  }
  await steps(page, 30);
  const end = await player(page);
  expect(peak - start.y).toBeGreaterThan(0.07);
  expect(peak - start.y).toBeLessThan(0.09);
  expect(seen).toContain('jump');
  expect(seen).toContain('fall');
  expect(end.grounded).toBe(true);
  expect(end.state).toBe('idle');
  expect(Math.abs(end.y - start.y)).toBeLessThan(0.005);
});

test('a tap gives a lower hop than a held jump', async ({ page }) => {
  await boot(page, 0.6, 0.3, 0);
  const start = await player(page);
  await page.evaluate(() => window.__game!.setInput({ jump: true }, 1));
  let peak = start.y;
  for (let i = 0; i < 25; i++) {
    await steps(page, 1);
    peak = Math.max(peak, (await player(page)).y);
  }
  expect(peak - start.y).toBeGreaterThan(0.01);
  expect(peak - start.y).toBeLessThan(0.05);
});

test('the log blocks walking but can be jumped over', async ({ page }) => {
  // South of the log's middle, facing -Z toward it.
  const log = (await (async () => {
    await page.goto('/');
    await page.waitForFunction(() => window.__game?.ready === true);
    return page.evaluate(() => window.__game!.obstacles().find((o) => o.name === 'log')!);
  })())!;
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, Math.PI), [log.x, log.z + 0.25]);
  await steps(page, 10);

  await page.keyboard.down('KeyW');
  await steps(page, 120);
  const blocked = await player(page);
  expect(blocked.z).toBeGreaterThan(log.z + 0.04); // stopped on the near side
  await page.screenshot({ path: 'test-results/screenshots/log-blocked.png' });

  // Back up for a run-up, then run and jump.
  await page.keyboard.up('KeyW');
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, Math.PI), [log.x, log.z + 0.25]);
  await steps(page, 5);
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await page.waitForFunction((z) => window.__game!.player().z < z, log.z + 0.12, { timeout: 30_000 });
  await page.keyboard.down('Space');
  await steps(page, 50);
  await page.keyboard.up('Space');
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  await steps(page, 30);
  const over = await player(page);
  expect(over.z).toBeLessThan(log.z - 0.06); // cleared it
  expect(over.grounded).toBe(true);
});

test('camera orbits on drag and is pulled in rather than passing through the big rock', async ({ page }) => {
  await boot(page, 0.1, 0.05, Math.PI);
  const before = await page.evaluate(() => window.__game!.camera());

  // Drag right with the mouse: the view turns right (yaw decreases).
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.mouse.move(740, 360, { steps: 5 });
  await page.mouse.up();
  await steps(page, 5);
  const after = await page.evaluate(() => window.__game!.camera());
  expect(after.yaw).toBeLessThan(before.yaw - 0.3);

  // Stand just in front of the big rock, facing away from it, so the camera arm runs into it.
  const rock = await page.evaluate(() => window.__game!.obstacles().find((o) => o.name === 'rock-big')!);
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, 0), [rock.x, rock.z + 0.15]);
  await steps(page, 30);
  const cam = await page.evaluate(() => window.__game!.camera());
  expect(cam.arm).toBeLessThan(cam.distance - 0.1);
  const d = Math.hypot(cam.x - rock.x, cam.z - rock.z);
  expect(d).toBeGreaterThan(0.09); // outside the rock's radius
  const ground = await page.evaluate(([x, z]) => window.__game!.terrainHeight(x, z), [cam.x, cam.z]);
  expect(cam.y).toBeGreaterThan(ground);
  await page.screenshot({ path: 'test-results/screenshots/camera-pull-in.png' });
});
