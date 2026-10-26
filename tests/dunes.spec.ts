import { expect, test } from '@playwright/test';
import { bootDunes } from './helpers/bootDunes';
import { screenshot } from './helpers/screenshot';

/**
 * The nesting dunes (`?level=dunes`): the ground, the racer snakes' bodies and hunting, and the run
 * from the nest to the colony, past its safe points. The hunting tests lay racer 2 down on the open
 * nesting flat facing east (`LOOKOUT`), where it has a clear view, and put the lizard in front of it.
 */
const RACER = 2;
const LOOKOUT = { x: -5.2, z: -1.6, yaw: Math.PI / 2 };

test('the dunes load: the ground, the props on it, the snakes lying up, the run waiting at the nest', async ({ page }) => {
  const errors = await bootDunes(page);
  const s = await page.evaluate(() => {
    const g = window.__dunes!;
    // Ground the physics stands on matches the height function wherever nothing stands on it.
    let worst = 0;
    for (let i = 0; i < 40; i++) {
      const x = -3.5 + (i % 8) * 0.83;
      const z = -3.3 + Math.floor(i / 8) * 1.6;
      const hit = g.groundAt(x, z, 1);
      if (hit !== null && hit - g.terrainHeight(x, z) < 0.01) worst = Math.max(worst, Math.abs(hit - g.terrainHeight(x, z)));
    }
    const sunk = g.obstacles().filter((o) => o.kind === 'rock' && o.y > g.terrainHeight(o.x, o.z) + o.height).length;
    return { worst, sunk, obstacles: g.obstacles().length, bushes: g.bushes().length, racers: g.racers(), run: g.run(), player: g.player(), marks: g.marks() };
  });
  expect(errors).toEqual([]);
  expect(s.worst).toBeLessThan(0.006);
  expect(s.obstacles).toBeGreaterThan(60);
  expect(s.sunk).toBe(0);
  expect(s.bushes).toBeGreaterThan(10);
  expect(s.racers.length).toBeGreaterThan(12);
  for (const r of s.racers) {
    expect(r.state).toBe('lurk');
    expect(r.trail).toBeGreaterThanOrEqual(r.length);
  }
  expect(s.run.state).toBe('ready');
  expect(Math.hypot(s.player.x - s.marks.start.x, s.player.z - s.marks.start.z)).toBeLessThan(0.02);
  expect(Math.hypot(s.player.x - s.marks.finish.x, s.player.z - s.marks.finish.z)).toBeGreaterThan(10);
  expect(s.marks.safe.length).toBe(2);
  await screenshot(page, 'dunes-start.png');
});

test('a racer sees a lizard moving, chases it and strikes, its body sliding along its own track; the run starts over', async ({ page }) => {
  await bootDunes(page, { racers: [RACER] });
  const s = await page.evaluate(({ ri, lookout }) => {
    const g = window.__dunes!;
    g.placeRacer(ri, lookout.x, lookout.z, lookout.yaw);
    const home = g.racers()[ri];
    const r = g.racers()[ri];
    g.teleport(r.x + Math.sin(r.course) * 0.6, r.z + Math.cos(r.course) * 0.6, r.course + Math.PI / 2);
    g.setInput({ move: { x: 0, y: 1 }, run: false }, 240);
    const seen: string[] = [];
    let body = null as ReturnType<typeof g.racerBody> | null;
    for (let i = 0; i < 40; i++) {
      g.advance(6);
      const now = g.racers()[ri];
      if (seen[seen.length - 1] !== now.state) seen.push(now.state);
      if (!body && now.state === 'chase' && Math.hypot(now.x - home.x, now.z - home.z) > 0.25) body = g.racerBody(ri);
      if (g.run().state === 'caught') break;
    }
    const caught = g.run();
    g.advance(170);
    return { seen, body, caught, after: g.run(), player: g.player(), start: g.marks().start, racer: g.racers()[ri] };
  }, { ri: RACER, lookout: LOOKOUT });
  // Head up to watch first, then after it.
  expect(s.seen.indexOf('alert')).toBeGreaterThanOrEqual(0);
  expect(s.seen.indexOf('alert')).toBeLessThan(s.seen.indexOf('chase'));
  expect(s.caught.state).toBe('caught');
  expect(s.racer.strikes).toBeGreaterThanOrEqual(1);
  expect(s.racer.catches).toBe(1);
  // Each joint sits its own arc back along the path, so they're spaced as on the model (chords of a
  // curve are a little shorter), and every bone of the skin sits on its joint (a bone lies along the
  // middle of the body, a few mm over the path's belly line).
  const { joints, arcs, bones } = s.body!;
  for (let k = 1; k < joints.length; k++) {
    const chord = Math.hypot(joints[k].x - joints[k - 1].x, joints[k].y - joints[k - 1].y, joints[k].z - joints[k - 1].z);
    expect(chord).toBeLessThanOrEqual(arcs[k] - arcs[k - 1] + 0.001);
    expect(chord).toBeGreaterThan((arcs[k] - arcs[k - 1]) * 0.8);
    expect(Math.hypot(bones[k - 1].x - joints[k].x, bones[k - 1].y - joints[k].y, bones[k - 1].z - joints[k].z)).toBeLessThan(0.012);
  }
  // After a moment in its coils, the lizard is back in its burrow for another go.
  expect(s.after).toMatchObject({ state: 'ready', attempts: 2, catches: 1, time: 0 });
  expect(Math.hypot(s.player.x - s.start.x, s.player.z - s.start.z)).toBeLessThan(0.02);
});

