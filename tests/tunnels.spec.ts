import { expect, test } from '@playwright/test';
import { bootTunnels } from './helpers/bootTunnels';
import { screenshot } from './helpers/screenshot';

/**
 * The lava tunnels (`?level=tunnels`): two floors of lava tubes, holes in the upper floor that drop
 * into the tubes below, rubble piles that climb back up through holes in the roof, a gap to leap at
 * a run, a flooded stretch, and the way out to the jameo. Each test puts the lizard just where it
 * needs to be and walks it a few seconds.
 */

/** Yaw facing from (x, z) toward (tx, tz): 0 faces +z. */
const facing = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z);

test('the tunnels load: the lizard on the upper floor at the start; holes and rubble piles join the floors', async ({ page }) => {
  const errors = await bootTunnels(page);
  const s = await page.evaluate(() => {
    const g = window.__tunnels!;
    g.advance(20);
    const L = g.layout();
    const [lower, upper] = L.floors;
    return {
      L,
      player: g.player(),
      run: g.run(),
      // Straight down through each hole from above the upper floor lands on the lower floor.
      holes: L.holes.map((h) => ({ name: h.name, floor: g.floorBelow((h.a.x + h.b.x) / 2, (h.a.z + h.b.z) / 2, upper + 0.08), ground: g.terrainHeight((h.a.x + h.b.x) / 2, (h.a.z + h.b.z) / 2) })),
      // Each rubble pile: a step up at a time from the lower floor, the last flush with the upper floor.
      ramps: L.ramps.map((r) => {
        const n = L.steps.count;
        const treads = [];
        for (let i = -1; i < n; i++) {
          const k = (i + 0.5) / n;
          // From just above where the tread should be, under the roof of the tube below.
          const from = lower + (i + 1) * L.steps.riser + 0.08;
          treads.push(g.floorBelow(r.foot.x + (r.top.x - r.foot.x) * k, r.foot.z + (r.top.z - r.foot.z) * k, from)!);
        }
        return treads;
      }),
      // Sun streams down each skylight somewhere on the floor round it; deep in a lower tube it's dim.
      sunny: L.skylights.map((sk) => {
        let best = 0;
        for (let dx = -0.6; dx <= 0.6; dx += 0.05) for (let dz = -0.6; dz <= 0.6; dz += 0.05) best = Math.max(best, g.light(sk.x + dx, upper + 0.03, sk.z + dz).sun);
        return best;
      }),
      deep: g.light(-0.6, lower + 0.05, -1.2),
    };
  });
  expect(errors).toEqual([]);
  expect(s.player.grounded).toBe(true);
  expect(Math.abs(s.player.y - s.L.floors[1])).toBeLessThan(0.01);
  expect(Math.hypot(s.player.x - s.L.start.x, s.player.z - s.L.start.z)).toBeLessThan(0.02);
  expect(s.run.state).toBe('ready');
  expect(s.run.goals.length).toBe(9);
  for (const h of s.holes) expect(Math.abs(h.floor! - h.ground), h.name).toBeLessThan(0.01);
  for (const treads of s.ramps) {
    expect(Math.abs(treads[0] - s.L.floors[0])).toBeLessThan(0.01);
    expect(Math.abs(treads[treads.length - 1] - s.L.floors[1])).toBeLessThan(0.01);
    // Every riser is one the lizard can scramble up.
    for (let i = 1; i < treads.length; i++) {
      expect(treads[i] - treads[i - 1]).toBeGreaterThan(0.04);
      expect(treads[i] - treads[i - 1]).toBeLessThan(0.07);
    }
  }
  for (const sun of s.sunny) expect(sun).toBeGreaterThan(0.6);
  expect(s.deep.sun).toBe(0);
  expect(s.deep.glow).toBeLessThan(0.3);
  await screenshot(page, 'tunnels-start.png');
});

