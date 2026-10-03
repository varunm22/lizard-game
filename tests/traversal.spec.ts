import { expect, test, type Page } from '@playwright/test';

/**
 * Every test drives time itself with `window.__game.advance`: the game stops its real-time loop and
 * runs exactly the steps asked for, so the slow headless renderer doesn't set the pace.
 */
const steps = (page: Page, n: number, draw = true) =>
  page.evaluate(([n, draw]) => window.__game!.advance(n as number, draw as boolean), [n, draw] as const);

const player = (page: Page) => page.evaluate(() => window.__game!.player());
const camera = (page: Page) => page.evaluate(() => window.__game!.camera());
const obstacle = (page: Page, name: string) =>
  page.evaluate((n) => window.__game!.obstacles().find((o) => o.name === n)!, name);

type Drive = { move?: { x: number; y: number }; run?: boolean; jump?: boolean };

/** Hold `input` for exactly `n` physics steps, then let go. */
async function drive(page: Page, input: Drive, n: number) {
  await page.evaluate(([i, n]) => window.__game!.setInput(i as Drive, n as number), [input, n] as const);
  await steps(page, n + 1);
}

async function teleport(page: Page, x: number, z: number, yaw: number) {
  await page.evaluate(([x, z, yaw]) => window.__game!.teleport(x, z, yaw), [x, z, yaw]);
  await steps(page, 20);
}

async function boot(page: Page, x = 0.6, z = 0.3, yaw = 0) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true);
  await teleport(page, x, z, yaw);
  return errors;
}

/** Hold `input` until the lizard is north of `z` (it travels -Z), at most `max` steps. */
async function driveUntilZBelow(page: Page, input: Drive, z: number, max = 300) {
  await page.evaluate(
    ([i, z, max]) => {
      const g = window.__game!;
      g.setInput(i as Drive, max as number);
      for (let k = 0; k < (max as number) && g.player().z >= (z as number); k++) g.advance(1, false);
    },
    [input, z, max] as const,
  );
}

test('walking with W follows the ground and comes to rest; Shift runs', async ({ page }) => {
  // Open ground with no plants near the way (they slow the lizard), camera behind looking +Z: forward is +Z.
  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true);
  const laneX = await page.evaluate(() => {
    const ps = window.__game!.plants();
    const near = (x: number) => ps.filter((p) => Math.abs(p.x - x) < 0.06 && p.z > 0.15 && p.z < 1.5).length;
    let best = 0.6;
    for (let x = 0.4; x <= 1.0; x += 0.01) if (near(x) < near(best)) best = x;
    return near(best) === 0 ? best : null;
  });
  expect(laneX).not.toBeNull();
  const errors = await boot(page, laneX!);
  const start = await player(page);
  expect(start.grounded).toBe(true);

  await page.keyboard.down('KeyW');
  await steps(page, 60);
  const mid = await player(page);
  expect(mid.state).toBe('walk');
  expect(mid.speed).toBeGreaterThan(0.22);
  expect(mid.speed).toBeLessThan(0.28);
  expect(await page.evaluate(() => window.__game!.lizard().current)).toBe('walk');
  await page.screenshot({ path: 'test-results/screenshots/walk.png' });
  await steps(page, 60);
  await page.keyboard.up('KeyW');
  const end = await player(page);
  // 2 s at 0.25 m/s, minus a short ramp-up, straight ahead and on the ground.
  expect(end.z - start.z).toBeGreaterThan(0.45);
  expect(end.z - start.z).toBeLessThan(0.51);
  expect(Math.abs(end.x - start.x)).toBeLessThan(0.01);
  const ground = await page.evaluate(([x, z]) => window.__game!.terrainHeight(x, z), [end.x, end.z]);
  expect(Math.abs(end.y - ground)).toBeLessThan(0.006);
  await steps(page, 30);
  expect((await player(page)).state).toBe('idle');
  // Standing, every foot as drawn is on the ground: not floating on the physics skin, not sunk in.
  for (const f of await page.evaluate(() => window.__game!.feet())) expect(Math.abs(f.gap), f.leg).toBeLessThan(0.0015);

  await page.evaluate(() => window.__game!.setInput({ move: { x: 0, y: 1 }, run: true }, 90));
  await steps(page, 45);
  const run = await player(page);
  expect(run.state).toBe('run');
  expect(run.speed).toBeGreaterThan(0.55);
  expect(errors).toEqual([]);
});