test('a lizard that holds still is not chased: the snake watches, then looks away', async ({ page }) => {
  await bootDunes(page, { racers: [RACER] });
  const s = await page.evaluate(({ ri, lookout }) => {
    const g = window.__dunes!;
    g.placeRacer(ri, lookout.x, lookout.z, lookout.yaw);
    const r = g.racers()[ri];
    g.teleport(r.x + Math.sin(r.course) * 0.75, r.z + Math.cos(r.course) * 0.75, r.course + Math.PI / 2);
    // A few steps in plain sight, then freeze.
    g.setInput({ move: { x: 0, y: 1 }, run: false }, 30);
    g.advance(32);
    const watching = { racer: g.racers()[ri].state, danger: g.run().danger };
    g.advance(260);
    return { watching, later: g.racers()[ri], run: g.run() };
  }, { ri: RACER, lookout: LOOKOUT });
  expect(s.watching).toEqual({ racer: 'alert', danger: 'watched' });
  expect(s.later.state).toBe('lurk');
  expect(s.later.chases).toBe(0);
  expect(s.run.goals.find((g) => g.id === 'freeze')!.done).toBe(true);
});

test('a lizard under a saltbush is out of sight', async ({ page }) => {
  await bootDunes(page, { racers: [RACER] });
  const s = await page.evaluate((ri) => {
    const g = window.__dunes!;
    const r = g.racers()[ri];
    // The nearest bush to the snake, moved in front of it with the lizard under its canopy.
    const bush = g.bushes().reduce((a, b) => (Math.hypot(b.x - r.x, b.z - r.z) < Math.hypot(a.x - r.x, a.z - r.z) ? b : a));
    const d = Math.hypot(bush.x - r.x, bush.z - r.z);
    g.placeRacer(ri, bush.x - ((bush.x - r.x) / d) * 0.8, bush.z - ((bush.z - r.z) / d) * 0.8, Math.atan2(bush.x - r.x, bush.z - r.z));
    g.teleport(bush.x + bush.radius * 0.3, bush.z, Math.PI / 2);
    const cover = g.run().inCover;
    // Creeping about under it.
    g.setInput({ move: { x: 0, y: 1 }, run: false }, 30);
    g.advance(120);
    return { cover, racer: g.racers()[ri].state };
  }, RACER);
  expect(s.cover).toBe(true);
  expect(s.racer).toBe('lurk');
});