test('walking into a hole in the floor drops the lizard into the tube below', async ({ page }) => {
  await bootTunnels(page);
  const s = await page.evaluate((facingSrc) => {
    const facing = new Function(`return ${facingSrc}`)();
    const g = window.__tunnels!;
    const L = g.layout();
    const hole = L.holes.find((h) => h.name === 'last')!;
    // Clear of the barn owl's ear: walking right under its ledge, it would hear.
    const x = 3.55;
    const z = -0.62;
    g.teleport(x, z, facing(x, z, hole.a.x, hole.a.z), L.floors[1]);
    g.advance(10);
    g.setInput({ move: { x: 0, y: 1 } }, 150);
    g.advance(150);
    return { player: g.player(), run: g.run(), floors: L.floors };
  }, facing.toString());
  expect(s.player.y).toBeLessThan(s.floors[0] + 0.03);
  expect(s.player.grounded).toBe(true);
  expect(s.run.drops).toEqual(['last']);
  expect(s.run.goals.find((goal) => goal.id === 'drop')!.done).toBe(true);
});

test('a rubble pile climbs from the lower tubes up through the roof onto the upper floor', async ({ page }) => {
  await bootTunnels(page);
  const s = await page.evaluate((facingSrc) => {
    const facing = new Function(`return ${facingSrc}`)();
    const g = window.__tunnels!;
    const L = g.layout();
    const out = [];
    for (const r of L.ramps) {
      // Just short of the first step, facing up the pile.
      const yaw = facing(r.foot.x, r.foot.z, r.top.x, r.top.z);
      g.teleport(r.foot.x - Math.sin(yaw) * 0.09, r.foot.z - Math.cos(yaw) * 0.09, yaw, L.floors[0]);
      g.advance(10);
      g.setInput({ move: { x: 0, y: 1 } });
      for (let i = 0; i < 70 && g.player().y < L.floors[1] - 0.003; i++) g.advance(10);
      g.setInput(null);
      g.advance(20);
      out.push({ name: r.name, player: g.player() });
    }
    return { out, run: g.run(), floors: L.floors };
  }, facing.toString());
  for (const { name, player } of s.out) {
    expect(Math.abs(player.y - s.floors[1]), name).toBeLessThan(0.01);
    expect(player.grounded, name).toBe(true);
  }
  expect(s.run.climbs).toBe(2);
  expect(s.run.goals.find((goal) => goal.id === 'climb')!.done).toBe(true);
});

test('the gap is cleared by a running jump; walked or run into, it drops the lizard below', async ({ page }) => {
  await bootTunnels(page);
  const s = await page.evaluate(() => {
    const g = window.__tunnels!;
    const L = g.layout();
    const gap = L.holes.find((h) => h.kind === 'gap')!;
    const upper = L.floors[1];
    // Along the north tube toward the gap, east.
    const attempt = (jump: boolean, run: boolean) => {
      g.teleport(gap.a.x - 1.0, -1.9, Math.PI / 2, upper);
      g.advance(10);
      // Jump (held) as the snout reaches the rim.
      let held = 0;
      // Until well past it: further along, the tube has fallen blocks to clamber over.
      for (let i = 0; i < 300 && g.player().x < gap.a.x + 0.5; i++) {
        const p = g.player();
        if (jump && held === 0 && p.x > gap.a.x - gap.r - 0.07) held = 1;
        g.setInput({ move: { x: 0, y: 1 }, run, jump: held > 0 && held++ < 20 });
        g.advance(1);
      }
      g.setInput(null);
      g.advance(30);
      return g.player();
    };
    const leap = attempt(true, true);
    const leaps = g.run().leaps;
    const fall = attempt(false, false);
    const dash = attempt(false, true);
    return { leap, leaps, fall, dash, run: g.run(), floors: L.floors, gap };
  });
  expect(Math.abs(s.leap.y - s.floors[1])).toBeLessThan(0.01);
  expect(s.leap.x).toBeGreaterThan(s.gap.a.x + s.gap.r);
  expect(s.leaps).toBe(1);
  // Walking into it, or running without jumping, falls.
  expect(s.fall.y).toBeLessThan(s.floors[0] + 0.03);
  expect(s.dash.y).toBeLessThan(s.floors[0] + 0.03);
  expect(s.run.drops).toEqual(['gap', 'gap']);
  expect(s.run.goals.find((goal) => goal.id === 'leap')!.done).toBe(true);
});

