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

test('running is faster than walking', async ({ page }) => {
  await boot(page, 0.6, 0.6, 0);
  await page.evaluate(() => window.__game!.setInput({ move: { x: 0, y: 1 }, run: true }, 90));
  await steps(page, 45);
  const p = await player(page);
  expect(p.state).toBe('run');
  expect(p.speed).toBeGreaterThan(0.55);
  expect(Math.abs(p.yaw)).toBeLessThan(0.05);
  await page.screenshot({ path: 'test-results/screenshots/run.png' });
});

test('A/D while standing still only turn the head; the lizard stays put', async ({ page }) => {
  await boot(page, 0.6, 0.6, 0);
  const start = await player(page);
  const restHead = (await page.evaluate(() => window.__game!.lizard())).head;
  await page.evaluate(() => window.__game!.setInput({ move: { x: 1, y: 0 } }, 40));
  await steps(page, 25);
  const head = (await page.evaluate(() => window.__game!.lizard())).head;
  // The head swings toward the lizard's right, which is -X in its own frame.
  expect(head.x).toBeLessThan(restHead.x - 0.005);
  await page.screenshot({ path: 'test-results/screenshots/look-right.png' });
  await steps(page, 20);
  const p = await player(page);
  expect(p.yaw).toBe(start.yaw);
  expect(Math.hypot(p.x - start.x, p.z - start.z)).toBeLessThan(0.002);
  expect(p.state).toBe('idle');
  // Let go and the head comes back to centre.
  await steps(page, 30);
  const back = (await page.evaluate(() => window.__game!.lizard())).head;
  expect(Math.abs(back.x - restHead.x)).toBeLessThan(0.003);
});

test('W with D walks a curve to the right; S backs up without turning', async ({ page }) => {
  await boot(page, 0.6, 0.3, 0);
  const start = await player(page);
  // Facing +Z, the lizard's right is -X.
  await drive(page, { move: { x: 1, y: 1 } }, 30);
  const curved = await player(page);
  expect(curved.z).toBeGreaterThan(start.z + 0.03);
  expect(curved.x).toBeLessThan(start.x - 0.005);
  // 0.5 s at 90°/s.
  expect(curved.yaw).toBeLessThan(-0.6);
  expect(curved.yaw).toBeGreaterThan(-0.85);

  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, 0), [start.x, start.z]);
  await steps(page, 5);
  await drive(page, { move: { x: 0, y: -1 } }, 60);
  const back = await player(page);
  expect(back.z).toBeLessThan(start.z - 0.1);
  expect(Math.abs(back.yaw)).toBeLessThan(0.01);
});

test('the camera swings back behind the lizard as it turns', async ({ page }) => {
  await boot(page, 0.6, 0.6, 0);
  await drive(page, { move: { x: 1, y: 1 } }, 60);
  await steps(page, 60);
  const p = await player(page);
  const cam = await page.evaluate(() => window.__game!.camera());
  const diff = Math.atan2(Math.sin(cam.yaw - p.yaw), Math.cos(cam.yaw - p.yaw));
  expect(Math.abs(diff)).toBeLessThan(0.3);
});