test('a safe point keeps the lizard out of reach, and a catch after it sends the lizard back there', async ({ page }) => {
  await bootDunes(page, { racers: [RACER] });
  const s = await page.evaluate((ri) => {
    const g = window.__dunes!;
    const p = g.marks().safe[0];
    // Walk into the first safe point's crevice from just west of it.
    g.teleport(p.x - 0.25, p.z, p.yaw);
    g.setInput({ move: { x: 0, y: 1 }, run: false }, 50);
    g.advance(50);
    const inside = g.run();
    // A snake right by the crevice doesn't come for the lizard shuffling about in it.
    g.placeRacer(ri, p.x - 0.55, p.z, Math.PI / 2);
    g.setInput({ move: { x: 1, y: 0.3 }, run: false }, 60);
    g.advance(60);
    const watched = g.racers()[ri];
    // Out in the open in front of a snake, then caught: back at the safe point, the clock running on.
    g.placeRacer(ri, -5.2, -1.6, Math.PI / 2);
    g.teleport(-5.2 + 0.5, -1.6, 0);
    const before = g.run().time;
    g.setInput({ move: { x: 0, y: 1 }, run: false }, 400);
    for (let i = 0; i < 40 && g.run().state !== 'caught'; i++) g.advance(6);
    const caught = g.run();
    g.setInput({ move: { x: 0, y: 0 } }, 1);
    g.advance(170);
    return { inside, watched, caught, after: g.run(), before, player: g.player(), p };
  }, RACER);
  expect(s.inside).toMatchObject({ checkpoint: 0, safe: true, state: 'running' });
  expect(s.watched.chases).toBe(0);
  expect(s.caught.state).toBe('caught');
  expect(s.after).toMatchObject({ state: 'running', checkpoint: 0, attempts: 1 });
  expect(s.after.time).toBeGreaterThan(s.before);
  expect(Math.hypot(s.player.x - s.p.x, s.player.z - s.p.z)).toBeLessThan(0.02);
});

test('reaching the adults under the light wins the run and ticks off its goals', async ({ page }) => {
  await bootDunes(page);
  const s = await page.evaluate(() => {
    const g = window.__dunes!;
    const f = g.marks().finish;
    // Just outside the ring, facing the middle.
    g.teleport(f.x - f.r - 0.1, f.z, Math.PI / 2);
    g.setInput({ move: { x: 0, y: 1 }, run: true }, 60);
    g.advance(60);
    return g.run();
  });
  expect(s.state).toBe('home');
  expect(s.finishes).toBe(1);
  expect(s.best).toBeGreaterThan(0);
  const done = Object.fromEntries(s.goals.map((g) => [g.id, g.done]));
  expect(done).toMatchObject({ shore: true, unseen: true, outrun: false });
  // The end screen offers another go or the next stage. C walks the hatchling on in among the adults
  // as the screen fades, then goes on to it.
  await expect(page.locator('.dunes-message')).toHaveClass(/show/);
  await expect(page.locator('.dunes-message .keys')).toHaveText(/R\s*play again\s*C\s*next: Galápagos island/);
  await screenshot(page, 'dunes-end.png');
  await page.keyboard.press('KeyC');
  const walk = await page.evaluate(() => {
    const g = window.__dunes!;
    const f = g.marks().finish;
    const from = g.player();
    g.advance(120);
    const mid = { ...g.arrival(), ...g.player() };
    return { colony: g.colony(), from: Math.hypot(from.x - f.x, from.z - f.z), mid, deep: Math.hypot(mid.x - f.x, mid.z - f.z) };
  });
  expect(walk.colony.adults).toBeGreaterThan(6);
  expect(walk.colony.crabs).toBeGreaterThan(0);
  expect(walk.mid.walking).toBe(true);
  expect(walk.mid.fade).toBe(0);
  expect(walk.deep).toBeLessThan(Math.min(walk.from, 0.2));
  await screenshot(page, 'dunes-walk-in.png');
  await page.evaluate(() => window.__dunes!.advance(100));
  await page.waitForURL(/level=island/, { waitUntil: 'commit' });
});

test('the other hatchlings come up from their burrows and make for the shore', async ({ page }) => {
  await bootDunes(page, { hatchlings: [0] });
  const s = await page.evaluate(() => {
    const g = window.__dunes!;
    const before = g.hatchlings()[0];
    g.advance(500);
    return { before, after: g.hatchlings()[0], finish: g.marks().finish };
  });
  expect(s.before.phase).toBe('burrow');
  expect(['run', 'freeze']).toContain(s.after.phase);
  const toFinish = (h: { x: number; z: number }) => Math.hypot(h.x - s.finish.x, h.z - s.finish.z);
  expect(toFinish(s.before) - toFinish(s.after)).toBeGreaterThan(0.3);
});
