import { expect, test } from '@playwright/test';
import { bootLagoon } from './helpers/bootLagoon';
import { screenshot } from './helpers/screenshot';

/**
 * The mangrove lagoon (`?level=lagoon`): the ground and the mangroves' roots, the lava herons'
 * stalking and stabbing, the driftwood log that floats out on the ebb and jams across the channel,
 * and the run from the lava coast to the lava field. The hunting tests stand heron 1 at its first
 * spot facing south over the open flat, with the lizard in front of it.
 */
const HERON = 1;

test('the lagoon loads: the ground, the mangroves and roots, the herons waiting, the log in its pool', async ({ page }) => {
  const errors = await bootLagoon(page);
  const s = await page.evaluate(() => {
    const g = window.__lagoon!;
    // Ground the physics stands on matches the height function wherever nothing stands on it.
    let worst = 0;
    for (let i = 0; i < 40; i++) {
      const x = -4.5 + (i % 8) * 1.2;
      const z = -4.5 + Math.floor(i / 8) * 2.2;
      const hit = g.groundAt(x, z, 1);
      if (hit !== null && hit - g.terrainHeight(x, z) < 0.01) worst = Math.max(worst, Math.abs(hit - g.terrainHeight(x, z)));
    }
    const marks = g.marks();
    const pool = marks.pool;
    return {
      worst,
      herons: g.herons(),
      // Every heron's spots are somewhere it can stand.
      unwadeable: g.herons().flatMap((_, i) => g.haunts(i)).filter((p) => !g.wadeable(p.x, p.z)),
      heron: g.heronBody(0),
      log: g.log(),
      mangroves: g.mangroves(),
      swimmers: g.swimmers(),
      run: g.run(),
      player: g.player(),
      marks,
      poolDepth: g.depth(pool.x, pool.z),
      channelDepth: g.depth(g.channel(1).x, 1),
    };
  });
  expect(errors).toEqual([]);
  expect(s.worst).toBeLessThan(0.006);
  expect(s.mangroves.filter((m) => !m.sapling).length).toBeGreaterThan(30);
  expect(s.swimmers.filter((f) => f.kind === 'shark').length).toBe(3);
  expect(s.swimmers.filter((f) => f.kind === 'ray').length).toBe(15);
  expect(s.herons.length).toBe(6);
  for (const h of s.herons) expect(h.state).toBe('wait');
  expect(s.unwadeable).toEqual([]);
  // Each heron's leg bones reach the feet it stands on; the bill is out ahead of the body.
  const { bones, feet } = s.heron;
  expect(Math.hypot(bones.foot_L.x - feet[0].x, bones.foot_L.z - feet[0].z)).toBeLessThan(0.005);
  expect(Math.hypot(bones.foot_R.x - feet[1].x, bones.foot_R.z - feet[1].z)).toBeLessThan(0.005);
  expect(bones.head.y - bones.body.y).toBeGreaterThan(0.05);
  expect(s.log).toMatchObject({ state: 'float', inChannel: false, pushes: 0 });
  expect(Math.hypot(s.log.x - s.marks.pool.x, s.log.z - s.marks.pool.z)).toBeLessThan(s.marks.pool.r);
  // Deep enough to swim in the pool and the channel.
  expect(s.poolDepth).toBeGreaterThan(0.15);
  expect(s.channelDepth).toBeGreaterThan(0.25);
  expect(s.run.state).toBe('ready');
  expect(Math.hypot(s.player.x - s.marks.start.x, s.player.z - s.marks.start.z)).toBeLessThan(0.02);
  expect(s.player.swimming).toBe(false);
  expect(Math.hypot(s.player.x - s.marks.finish.x, s.player.z - s.marks.finish.z)).toBeGreaterThan(8);
  await screenshot(page, 'lagoon-start.png');
});