test('jump rises about 8 cm, falls, lands and settles', async ({ page }) => {
  await boot(page, 0.6, 0.3, 0);
  const start = await player(page);
  await page.evaluate(() => window.__game!.setInput({ jump: true }, 40));
  const seen = new Set<string>();
  let peak = start.y;
  const camStart = (await page.evaluate(() => window.__game!.camera())).y;
  let camHigh = camStart;
  for (let i = 0; i < 40; i++) {
    await steps(page, 1);
    const p = await player(page);
    seen.add(p.state);
    peak = Math.max(peak, p.y);
    camHigh = Math.max(camHigh, (await page.evaluate(() => window.__game!.camera())).y);
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
  // The camera holds its height through a hop on flat ground instead of bobbing after it.
  expect(camHigh - camStart).toBeLessThan(0.003);
});

test('a jump is a quick arc: back on the ground within 0.3 s', async ({ page }) => {
  await boot(page, 0.6, 0.3, 0);
  const startY = (await player(page)).y;
  await page.evaluate(() => window.__game!.setInput({ jump: true }, 30));
  const start = await page.evaluate(() => window.__game!.physicsSteps);
  await page.waitForFunction(() => window.__game!.player().state === 'fall', undefined, { timeout: 30_000 });
  await page.waitForFunction(() => window.__game!.player().grounded, undefined, { timeout: 30_000 });
  const airSteps = (await page.evaluate(() => window.__game!.physicsSteps)) - start;
  expect(airSteps).toBeLessThan(18);
  // Grounded means on the ground, not still drifting down the last few centimetres.
  expect(Math.abs((await player(page)).y - startY)).toBeLessThan(0.003);
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
  // Stopped on the near side, with the snout (6 cm ahead of the body centre) still outside the log.
  // The log lies yawed 0.4 rad, so measure square to its axis; the lizard may slide along it.
  const across = (blocked.x - log.x) * Math.sin(0.4) + (blocked.z - log.z) * Math.cos(0.4);
  expect(across).toBeGreaterThan(0.085);
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

test('camera orbits on drag, and fades the big rock instead of zooming in past it', async ({ page }) => {
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

  // Stand just in front of the big rock, facing away from it, so the rock sits behind the lizard.
  const rock = await page.evaluate(() => window.__game!.obstacles().find((o) => o.name === 'rock-big')!);
  expect(rock.opacity).toBe(1);
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, 0), [rock.x, rock.z + 0.15]);
  await steps(page, 30);
  const cam = await page.evaluate(() => window.__game!.camera());
  expect(cam.arm).toBeGreaterThan(cam.distance - 0.01);
  expect(cam.faded).toContain('rock-big');
  const faded = await page.evaluate(() => window.__game!.obstacles());
  expect(faded.find((o) => o.name === 'rock-big')!.opacity).toBeLessThan(0.5);
  expect(faded.find((o) => o.name === 'log')!.opacity).toBe(1);
  const ground = await page.evaluate(([x, z]) => window.__game!.terrainHeight(x, z), [cam.x, cam.z]);
  expect(cam.y).toBeGreaterThan(ground);
  await page.screenshot({ path: 'test-results/screenshots/rock-faded.png' });

  // Walk clear and it turns solid again.
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, 0), [0.6, 0.6]);
  await steps(page, 40);
  const clear = await page.evaluate(() => window.__game!.obstacles());
  expect(clear.find((o) => o.name === 'rock-big')!.opacity).toBe(1);
});

/** Run (or walk) at an obstacle from `back` metres south, jump when `jumpAt` metres from it, then let go. */
async function jumpOnto(page: Page, name: string, back: number, jumpAt: number, run: boolean) {
  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true);
  const o = await page.evaluate((n) => window.__game!.obstacles().find((o) => o.name === n)!, name);
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, Math.PI), [o.x, o.z + back]);
  await steps(page, 5);
  await page.evaluate((run) => window.__game!.setInput({ move: { x: 0, y: 1 }, run }, 600), run);
  await page.waitForFunction((z) => window.__game!.player().z < z, o.z + jumpAt, { timeout: 30_000 });
  await drive(page, { move: { x: 0, y: 1 }, run, jump: true }, 12);
  await page.evaluate(() => window.__game!.setInput({ move: { x: 0, y: 0 } }, 1));
  await steps(page, 30);
  return o;
}

test('landing on the mid rock: stands on top and stays put', async ({ page }) => {
  const rock = await jumpOnto(page, 'rock-mid', 0.3, 0.17, true);
  const ground = await page.evaluate(([x, z]) => window.__game!.terrainHeight(x, z), [rock.x, rock.z]);
  const on = await player(page);
  expect(on.grounded).toBe(true);
  expect(on.y).toBeGreaterThan(ground + rock.height - 0.01);
  await page.screenshot({ path: 'test-results/screenshots/rock-landed.png' });
  await steps(page, 90);
  const later = await player(page);
  expect(Math.hypot(later.x - on.x, later.y - on.y, later.z - on.z)).toBeLessThan(0.002);
});

test('landing on the log: stands on top and stays put', async ({ page }) => {
  const log = await jumpOnto(page, 'log', 0.3, 0.17, true);
  const ground = await page.evaluate(([x, z]) => window.__game!.terrainHeight(x, z), [log.x, log.z]);
  const on = await player(page);
  expect(on.grounded).toBe(true);
  expect(on.y).toBeGreaterThan(ground + log.height - 0.01);
  await page.screenshot({ path: 'test-results/screenshots/log-landed.png' });
  await steps(page, 90);
  const later = await player(page);
  expect(Math.hypot(later.x - on.x, later.y - on.y, later.z - on.z)).toBeLessThan(0.002);
});

