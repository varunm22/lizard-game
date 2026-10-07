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

test('the tortoise walks its round, leaving the plants it walks over flat for about a minute, and new ones come up along it', async ({ page }) => {
  const errors = await boot(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    const t0 = g.tortoise();
    const { route } = t0;
    // How far off the oval a point is, roughly in metres.
    const off = (x: number, z: number) => Math.abs(Math.hypot((x - route.x) / route.rx, (z - route.z) / route.rz) - 1) * Math.min(route.rx, route.rz);
    g.advance(600, false);
    const t1 = g.tortoise();
    const flat = g.plants().filter((p) => p.crush > 0.9);
    // Follow one plant it has just flattened, and keep an eye out for seedlings.
    const watched = flat[0];
    const lean = () => {
      const p = g.plants({ x: watched.x, z: watched.z, r: 1e-6 })[0];
      return p ? { tilt: Math.hypot(p.tiltX, p.tiltZ), crush: p.crush } : null;
    };
    const plantsAt0 = g.plants().length;
    let seedlings = 0;
    const samples: ({ tilt: number; crush: number } | null)[] = [];
    for (let s = 0; s < 75; s++) {
      g.advance(60, false);
      samples.push(lean());
      seedlings = Math.max(seedlings, g.plants().filter((p) => p.growth < 1).length);
    }
    return {
      t0,
      t1,
      feetGap: t1.y - g.terrainHeight(t1.x, t1.z),
      offRoute: off(t1.x, t1.z),
      flatCount: flat.length,
      flatOffRoute: Math.max(...flat.map((p) => off(p.x, p.z))),
      samples,
      seedlings,
      plantsAt0,
    };
  });

  // It plods on round its oval, its feet on the ground.
  expect(run.t1.along - run.t0.along).toBeGreaterThan(0.15);
  expect(run.offRoute).toBeLessThan(0.01);
  expect(Math.abs(run.feetGap)).toBeLessThan(0.01);
  // What it walked over is flat, and only that: everything flattened is on its route.
  expect(run.flatCount).toBeGreaterThan(0);
  expect(run.flatOffRoute).toBeLessThan(0.12);
  // A flattened plant stays down for most of a minute, then stands back up.
  expect(run.samples[20]!.tilt).toBeGreaterThan(1.0);
  expect(run.samples[30]!.tilt).toBeGreaterThan(1.0);
  expect(run.samples.at(-1)!.crush).toBe(0);
  expect(run.samples.at(-1)!.tilt).toBeLessThan(0.05);
  // Seedlings come up along the route.
  expect(run.seedlings).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('the tortoise stops to eat a plant at its mouth, and lies down to rest', async ({ page }) => {
  const errors = await boot(page);
  const meal = await page.evaluate(() => {
    const g = window.__game!;
    const t = g.tortoise();
    // Something to eat just ahead on its route.
    g.sprout('daisy', t.ahead.x, t.ahead.z, true);
    g.tortoiseDo('eat');
    for (let s = 0; s < 30 * 60 && g.tortoise().state !== 'eat'; s++) g.advance(1, false);
    const at = g.tortoise();
    const mouth = { x: at.x + Math.sin(at.yaw) * 0.16, z: at.z + Math.cos(at.yaw) * 0.16 };
    const before = g.plants({ ...mouth, r: 0.035 }).length;
    g.advance(90, false);
    const after = g.plants({ ...mouth, r: 0.035 }).length;
    g.advance(180, false);
    return { state: at.state, clip: at.clip, before, after, then: g.tortoise().state };
  });
  expect(meal.state).toBe('eat');
  expect(meal.clip).toBe('eat');
  // The bite takes the plant it reached down for.
  expect(meal.after).toBe(meal.before - 1);
  expect(meal.then).toBe('walk');

  const rest = await page.evaluate(() => {
    const g = window.__game!;
    const top = () => {
      const t = g.tortoise();
      return g.groundAt(t.x, t.z)! - t.y;
    };
    const standingTop = top();
    g.tortoiseDo('rest');
    g.advance(30, false);
    const lying = g.tortoise();
    g.advance(150, false);
    const resting = g.tortoise();
    g.advance(300, false);
    const later = g.tortoise();
    return { standingTop, lyingState: lying.state, restState: resting.state, moved: Math.hypot(later.x - resting.x, later.z - resting.z), restTop: top() };
  });
  expect(rest.lyingState).toBe('lie_down');
  expect(rest.restState).toBe('rest');
  // It stays put, and its shell sinks onto the ground.
  expect(rest.moved).toBeLessThan(1e-4);
  expect(rest.standingTop).toBeGreaterThan(0.12);
  expect(rest.standingTop - rest.restTop).toBeGreaterThan(0.012);
  expect(errors).toEqual([]);
});

test('the tortoise shoves the lizard out of its way instead of stopping for it', async ({ page }) => {
  const errors = await boot(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    const t0 = g.tortoise();
    // Sit the lizard across its path a little ahead.
    g.teleport(t0.ahead.x, t0.ahead.z, t0.yaw + Math.PI / 2);
    g.advance(10, false);
    const start = g.player();
    let deepest = -Infinity;
    for (let s = 0; s < 20 * 60; s++) {
      g.advance(1, false);
      const t = g.tortoise();
      const p = g.player();
      const ox = p.x - t.x;
      const oz = p.z - t.z;
      const along = ox * Math.sin(t.yaw) + oz * Math.cos(t.yaw);
      const across = ox * Math.cos(t.yaw) - oz * Math.sin(t.yaw);
      // How far inside the shell's outline the lizard's feet are (1 = on the rim).
      deepest = Math.max(deepest, 1 - Math.hypot(across / 0.086, along / 0.12));
    }
    const end = g.player();
    return { travelled: g.tortoise().along - t0.along, shoved: Math.hypot(end.x - start.x, end.z - start.z), deepest };
  });
  // It walked on past where the lizard sat, and the lizard was moved, never ending up under the shell.
  expect(run.travelled).toBeGreaterThan(0.4);
  expect(run.shoved).toBeGreaterThan(0.05);
  expect(run.deepest).toBeLessThan(0);
  expect(errors).toEqual([]);
});