test('the flooded stretch is swum, and the beach past the sea mouth is the way out', async ({ page }) => {
  await bootTunnels(page);
  const s = await page.evaluate(() => {
    const g = window.__tunnels!;
    const L = g.layout();
    const pool = L.pools[0];
    g.teleport(pool.x, pool.z - pool.rz - 0.1, 0, L.floors[0]);
    g.advance(10);
    g.setInput({ move: { x: 0, y: 1 } });
    let swam = false;
    for (let i = 0; i < 80 && !g.run().swam; i++) g.advance(5);
    swam = g.run().swam;
    for (let i = 0; i < 120 && g.player().swimming; i++) g.advance(5);
    const out = g.player();
    // Out of the mouth's sea pool onto the cove's beach, south to the water's edge.
    g.teleport(L.finish.x, L.finish.z - 0.27, 0);
    g.setInput({ move: { x: 0, y: 1 } });
    for (let i = 0; i < 100 && g.run().state !== 'home'; i++) g.advance(5);
    return { swam, out, run: g.run() };
  });
  expect(s.swam).toBe(true);
  expect(s.out.swimming).toBe(false);
  expect(s.run.goals.find((goal) => goal.id === 'swim')!.done).toBe(true);
  expect(s.run.state).toBe('home');
  expect(s.run.finishes).toBe(1);
  expect(s.run.goals.find((goal) => goal.id === 'out')!.done).toBe(true);
});

test('a barn owl misses a lizard keeping still under it, and drops on one running', async ({ page }) => {
  await bootTunnels(page);
  const s = await page.evaluate(() => {
    const g = window.__tunnels!;
    const L = g.layout();
    const upper = L.floors[1];
    const owl = g.owls()[0];
    // The sunniest spot on the floor under its skylight: basking there, still, it never hears.
    let sunny = { x: owl.under.x, z: owl.under.z, sun: 0 };
    for (let dx = -0.3; dx <= 0.3; dx += 0.05)
      for (let dz = -0.3; dz <= 0.3; dz += 0.05) {
        const sun = g.light(owl.under.x + dx, upper + 0.03, owl.under.z + dz).sun;
        if (sun > sunny.sun) sunny = { x: owl.under.x + dx, z: owl.under.z + dz, sun };
      }
    g.teleport(sunny.x, sunny.z, 0, upper);
    g.advance(200);
    const still = { owl: g.owls()[0].state, run: g.run() };
    // Running across under it: heard, dropped on, held, then back at the checkpoint.
    g.teleport(owl.under.x - 0.35, owl.under.z, Math.PI / 2, upper);
    g.advance(80);
    g.setInput({ move: { x: 0, y: 1 }, run: true });
    let heard = false;
    for (let i = 0; i < 60 && g.run().state !== 'caught'; i++) {
      g.advance(2);
      heard ||= g.owls()[0].state !== 'roost';
    }
    const caught = { run: g.run(), owl: g.owls()[0].state };
    g.setInput(null);
    g.advance(150);
    return { still, heard, caught, after: { run: g.run(), player: g.player(), owl: g.owls()[0].state } };
  });
  expect(s.still.owl).toBe('roost');
  expect(s.still.run.goals.find((goal) => goal.id === 'owl')!.done).toBe(true);
  expect(s.heard).toBe(true);
  expect(s.caught.run.state).toBe('caught');
  expect(s.caught.owl).toBe('mantle');
  expect(s.after.run.state).toBe('running');
  expect(s.after.run.catches).toBe(1);
  expect(s.after.owl).toBe('roost');
  const cp = s.after.run.checkpoint;
  expect(Math.hypot(s.after.player.x - cp.x, s.after.player.z - cp.z)).toBeLessThan(0.02);
});

test('a whitetip pup resting in the sea mouth bolts out to sea when swum over', async ({ page }) => {
  await bootTunnels(page);
  const s = await page.evaluate(() => {
    const g = window.__tunnels!;
    const shark = g.sharks()[0];
    // From the dry end of the mouth, into the pool and on over the pup.
    g.teleport(shark.x, 2.95, 0);
    g.advance(10);
    g.setInput({ move: { x: 0, y: 1 } });
    for (let i = 0; i < 80 && g.sharks()[0].state === 'rest'; i++) g.advance(5);
    const woke = { shark: g.sharks()[0], player: g.player() };
    g.setInput(null);
    g.advance(120);
    return { shark, woke, later: g.sharks(), run: g.run() };
  });
  expect(s.woke.shark.state).toBe('bolt');
  expect(s.woke.player.swimming).toBe(true);
  expect(s.later[0].z).toBeGreaterThan(s.shark.z + 1);
  // The other pup, further out, sleeps on.
  expect(s.later[1].state).toBe('rest');
  expect(s.run.goals.find((goal) => goal.id === 'shark')!.done).toBe(true);
});