test('a heron sees a lizard in the open, stalks it and stabs; the last of its health gone, the lizard is back at the start', async ({ page }) => {
  await bootLagoon(page, { herons: [HERON] });
  const s = await page.evaluate((hi) => {
    const g = window.__lagoon!;
    // Down to its last stab.
    g.setVitals({ health: 0.3 });
    const h0 = g.herons()[hi];
    g.placeHeron(hi, h0.x, h0.z, Math.PI);
    g.teleport(h0.x, h0.z - 0.45, 0);
    g.setInput({ move: { x: 0, y: 1 } }, 1);
    const seen: string[] = [];
    let danger = 'none';
    for (let i = 0; i < 80 && g.run().state !== 'caught'; i++) {
      g.advance(5);
      const now = g.herons()[hi].state;
      if (seen[seen.length - 1] !== now) seen.push(now);
      if (now === 'aim') danger = g.run().danger;
    }
    const caught = g.run();
    const heron = g.herons()[hi];
    g.viewFrom({ x: 0.4, y: 0.12, z: -0.15 }, { x: heron.x, y: heron.y + 0.12, z: heron.z - 0.1 });
    g.advance(1);
    return { seen, danger, caught, heron, vitals: g.vitals() };
  }, HERON);
  expect(s.seen.slice(0, 4)).toEqual(['wait', 'stalk', 'aim', 'strike']);
  expect(s.danger).toBe('chased');
  expect(s.caught.state).toBe('caught');
  expect(s.heron.catches).toBe(1);
  expect(s.vitals).toMatchObject({ health: 0, down: true, downBy: 'heron' });
  await screenshot(page, 'lagoon-heron.png');
  const after = await page.evaluate(() => {
    const g = window.__lagoon!;
    g.viewFrom(null);
    g.advance(160);
    return { run: g.run(), player: g.player(), start: g.marks().start, vitals: g.vitals() };
  });
  expect(after.run).toMatchObject({ state: 'ready', attempts: 2, catches: 1, time: 0 });
  expect(after.vitals).toMatchObject({ health: 1, down: false });
  expect(Math.hypot(after.player.x - after.start.x, after.player.z - after.start.z)).toBeLessThan(0.02);
});

test("the lagoon keeps the island's bars: a stab takes health without catching, the water chills and diving costs air, the lava warms", async ({ page }) => {
  await bootLagoon(page, { herons: [HERON], vitals: true });
  const s = await page.evaluate((hi) => {
    const g = window.__lagoon!;
    const h0 = g.herons()[hi];
    g.placeHeron(hi, h0.x, h0.z, Math.PI);
    g.teleport(h0.x, h0.z - 0.45, 0);
    g.setInput({ move: { x: 0, y: 1 } }, 1);
    let stabbed = null as null | { health: number; run: string; heron: string };
    for (let i = 0; i < 80 && !stabbed; i++) {
      g.advance(5);
      if (g.herons()[hi].catches > 0) stabbed = { health: g.vitals().health, run: g.run().state, heron: g.herons()[hi].state };
    }
    g.pause({ herons: true });
    // Under water in the west pool, holding still near the bottom.
    g.setVitals({ health: 1, warmth: 0.7, air: 1 });
    g.teleport(-2.6, 1.9, 0, -0.2);
    g.advance(120);
    const dived = g.vitals();
    // Lying still in the sun on the lava coast.
    g.setVitals({ warmth: 0.4, air: 1 });
    const st = g.marks().start;
    g.teleport(st.x, st.z, st.yaw);
    g.advance(180);
    return { stabbed, dived, swimming: g.player().swimming, basked: g.vitals() };
  }, HERON);
  expect(s.stabbed).not.toBeNull();
  expect(s.stabbed!.health).toBeCloseTo(0.6, 2);
  expect(s.stabbed!.run).not.toBe('caught');
  expect(s.stabbed!.heron).toBe('recover');
  expect(s.dived.air).toBeLessThan(0.95);
  expect(s.dived.warmth).toBeLessThan(0.7);
  expect(s.basked.warmth).toBeGreaterThan(0.4);
  expect(s.basked.down).toBe(false);
});