test('steering: A/D look around when still, turn the body when moving; S backs up', async ({ page }) => {
  await boot(page);
  const start = await player(page);
  const restHead = (await page.evaluate(() => window.__game!.lizard())).head;

  // Standing still, D turns only the head, toward the lizard's right (-X in its own frame).
  await page.evaluate(() => window.__game!.setInput({ move: { x: 1, y: 0 } }, 40));
  await steps(page, 25);
  expect((await page.evaluate(() => window.__game!.lizard())).head.x).toBeLessThan(restHead.x - 0.005);
  await page.screenshot({ path: 'test-results/screenshots/look-right.png' });
  await steps(page, 50);
  const still = await player(page);
  expect(still.yaw).toBe(start.yaw);
  expect(Math.hypot(still.x - start.x, still.z - start.z)).toBeLessThan(0.002);
  expect(Math.abs((await page.evaluate(() => window.__game!.lizard())).head.x - restHead.x)).toBeLessThan(0.003);

  // W with D curves right at 90°/s; facing +Z, the lizard's right is -X.
  await drive(page, { move: { x: 1, y: 1 } }, 30);
  const curved = await player(page);
  expect(curved.z).toBeGreaterThan(start.z + 0.03);
  expect(curved.x).toBeLessThan(start.x - 0.005);
  expect(curved.yaw).toBeLessThan(-0.6);
  expect(curved.yaw).toBeGreaterThan(-0.85);
  // Keep turning: the camera swings back round behind the lizard.
  await drive(page, { move: { x: 1, y: 1 } }, 30);
  await steps(page, 60);
  const p = await player(page);
  const cam = await camera(page);
  expect(Math.abs(Math.atan2(Math.sin(cam.yaw - p.yaw), Math.cos(cam.yaw - p.yaw)))).toBeLessThan(0.3);

  // S backs up without turning round.
  await teleport(page, start.x, start.z, 0);
  await drive(page, { move: { x: 0, y: -1 } }, 60);
  const back = await player(page);
  expect(back.z).toBeLessThan(start.z - 0.1);
  expect(Math.abs(back.yaw)).toBeLessThan(0.01);
});

test('jump: ~10 cm unhurried arc, lands flush, camera holds still; a tap hops lower', async ({ page }) => {
  await boot(page);
  const start = await player(page);
  // Step through a held jump, recording the arc in the page.
  const arc = await page.evaluate(() => {
    const g = window.__game!;
    g.setInput({ jump: true }, 40);
    const camY = g.camera().y;
    let peak = -Infinity;
    let camHigh = camY;
    let landedAt = -1;
    const seen = new Set<string>();
    for (let i = 1; i <= 40; i++) {
      g.advance(1, false);
      const p = g.player();
      seen.add(p.state);
      peak = Math.max(peak, p.y);
      camHigh = Math.max(camHigh, g.camera().y);
      if (landedAt < 0 && seen.has('fall') && p.grounded) landedAt = i;
    }
    return { peak, camRise: camHigh - camY, landedAt, seen: [...seen] };
  });
  expect(arc.peak - start.y).toBeGreaterThan(0.09);
  expect(arc.peak - start.y).toBeLessThan(0.11);
  expect(arc.seen).toContain('jump');
  expect(arc.seen).toContain('fall');
  // About 0.45 s in the air, and grounded means on the ground, not drifting down the last few cm.
  expect(arc.landedAt).toBeGreaterThan(23);
  expect(arc.landedAt).toBeLessThan(31);
  // The camera holds its height through a hop on flat ground instead of bobbing after it.
  expect(arc.camRise).toBeLessThan(0.003);
  await steps(page, 30);
  const end = await player(page);
  expect(end.state).toBe('idle');
  expect(Math.abs(end.y - start.y)).toBeLessThan(0.003);

  const tapPeak = await page.evaluate(() => {
    const g = window.__game!;
    g.setInput({ jump: true }, 1);
    let peak = -Infinity;
    for (let i = 0; i < 25; i++) {
      g.advance(1, false);
      peak = Math.max(peak, g.player().y);
    }
    return peak;
  });
  expect(tapPeak - start.y).toBeGreaterThan(0.01);
  expect(tapPeak - start.y).toBeLessThan(0.05);
});