test('the lizard rides on the shell, carried round with the tortoise while it stands still', async ({ page }) => {
  const errors = await boot(page);
  const ride = await page.evaluate(() => {
    const g = window.__game!;
    const t0 = g.tortoise();
    // Dropped onto the crown of the shell, facing the way the tortoise walks.
    g.teleport(t0.x, t0.z, t0.yaw, t0.y + 0.16);
    g.advance(60, false);
    // Where it sits on the shell, in the shell's own frame.
    const local = () => {
      const t = g.tortoise();
      const p = g.player();
      const ox = p.x - t.x;
      const oz = p.z - t.z;
      return { along: ox * Math.sin(t.yaw) + oz * Math.cos(t.yaw), across: ox * Math.cos(t.yaw) - oz * Math.sin(t.yaw), turn: p.yaw - t.yaw, up: p.y - t.y };
    };
    const start = { t: g.tortoise(), at: local() };
    const states = new Set<string>();
    let maxSpeed = 0;
    for (let s = 0; s < 10 * 60; s++) {
      g.advance(1, false);
      states.add(g.player().state);
      maxSpeed = Math.max(maxSpeed, g.player().speed);
    }
    const end = { t: g.tortoise(), at: local() };
    // It lies down with the lizard still aboard.
    g.tortoiseDo('rest');
    g.advance(240, false);
    const resting = { t: g.tortoise(), at: local() };
    return { start, end, resting, states: [...states], maxSpeed, travelled: end.t.along - start.t.along };
  });
  // Up on the crown of the shell (0.128 m up, standing), not sunk into it, and the tortoise kept
  // walking with it aboard.
  expect(ride.start.at.up).toBeGreaterThan(0.124);
  expect(ride.start.at.up).toBeLessThan(0.136);
  expect(ride.travelled).toBeGreaterThan(0.2);
  // It went along for the ride: still in the same spot on the shell, facing the same way...
  expect(Math.abs(ride.end.at.along - ride.start.at.along)).toBeLessThan(0.01);
  expect(Math.abs(ride.end.at.across - ride.start.at.across)).toBeLessThan(0.01);
  expect(Math.abs(Math.atan2(Math.sin(ride.end.at.turn - ride.start.at.turn), Math.cos(ride.end.at.turn - ride.start.at.turn)))).toBeLessThan(0.05);
  // ...and standing still the whole time, not walking on the spot.
  expect(ride.states).toEqual(['idle']);
  expect(ride.maxSpeed).toBeLessThan(0.02);
  // When the tortoise lies down, the lizard goes down with the shell, still in its spot.
  expect(ride.resting.t.state).toBe('rest');
  expect(ride.end.at.up - ride.resting.at.up).toBeGreaterThan(0.015);
  expect(Math.abs(ride.resting.at.along - ride.end.at.along)).toBeLessThan(0.01);
  expect(errors).toEqual([]);
});

test('standing still, on the ground or riding, the tail and feet hold steady', async ({ page }) => {
  const errors = await boot(page);
  const worst = await page.evaluate(() => {
    const g = window.__game!;
    // The biggest jump of any kept-clear point (tail, then feet) in the lizard's own frame from one
    // frame to the next (the size of its second difference), played at a 144 Hz display's rate, so
    // the frames fall between physics steps as they do on screen.
    const watch = (secs: number) => {
      const frames: { x: number; y: number; z: number }[][] = [];
      for (let s = 0; s < secs * 144; s++) {
        g.frame(1 / 144);
        frames.push(g.clearancePoints());
      }
      let most = 0;
      for (let f = 1; f + 1 < frames.length; f++) {
        for (let i = 0; i < frames[f].length; i++) {
          const [a, b, c] = [frames[f - 1][i], frames[f][i], frames[f + 1][i]];
          most = Math.max(most, Math.hypot(a.x - 2 * b.x + c.x, a.y - 2 * b.y + c.y, a.z - 2 * b.z + c.z));
        }
      }
      return most;
    };
    g.teleport(0, 0, 0);
    g.advance(60, false);
    const ground = watch(4);
    // On the crown of the shell while the tortoise walks, eats, and lies down for a rest.
    const t = g.tortoise();
    g.teleport(t.x, t.z, t.yaw, t.y + 0.16);
    g.advance(60, false);
    const walking = watch(5);
    g.tortoiseDo('eat');
    const eating = watch(5);
    g.tortoiseDo('rest');
    const resting = watch(5);
    return { ground, walking, eating, resting, state: g.player().state };
  });
  expect(worst.state).toBe('idle');
  // Nothing jumps by more than a millimetre. The idle tail used to snap straight for a few frames
  // every 1.5 s (11 mm), on the ground too; on the shell, feet jumped by up to a centimetre.
  for (const when of ['ground', 'walking', 'eating', 'resting'] as const) expect(worst[when], when).toBeLessThan(0.001);
  expect(errors).toEqual([]);
});