test('lagoon algae: gutweed on the lava at the waterline and Bostrychia on the mangrove roots, and, as on the island, "[F] to eat" shows in reach and a bite fills the food bar', async ({ page }) => {
  await bootLagoon(page, { vitals: true });
  const r = await page.evaluate(() => {
    const g = window.__lagoon!;
    const patches = g.algae();
    const kinds = new Set(patches.map((p) => p.kind));
    const weed = patches.find((p) => p.kind === 'gutweed')!;
    g.setVitals({ fullness: 0.3 });
    let ate = 0;
    let prompt = false;
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      g.teleport(weed.x - Math.sin(yaw) * 0.05, weed.z - Math.cos(yaw) * 0.05, yaw);
      g.advance(10);
      prompt ||= g.feeding().canEat;
      g.bite();
      g.advance(30);
      if ((ate = g.feeding().mouthfuls) > 0) break;
    }
    return { kinds: [...kinds].sort(), count: patches.length, ate, prompt, fullness: g.vitals().fullness };
  });
  expect(r.kinds).toEqual(['bostrychia', 'gutweed']);
  expect(r.count).toBeGreaterThan(40);
  expect(r.prompt).toBe(true);
  expect(r.ate).toBeGreaterThan(0);
  expect(r.fullness).toBeGreaterThan(0.35);
});

test('juvenile fish shoal among the mangrove roots: they dart between the roots, never through one or out of the water, and bolt from a lizard', async ({ page }) => {
  await bootLagoon(page);
  const r = await page.evaluate(() => {
    const g = window.__lagoon!;
    const shoals = g.fryShoals();
    const start = g.fry();
    let peak = 0;
    let bad = 0;
    for (let i = 0; i < 120; i++) {
      g.advance(1);
      for (const f of g.fry()) {
        peak = Math.max(peak, f.speed);
        const s = shoals[f.shoal];
        if (s.roots.some((q) => Math.hypot(f.x - q.x, f.z - q.z) < q.r) || g.depth(f.x, f.z) < 0.02 || f.y > g.terrainHeight(f.x, f.z) + g.depth(f.x, f.z) - 0.004) bad++;
      }
    }
    const moved = g.fry().filter((f, i) => Math.hypot(f.x - start[i].x, f.z - start[i].z) > 0.02).length;
    // The lizard drops in beside a shoal: the fry near it get away.
    const mine = () => g.fry().filter((f) => f.shoal === 0);
    const c = mine();
    const x = c.reduce((a, f) => a + f.x, 0) / c.length + 0.05;
    const z = c.reduce((a, f) => a + f.z, 0) / c.length;
    const near = () => mine().filter((f) => Math.hypot(f.x - x, f.z - z) < 0.08).length;
    const before = near();
    g.teleport(x, z, 0);
    g.advance(30);
    return { shoals: shoals.length, count: start.length, peak, bad, moved, before, after: near(), kinds: [...new Set(shoals.map((s) => s.species))].sort() };
  });
  expect(r.shoals).toBeGreaterThanOrEqual(8);
  expect(r.count).toBeGreaterThan(60);
  expect(r.kinds).toEqual(['mullet', 'snapper']);
  expect(r.peak).toBeGreaterThan(0.25);
  expect(r.moved).toBeGreaterThan(r.count / 2);
  expect(r.bad).toBe(0);
  expect(r.after).toBeLessThan(Math.max(1, r.before));
});