test('walking into the log climbs it, rearing up the face, drapes over the top and tips off the far side', async ({ page }) => {
  await boot(page);
  const log = await obstacle(page, 'log');
  // South of the log's middle, facing -Z toward it, camera pinned to the side for the screenshots.
  await teleport(page, log.x, log.z + 0.2, Math.PI);
  await page.evaluate(() => window.__game!.viewFrom({ x: 0.22, y: 0.03, z: -0.02 }));

  // Partway up: the front of the body is angled up the face while the hind feet are still down.
  const rear = await page.evaluate(() => {
    const g = window.__game!;
    g.setInput({ move: { x: 0, y: 1 } }, 400);
    for (let k = 0; k < 200 && !g.player().climbing; k++) g.advance(1, false);
    // Until the chest has reared up the face (how soon depends on how far forward the front feet are).
    for (let k = 0; k < 20 && g.lizard().spine.chest <= 0.6; k++) g.advance(1);
    g.advance(1);
    return { climbing: g.player().climbing, spine: g.lizard().spine, feet: g.feet() };
  });
  expect(rear.climbing).toBe(true);
  expect(rear.spine.chest).toBeGreaterThan(0.6);
  for (const f of rear.feet.filter((f) => f.leg.startsWith('hind'))) expect(Math.abs(f.gap), f.leg).toBeLessThan(0.004);
  await page.screenshot({ path: 'test-results/screenshots/log-climb.png' });

  // On top, let go: it lies across the log, hips and chest bent down either side, tail hanging.
  await page.evaluate(() => {
    const g = window.__game!;
    for (let k = 0; k < 100 && g.player().climbing; k++) g.advance(1, false);
    g.setInput(null);
  });
  await steps(page, 30);
  const on = await player(page);
  const ground = await page.evaluate(([x, z]) => window.__game!.terrainHeight(x, z), [log.x, log.z]);
  expect(on.grounded).toBe(true);
  expect(on.y).toBeGreaterThan(ground + log.height - 0.01);
  const { spine } = await page.evaluate(() => window.__game!.lizard());
  expect(spine.hips).toBeGreaterThan(0.15);
  expect(spine.chest).toBeLessThan(-0.1);
  expect(spine.tail[3]).toBeGreaterThan(0.5);
  for (const f of await page.evaluate(() => window.__game!.feet())) expect(Math.abs(f.gap), f.leg).toBeLessThan(0.004);
  await page.screenshot({ path: 'test-results/screenshots/log-draped.png' });

  // Walking on, the front goes over the edge and it drops off the far side rather than balancing,
  // at walking speed: sliding down the log's rounded side doesn't fling it forward.
  const fastest = await page.evaluate(() => {
    const g = window.__game!;
    g.setInput({ move: { x: 0, y: 1 } }, 40);
    let top = 0;
    for (let i = 0; i < 60; i++) {
      g.advance(1, false);
      top = Math.max(top, g.player().speed);
    }
    return top;
  });
  expect(fastest).toBeLessThan(0.27);
  const off = await player(page);
  expect(off.z).toBeLessThan(log.z - 0.06);
  expect(off.grounded).toBe(true);
  expect(off.y).toBeLessThan((await page.evaluate(([x, z]) => window.__game!.terrainHeight(x, z), [off.x, off.z])) + 0.01);
});