test('a stalking heron steps slowly, one foot at a time, its body level; a swimmer that comes near one is struck at once', async ({ page }) => {
  await bootLagoon(page, { herons: [HERON, 5] });
  const s = await page.evaluate((hi) => {
    const g = window.__lagoon!;
    const h0 = g.herons()[hi];
    g.placeHeron(hi, h0.x, h0.z, Math.PI);
    g.teleport(h0.x + 0.05, h0.z - 1.1, 0);
    // Stalking a still lizard: count steps, and how much the body rises and falls once crouched.
    const ys: number[] = [];
    let lifted = 0;
    let both = 0;
    let start: { x: number; z: number } | null = null;
    for (let i = 0; i < 180; i++) {
      g.advance(1);
      const h = g.herons()[hi];
      if (h.state !== 'stalk') continue;
      start ??= { x: h.x, z: h.z };
      const b = g.heronBody(hi);
      const up = b.feet.map((f) => f.y - h.y > 0.002);
      if (up[0] || up[1]) lifted++;
      if (up[0] && up[1]) both++;
      if (i > 90) ys.push(b.bones.body.y - h.y);
    }
    const h = g.herons()[hi];
    const stalk = { lifted, both, bob: Math.max(...ys) - Math.min(...ys), moved: Math.hypot(h.x - start!.x, h.z - start!.z) };
    // Heron 5 waits at the edge of the north shallows, facing west; the lizard (down to its last stab) swims slowly up close in front of it.
    g.setVitals({ health: 0.3 });
    g.placeHeron(5, -1.5, 2.2, -Math.PI / 2);
    g.teleport(-1.7, 2.1, 0, -0.07);
    const seen = [g.herons()[5].state];
    let strikeSteps = 0;
    for (let i = 0; i < 60 && g.run().state !== 'caught'; i++) {
      g.setInput({ move: { x: 0, y: 0.25 } }, 1);
      g.advance(1);
      const now = g.herons()[5].state;
      if (now === 'strike') strikeSteps++;
      if (seen[seen.length - 1] !== now) seen.push(now);
    }
    return { stalk, seen, strikeSteps, run: g.run(), swimming: g.player().swimming };
  }, HERON);
  expect(s.stalk.lifted).toBeGreaterThan(40);
  expect(s.stalk.both).toBe(0);
  expect(s.stalk.bob).toBeLessThan(0.002);
  expect(s.stalk.moved).toBeGreaterThan(0.1);
  expect(s.swimming).toBe(true);
  expect(s.seen.slice(0, 4)).toEqual(['wait', 'aim', 'strike', 'hold']);
  expect(s.strikeSteps).toBeLessThanOrEqual(6);
  expect(s.run.state).toBe('caught');
});

test('a heron spots a moving lizard from over 2 m off, and after losing one stays on the alert and takes up the hunt again at a glimpse', async ({ page }) => {
  await bootLagoon(page, { herons: [HERON] });
  const s = await page.evaluate((hi) => {
    const g = window.__lagoon!;
    const h0 = g.herons()[hi];
    const until = (state: string, steps: number) => {
      for (let i = 0; i < steps; i++) {
        g.advance(1);
        if (g.herons()[hi].state === state) return i;
      }
      return -1;
    };
    // A lizard on the move 2.2 m in front.
    g.placeHeron(hi, h0.x, h0.z, Math.PI);
    g.teleport(h0.x, h0.z - 2.2, Math.PI / 2);
    g.setInput({ move: { x: 0, y: 1 } }, 1);
    const farSpot = until('stalk', 120);
    g.setInput(null);
    // Away into the deep pool: lost, but it stays on the alert, and a glimpse of it back in the open starts the hunt at once.
    g.teleport(-2.6, 1.9, 0, -0.15);
    g.advance(5);
    const lost = g.herons()[hi];
    g.advance(60);
    const h1 = g.herons()[hi];
    // Back in the open, in front of it.
    const x = h1.x + Math.sin(h1.yaw) * 0.8;
    const z = h1.z + Math.cos(h1.yaw) * 0.8;
    g.teleport(x, z, 0);
    const again = until('stalk', 60);
    return { farSpot, lost: { state: lost.state, alert: lost.alert }, again };
  }, HERON);
  expect(s.farSpot).toBeGreaterThan(0);
  expect(s.lost.state).toBe('wait');
  expect(s.lost.alert).toBeGreaterThan(5);
  expect(s.again).toBeGreaterThanOrEqual(0);
  expect(s.again).toBeLessThan(20);
});

test('a stalking heron gives up on a lizard in the mangrove roots or swimming low over deep water; the safe point is a checkpoint', async ({ page }) => {
  await bootLagoon(page, { herons: [HERON] });
  const s = await page.evaluate((hi) => {
    const g = window.__lagoon!;
    const h0 = g.herons()[hi];
    const stalked = () => {
      g.placeHeron(hi, h0.x, h0.z, Math.PI);
      g.teleport(h0.x, h0.z - 0.5, 0);
      g.setInput({ move: { x: 0, y: 1 } }, 1);
      for (let i = 0; i < 30 && g.herons()[hi].state !== 'stalk'; i++) g.advance(5);
      return g.herons()[hi].state;
    };
    // Into the roots of an old mangrove, away from the safe point.
    const safe = g.marks().safe[0];
    const m = g.mangroves().find((t) => !t.sapling && Math.hypot(t.x - safe.x, t.z - safe.z) > 1)!;
    const first = stalked();
    g.teleport(m.x + m.reach * 0.45, m.z, 0);
    const inRoots = g.tangle(m.x + m.reach * 0.45, m.z);
    g.advance(10);
    const afterRoots = { heron: g.herons()[hi].state, goals: g.run().goals };
    // Down in the deep pool, swimming.
    const second = stalked();
    g.teleport(-2.6, 1.9, 0, -0.15);
    g.advance(10);
    const afterDeep = { heron: g.herons()[hi].state, goals: g.run().goals, player: g.player() };
    // The safe point among the old roots: once reached, it's where a catch sends the lizard back to.
    g.teleport(safe.x, safe.z, safe.yaw);
    g.advance(5);
    return { first, inRoots, afterRoots, second, afterDeep, atSafe: g.run() };
  }, HERON);
  expect(s.first).toBe('stalk');
  expect(s.inRoots).toBe(true);
  expect(['walk', 'wait']).toContain(s.afterRoots.heron);
  expect(s.afterRoots.goals.find((g) => g.id === 'hide')!.done).toBe(true);
  expect(s.second).toBe('stalk');
  expect(s.afterDeep.player.swimming).toBe(true);
  expect(['walk', 'wait']).toContain(s.afterDeep.heron);
  expect(s.afterDeep.goals.find((g) => g.id === 'deep')!.done).toBe(true);
  expect(s.atSafe).toMatchObject({ checkpoint: 0, safe: true });
  expect(s.atSafe.goals.find((g) => g.id === 'safe')!.done).toBe(true);
});

test('the log: swum into, it moves; the creek drains it into the channel, the ebb jams it across the narrows, and it bridges to the lava field', async ({ page }) => {
  await bootLagoon(page);
  const s = await page.evaluate(() => {
    const g = window.__lagoon!;
    // Swimming into its side from the pool, the lizard shoves it along.
    const l0 = g.log();
    const px = -Math.sin(l0.heading);
    const pz = Math.cos(l0.heading);
    g.teleport(l0.x - px * 0.12, l0.z - pz * 0.12, Math.atan2(px, pz), -0.07);
    g.setInput({ move: { x: 0, y: 1 } }, 40);
    g.advance(40);
    const pushed = g.log();
    // Lying in the creek mouth, it drains out into the channel and turns to the flow.
    g.placeLog(2.3, g.marks().creek.z, 0);
    for (let i = 0; i < 12 && !g.log().inChannel; i++) g.advance(60);
    const creek = g.log();
    // A little upstream of the narrows, it drifts down and jams across.
    const c = g.channel(0.2);
    g.placeLog(c.x, 0.2, Math.PI / 2);
    let steps = 0;
    for (; steps < 900 && g.log().state !== 'jammed'; steps += 30) g.advance(30);
    const jammed = g.log();
    // From the mud by the landing, across the log, onto the lava and to the light.
    const jam = g.marks().jam;
    const ch = g.channel(jam.z);
    g.teleport(ch.x - ch.half - 0.25, jam.z, Math.PI / 2);
    const f = g.marks().finish;
    let onLog = false;
    for (let i = 0; i < 200 && g.run().state !== 'home'; i++) {
      const p = g.player();
      const want = i < 60 ? Math.PI / 2 : Math.atan2(f.x - p.x, f.z - p.z);
      const d = Math.atan2(Math.sin(want - p.yaw), Math.cos(want - p.yaw));
      g.setInput({ move: { x: Math.max(-1, Math.min(1, -d * 3)), y: 1 } }, 5);
      g.advance(5);
      onLog ||= g.log().rider;
      if (g.player().swimming) break;
    }
    const crossed = { run: g.run(), player: g.player() };
    g.viewFrom({ x: -0.55, y: 0.3, z: -0.7 }, { x: jam.x, y: -0.02, z: jam.z });
    g.advance(1);
    return { l0, pushed, creek, jammed, steps, jam, onLog, crossed };
  });
  expect(s.pushed.pushes).toBeGreaterThan(0);
  expect(Math.hypot(s.pushed.x - s.l0.x, s.pushed.z - s.l0.z)).toBeGreaterThan(0.02);
  expect(s.creek.inChannel).toBe(true);
  expect(s.creek.reachedChannel).toBe(1);
  expect(s.jammed.state).toBe('jammed');
  // Across the channel: one end on the mud bank, the other on the lava shelf, both out of the water.
  const [a, b] = [...s.jammed.ends].sort((p, q) => p.x - q.x);
  expect(b.x - a.x).toBeGreaterThan(0.85);
  expect(Math.abs(s.jammed.z - s.jam.z)).toBeLessThan(0.05);
  expect(a.y).toBeGreaterThan(-0.06);
  expect(s.onLog).toBe(true);
  expect(s.crossed.player.swimming).toBe(false);
  expect(s.crossed.run.state).toBe('home');
  const done = Object.fromEntries(s.crossed.run.goals.map((g) => [g.id, g.done]));
  expect(done).toMatchObject({ channel: true, bridge: true, cross: true });
  await screenshot(page, 'lagoon-bridge.png');
  // Starting over puts the log back in its pool.
  const reset = await page.evaluate(() => {
    window.__lagoon!.restart();
    return { log: window.__lagoon!.log(), pool: window.__lagoon!.marks().pool };
  });
  expect(reset.log.state).toBe('float');
  expect(Math.hypot(reset.log.x - reset.pool.x, reset.log.z - reset.pool.z)).toBeLessThan(reset.pool.r);
});