test('the big rock is too tall to climb, and the log can be jumped over', async ({ page }) => {
  await boot(page);
  const rock = await obstacle(page, 'rock-big');
  await teleport(page, rock.x, rock.z + 0.2, Math.PI);
  await drive(page, { move: { x: 0, y: 1 } }, 60);
  const blocked = await player(page);
  expect(blocked.climbing).toBe(false);
  const ground = await page.evaluate(([x, z]) => window.__game!.terrainHeight(x, z), [blocked.x, blocked.z]);
  expect(blocked.y).toBeLessThan(ground + 0.02);
  // Jumping at it, the lizard comes down off its face onto the ground. It doesn't hang there by the
  // snout with only one foot on the rock until it next moves.
  await teleport(page, rock.x, rock.z + 0.35, Math.PI);
  await driveUntilZBelow(page, { move: { x: 0, y: 1 } }, rock.z + 0.16);
  await drive(page, { move: { x: 0, y: 1 }, jump: true }, 12);
  await steps(page, 60);
  const fell = await player(page);
  expect(fell.y).toBeLessThan(ground + 0.02);
  for (const f of await page.evaluate(() => window.__game!.feet())) expect(Math.abs(f.gap), f.leg).toBeLessThan(0.003);

  const log = await obstacle(page, 'log');
  await teleport(page, log.x, log.z + 0.25, Math.PI);
  await driveUntilZBelow(page, { move: { x: 0, y: 1 }, run: true }, log.z + 0.12);
  await drive(page, { move: { x: 0, y: 1 }, run: true, jump: true }, 50);
  await steps(page, 30);
  const over = await player(page);
  expect(over.z).toBeLessThan(log.z - 0.06);
  expect(over.grounded).toBe(true);
});

test('landing on the mid rock and the log: stands on top and stays put', async ({ page }) => {
  await boot(page);
  // The mid rock is narrower than the lizard is long: a running jump carries it over and off.
  for (const [name, run] of [['rock-mid', false], ['log', true]] as const) {
    const o = await obstacle(page, name);
    await teleport(page, o.x, o.z + 0.3, Math.PI);
    await driveUntilZBelow(page, { move: { x: 0, y: 1 }, run }, o.z + 0.17);
    await drive(page, { move: { x: 0, y: 1 }, run, jump: true }, 12);
    await steps(page, 90);
    const ground = await page.evaluate(([x, z]) => window.__game!.terrainHeight(x, z), [o.x, o.z]);
    const on = await player(page);
    expect(on.grounded, name).toBe(true);
    expect(on.y, name).toBeGreaterThan(ground + o.height - 0.01);
    await page.screenshot({ path: `test-results/screenshots/${name}-landed.png` });
    await steps(page, 90);
    const later = await player(page);
    expect(Math.hypot(later.x - on.x, later.y - on.y, later.z - on.z), name).toBeLessThan(0.002);
  }
});

test('camera orbits on drag, and fades the big rock instead of zooming in past it', async ({ page }) => {
  await boot(page, 0.1, 0.05, Math.PI);
  const before = await camera(page);

  // Drag right with the mouse: the view turns right (yaw decreases).
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.mouse.move(740, 360, { steps: 5 });
  await page.mouse.up();
  await steps(page, 1);
  expect((await camera(page)).yaw).toBeLessThan(before.yaw - 0.3);

  // Stand just in front of the big rock, facing away from it, so the rock sits behind the lizard.
  const rock = await obstacle(page, 'rock-big');
  expect(rock.opacity).toBe(1);
  await teleport(page, rock.x, rock.z + 0.15, 0);
  await steps(page, 10);
  const cam = await camera(page);
  expect(cam.arm).toBeGreaterThan(cam.distance - 0.01);
  expect(cam.faded).toContain('rock-big');
  expect((await obstacle(page, 'rock-big')).opacity).toBeLessThan(0.5);
  expect((await obstacle(page, 'log')).opacity).toBe(1);
  const ground = await page.evaluate(([x, z]) => window.__game!.terrainHeight(x, z), [cam.x, cam.z]);
  expect(cam.y).toBeGreaterThan(ground);
  await page.screenshot({ path: 'test-results/screenshots/rock-faded.png' });

  // Walk clear and it turns solid again.
  await teleport(page, 0.6, 0.6, 0);
  await steps(page, 20);
  expect((await obstacle(page, 'rock-big')).opacity).toBe(1);
});