test('the channel: its ebb carries a swimmer south and a riding lizard with the log; its far bank is too steep to climb out on', async ({ page }) => {
  await bootLagoon(page);
  const s = await page.evaluate(() => {
    const g = window.__lagoon!;
    // Drifting, no strokes.
    const c = g.channel(1.6);
    g.teleport(c.x, 1.6, Math.PI / 2, -0.1);
    g.advance(120);
    const drifted = g.player();
    // Swimming hard at the lava face, tilting up now and then.
    for (let i = 0; i < 24; i++) {
      g.setInput({ move: { x: 0, y: 1 }, run: true, jump: i % 6 === 0 }, 10);
      g.advance(10);
    }
    const atFace = { player: g.player(), edge: g.channel(g.player().z) };
    // Standing on the log as it drifts.
    g.placeLog(c.x, 1.6, Math.PI / 2);
    g.teleport(c.x, 1.6, 0, g.log().y + 0.045);
    g.setInput({ move: { x: 0, y: 0 } }, 1);
    g.advance(90);
    return { drifted, atFace, ride: g.log(), riding: g.player(), goals: g.run().goals };
  });
  expect(s.drifted.swimming).toBe(true);
  expect(1.6 - s.drifted.z).toBeGreaterThan(0.12);
  expect(s.atFace.player.swimming).toBe(true);
  expect(s.atFace.player.x).toBeLessThan(s.atFace.edge.x + s.atFace.edge.half);
  expect(s.ride.rider).toBe(true);
  expect(s.ride.ridden).toBeGreaterThan(1);
  expect(s.riding.swimming).toBe(false);
  expect(1.6 - s.riding.z).toBeGreaterThan(0.08);
  expect(s.goals.find((g) => g.id === 'ride')!.done).toBe(true);
});

test('shark pups and rays cruise the pools, and swimming beside them ticks their goals', async ({ page }) => {
  await bootLagoon(page, { swimmers: true });
  const s = await page.evaluate(() => {
    const g = window.__lagoon!;
    const before = g.swimmers();
    g.advance(120);
    const after = g.swimmers();
    const deep = after.map((f) => g.depth(f.x, f.z));
    // How far under the surface each one's highest point is: the surface is the ground plus the water over it.
    const under = after.map((f) => g.terrainHeight(f.x, f.z) + g.depth(f.x, f.z) - f.top);
    const shark = after.find((f) => f.kind === 'shark')!;
    g.teleport(shark.x + 0.2, shark.z, 0, -0.1);
    g.advance(4);
    const ray = g.swimmers().find((f) => f.kind === 'ray')!;
    g.teleport(ray.x + 0.2, ray.z, 0, -0.1);
    g.advance(4);
    return { before, after, deep, under, goals: g.run().goals };
  });
  for (let i = 0; i < s.before.length; i++) expect(Math.hypot(s.after[i].x - s.before[i].x, s.after[i].z - s.before[i].z)).toBeGreaterThan(0.05);
  for (const d of s.deep) expect(d).toBeGreaterThan(0.08);
  for (const u of s.under) expect(u).toBeGreaterThan(0.005);
  const done = Object.fromEntries(s.goals.map((g) => [g.id, g.done]));
  expect(done).toMatchObject({ shark: true, rays: true });
});

test('a shark pup comes over to circle a swimmer, bites one that suddenly turns on it, and rays veer off from a swimmer heading at them', async ({ page }) => {
  await bootLagoon(page, { swimmers: true });
  const s = await page.evaluate(() => {
    const g = window.__lagoon!;
    // Floating still in the west pool, a pup cruising by takes an interest and comes round.
    g.teleport(-2.6, 1.9, 0, -0.12);
    g.placeSwimmer(0, -2.0, 1.6, 0);
    let curious = false;
    let nearest = Infinity;
    for (let i = 0; i < 80 && !curious; i++) {
      g.advance(10);
      const f = g.swimmers()[0];
      curious = f.state === 'curious';
      nearest = Math.min(nearest, Math.hypot(f.x + 2.6, f.z - 1.9));
    }
    // It's crossing just ahead: the lizard, down to its last bite, turns sharply and swims straight at it.
    g.setVitals({ health: 0.25 });
    g.placeSwimmer(0, -2.37, 1.9, 0);
    g.advance(2);
    g.teleport(-2.6, 1.9, Math.PI / 2, -0.12);
    const seq: string[] = [];
    let danger = 'none';
    for (let i = 0; i < 40 && g.run().state !== 'caught'; i++) {
      g.setInput({ move: { x: 0, y: 1 } }, 2);
      g.advance(2);
      const f = g.swimmers()[0];
      if (f.state === 'bite') danger = g.run().danger;
      if (seq[seq.length - 1] !== f.state) seq.push(f.state);
    }
    const bitten = { run: g.run(), bites: g.swimmers()[0].bites };
    g.restart();
    // A ray in the same pool: swim straight at it from 0.3 m.
    const r = g.swimmers().findIndex((f) => f.kind === 'ray' && f.pool === 0);
    const ray = g.swimmers()[r];
    g.placeSwimmer(r, ray.x, ray.z, Math.PI / 2);
    g.teleport(ray.x - 0.3, ray.z, Math.PI / 2, -0.12);
    let shy = false;
    let closest = Infinity;
    for (let i = 0; i < 10; i++) {
      g.setInput({ move: { x: 0, y: 1 } }, 6);
      g.advance(6);
      const f = g.swimmers()[r];
      const p = g.player();
      shy ||= f.state === 'shy';
      closest = Math.min(closest, Math.hypot(f.x - p.x, f.z - p.z));
    }
    return { curious, nearest, seq, danger, bitten, shy, closest };
  });
  expect(s.curious).toBe(true);
  expect(s.nearest).toBeLessThan(0.5);
  expect(s.seq.slice(0, 2)).toEqual(['cruise', 'bite']);
  expect(s.danger).toBe('chased');
  expect(s.bitten.run.state).toBe('caught');
  expect(s.bitten.bites).toBe(1);
  expect(s.shy).toBe(true);
  expect(s.closest).toBeGreaterThan(0.15);
});
