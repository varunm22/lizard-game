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
  for (const c of ['glide', 'flap', 'stoop', 'strike', 'perch', 'land', 'take_off', 'feed']) expect(r.clips).toContain(c);
  expect(r.hawk.state).toBe('perch');
  expect(r.hawk.clip).toBe('perch');
  expect(r.hawk.perch).toBeGreaterThanOrEqual(0);
  expect(r.hawk.speed).toBeLessThan(1e-3);
  expect(r.hawk.hunting).toBe(false);
  expect(r.wounds).toMatchObject({ hits: 0, down: false, countdown: null });
  expect(errors).toEqual([]);
});

test('perched on a rock or a tree, the hawk stands on its toes with its tail clear behind', async ({ page }) => {
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.hawkDo('off');
    g.advance(2, false);
    return g.hawkPerches().map((p, i) => {
      g.hawkSit(i);
      g.advance(10);
      const low = g.hawkLowest();
      // Rocks have colliders the shape of what's drawn; trees are only drawn up top.
      const ground = /^(rock|pile)/.test(p.on) ? g.groundAt(p.x, p.z, p.y + 0.2) : null;
      return { on: p.on, y: p.y, low, ground, state: g.hawk().state };
    });
  });
  expect(r.length).toBeGreaterThanOrEqual(4);
  // Rocks, the rock piles' crests among them, and at least one tree or cactus.
  expect(r.some((p) => p.on.startsWith('pile'))).toBe(true);
  expect(r.some((p) => !/^(rock|pile)/.test(p.on))).toBe(true);
  for (const p of r) {
    expect(p.state, p.on).toBe('perch');
    // The tail angles down past its toes, behind it, rather than holding it up off the rock.
    expect(p.low.tail, p.on).toBeLessThan(p.low.feet);
    if (p.ground === null) continue;
    // The toes rest on the rock: gripping it a little, never standing off it.
    expect(p.low.feet - p.ground, p.on).toBeLessThan(0.002);
    expect(p.low.feet - p.ground, p.on).toBeGreaterThan(-0.004);
  }
  expect(errors).toEqual([]);
});

test('walking up to the perched hawk flushes it to the perch furthest away, not hunting', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const perches = g.hawkPerches();
    const from = perches[g.hawk().perch];
    // On the ground a little way from the perch, toward the middle of the island.
    const d = Math.hypot(from.x, from.z);
    const x = from.x - (from.x / d) * 0.3;
    const z = from.z - (from.z / d) * 0.3;
    g.teleport(x, z, 0);
    g.advance(2, false);
    const lizard = g.player();
    let took = -1;
    let hunted = false;
    let i = 0;
    for (; i < 30 * 60; i++) {
      g.advance(1, false);
      const h = g.hawk();
      if (took < 0 && h.state === 'take_off') took = i;
      hunted ||= h.hunting;
      if (took >= 0 && h.state === 'perch') break;
    }
    const h = g.hawk();
    const to = perches[h.perch];
    const far = Math.max(...perches.map((p) => Math.hypot(p.x - lizard.x, p.z - lizard.z)));
    return { took, settled: i, state: h.state, flushed: h.flushed, hunted, strikes: h.strikes, away: Math.hypot(to.x - lizard.x, to.z - lizard.z), far };
  });
  expect(r.took).toBeGreaterThanOrEqual(0);
  expect(r.took).toBeLessThan(30);
  expect(r.flushed).toBe(1);
  expect(r.state).toBe('perch');
  expect(r.away).toBeCloseTo(r.far, 5);
  expect(r.away).toBeGreaterThan(2);
  expect(r.hunted).toBe(false);
  expect(r.strikes).toBe(0);
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
    const hits: { jerk: number; flinched: boolean; clip: string | null; puff: number }[] = [];
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
        hits.push({ jerk: Math.hypot(after.x - before.x, after.z - before.z), flinched: g.wounds().flinching, clip, puff: g.wounds().puff });
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
    // Each strike throws the lizard several cm sideways, it flinches, and dust and feathers fly.
    expect(h.jerk).toBeGreaterThan(0.05);
    expect(h.flinched).toBe(true);
    expect(h.puff).toBeGreaterThan(10);
    expect(h.clip).toBe('strike');
  }
  expect(r.downAt).toBeGreaterThan(0);
  expect(r.down.wounds.down).toBe(true);
  expect(r.down.wounds.countdown).not.toBeNull();
  expect(r.down.clip).toBe('collapse');
  expect(r.down.moved).toBeLessThan(0.005);
  // Back up after the collapse and the 5 s countdown (about 1.85 s were already spent lying there).
  expect(r.back).toBeGreaterThan(60);
  expect(r.back).toBeLessThan(5 * 60);
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

test('it catches a crab, comes down on it to eat, and another crab is out on the rocks later', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const before = g.crabs().length;
    // From the wing: taking off, its shadow sends the crabs round its perch running for cover.
    g.hawkDo('soar');
    g.advance(240, false);
    g.hawkDo('hunt_crab');
    let struck = -1;
    for (let i = 0; i < 90 * 60 && struck < 0; i++) {
      g.advance(1, false);
      if (g.crabs().some((c) => c.dead)) struck = i;
    }
    const caught = g.crabs().findIndex((c) => c.dead);
    const hitAt = { ...g.hawk() };
    let feedAt = -1;
    for (let i = 0; i < 30 * 60 && feedAt < 0; i++) {
      g.advance(1, false);
      if (g.hawk().feeding) feedAt = i;
    }
    const h = g.hawk();
    const c = g.crabs()[caught];
    const over = { flat: Math.hypot(h.x - c.x, h.z - c.z), dy: h.y - c.y, clip: h.clip, quarry: h.quarry };
    // Eaten, and the hawk leaves.
    let goneAt = -1;
    for (let i = 0; i < 30 * 60 && goneAt < 0; i++) {
      g.advance(1, false);
      if (g.crabs()[caught].gone) goneAt = i;
    }
    g.hawkDo('off');
    const left = g.hawk().state;
    // It comes back on its rocks before long.
    let backAt = -1;
    for (let i = 0; i < 90 * 60 && backAt < 0; i++) {
      g.advance(10, false);
      if (!g.crabs()[caught].gone) backAt = i * 10;
    }
    const back = g.crabs()[caught];
    return { before, caught, struck, hitAt, feedAt, over, goneAt, left, backAt, back, after: g.crabs().length };
  });
  expect(r.caught).toBeGreaterThanOrEqual(0);
  expect(r.hitAt.hitsLanded).toBe(1);
  // One strike is enough for a crab; it then lands and stands over it to eat.
  expect(r.feedAt).toBeGreaterThan(0);
  expect(r.over.clip).toBe('feed');
  expect(r.over.quarry).toEqual({ kind: 'crab', index: r.caught });
  expect(r.over.flat).toBeLessThan(0.05);
  expect(r.over.dy).toBeGreaterThan(0);
  expect(r.over.dy).toBeLessThan(0.04);
  // It eats for a few seconds, then there's nothing left and it goes.
  expect(r.goneAt).toBeGreaterThan(5 * 60);
  expect(r.goneAt).toBeLessThan(15 * 60);
  expect(r.left).not.toBe('feed');
  // No crab is lost for good: the same one is back out on the rocks within a minute or so.
  expect(r.backAt).toBeGreaterThan(0);
  expect(r.back.dead).toBe(false);
  expect(r.after).toBe(r.before);
  expect(errors).toEqual([]);
});

test('it takes two strikes to put another iguana down, then the hawk eats it and it comes back', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    g.hawkDo('hunt_iguana');
    const hits: number[] = [];
    let down = -1;
    for (let i = 0; i < 120 * 60 && down < 0; i++) {
      g.advance(1, false);
      const struck = g.iguanas().findIndex((ig) => ig.hits > 0 || ig.down);
      if (struck >= 0) {
        const ig = g.iguanas()[struck];
        if (!hits.includes(ig.hits)) hits.push(ig.hits);
        if (ig.down) down = struck;
      }
    }
    const atDown = g.iguanas()[down];
    let feedAt = -1;
    for (let i = 0; i < 30 * 60 && feedAt < 0; i++) {
      g.advance(1, false);
      if (g.hawk().feeding) feedAt = i;
    }
    const h = g.hawk();
    const over = { flat: Math.hypot(h.x - atDown.x, h.z - atDown.z), clip: h.clip, quarry: h.quarry };
    let goneAt = -1;
    for (let i = 0; i < 30 * 60 && goneAt < 0; i++) {
      g.advance(1, false);
      if (g.iguanas()[down].gone) goneAt = i;
    }
    g.hawkDo('off');
    let backAt = -1;
    for (let i = 0; i < 120 * 60 && backAt < 0; i++) {
      g.advance(10, false);
      if (!g.iguanas()[down].gone) backAt = i * 10;
    }
    return { hits, down, atDownClip: atDown.clip, feedAt, over, goneAt, backAt, back: g.iguanas()[down] };
  });
  expect(r.down).toBeGreaterThanOrEqual(0);
  // A flinch for the first strike, down on the second.
  expect(r.hits).toEqual([1, 2]);
  expect(r.atDownClip).toBe('collapse');
  expect(r.feedAt).toBeGreaterThan(0);
  expect(r.over.clip).toBe('feed');
  expect(r.over.quarry).toEqual({ kind: 'iguana', index: r.down });
  expect(r.over.flat).toBeLessThan(0.05);
  expect(r.goneAt).toBeGreaterThan(5 * 60);
  expect(r.backAt).toBeGreaterThan(0);
  expect(r.back).toMatchObject({ gone: false, down: false, hits: 0 });
  expect(errors).toEqual([]);
});

test('after knocking the lizard down the hawk stands on it, eating, until it comes back at the spawn', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const spawn = g.player();
    g.hawkDo('hunt');
    let downAt = -1;
    for (let i = 0; i < 120 * 60 && downAt < 0; i++) {
      g.advance(1, false);
      if (g.wounds().down) downAt = i;
    }
    let feedAt = -1;
    for (let i = 0; i < 10 * 60 && feedAt < 0; i++) {
      g.advance(1, false);
      if (g.hawk().feeding) feedAt = i;
    }
    const p = g.player();
    const h = g.hawk();
    const over = { flat: Math.hypot(h.x - p.x, h.z - p.z), clip: h.clip, countdown: g.wounds().countdown };
    // It is still there, eating, when the countdown runs out; then it leaves.
    let up = -1;
    for (let i = 0; i < 10 * 60 && up < 0; i++) {
      g.advance(1, false);
      if (!g.wounds().down) up = i;
    }
    const whenUp = g.hawk().feeding;
    g.advance(30, false);
    return { downAt, feedAt, over, up, whenUp, after: g.hawk(), wounds: g.wounds(), spawn, player: g.player() };
  });
  expect(r.downAt).toBeGreaterThan(0);
  // On the ground beside the lizard within a couple of seconds of the knock-down.
  expect(r.feedAt).toBeLessThan(3 * 60);
  expect(r.over.clip).toBe('feed');
  expect(r.over.flat).toBeLessThan(0.05);
  expect(r.over.countdown).not.toBeNull();
  // It eats through the whole countdown and only leaves once the lizard is back.
  expect(r.whenUp).toBe(true);
  expect(r.after.feeding).toBe(false);
  expect(r.wounds.hits).toBe(0);
  expect(Math.hypot(r.player.x - r.spawn.x, r.player.z - r.spawn.z)).toBeLessThan(0.02);
  expect(errors).toEqual([]);
});

test("the hawk's shadow passing over sends crabs and iguanas running", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const before = { crabs: g.crabs().map((c) => c.state), iguanas: g.iguanas().map((i) => i.activity) };
    let was = g.crabs().map((c) => c.state);
    g.hawkDo('hunt_iguana');
    let bolted = -1;
    let fled = -1;
    for (let i = 0; i < 60 * 60 && (bolted < 0 || fled < 0); i++) {
      g.advance(1, false);
      if (bolted < 0 && g.iguanas().some((x) => x.activity === 'bolt' || x.activity === 'freeze')) bolted = i;
      // A crab that broke into a run just as the hawk came over it (others are busy fearing the lizard).
      const h = g.hawk();
      const now = g.crabs();
      if (fled < 0) {
        for (let k = 0; k < now.length; k++) {
          if (was[k] === 'flee' || now[k].state !== 'flee') continue;
          if (Math.hypot(now[k].x - h.x, now[k].z - h.z) < 0.2) fled = i;
        }
      }
      was = now.map((c) => c.state);
      if (h.feeding) break;
    }
    return { before, bolted, fled, scared: g.hawk().scared };
  });
  // Nothing is running before it comes over.
  expect(r.before.iguanas.every((a) => a !== 'bolt' && a !== 'freeze')).toBe(true);
  expect(r.bolted).toBeGreaterThan(0);
  expect(r.fled, 'a crab ran as the hawk came over it').not.toBe(-1);
  expect(r.scared).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});

test('the rock piles have gaps to hide in where the hawk cannot see the lizard', async ({ page }) => {
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.hawkDo('off');
    g.advance(2, false);
    return g.shelters().map((s) => {
      g.teleport(s.x, s.z, 0);
      g.advance(20, false);
      const p = g.player();
      const seen = (x: number, y: number, z: number) => g.inSight({ x, y, z }, p.x, p.y + 0.015, p.z);
      return {
        name: s.name,
        headroom: s.roofY - s.y,
        y: p.y,
        ground: s.y,
        overhead: seen(p.x, p.y + 1.2, p.z),
        slant: seen(p.x + 0.9, p.y + 1.1, p.z + 0.3),
        // The cover is only under the slab: a body length out to either side the sky is open again.
        out: [-0.25, -0.15, 0.15, 0.25].some((dz) => {
          g.teleport(s.x, s.z + dz, 0);
          g.advance(20, false);
          const q = g.player();
          return g.inSight({ x: q.x, y: q.y + 1.2, z: q.z }, q.x, q.y + 0.015, q.z);
        }),
      };
    });
  });
  expect(r.length).toBeGreaterThanOrEqual(2);
  for (const s of r) {
    // Room to stand under the slab, and it stands on the ground there.
    expect(s.headroom, s.name).toBeGreaterThan(0.035);
    expect(Math.abs(s.y - s.ground), s.name).toBeLessThan(0.01);
    // Out of sight from above, and from a hawk coming in low, but not out in the open beside it.
    expect(s.overhead, s.name).toBe(false);
    expect(s.slant, s.name).toBe(false);
    expect(s.out, s.name).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('peeking out of a shelter with only the head showing, the hawk cannot make the lizard out', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const g = window.__game!;
    g.hawkDo('off');
    g.advance(2, false);
    // Facing out of each shelter, head and neck past the roof's edge, then stepped right out.
    const views = g.shelters().map((s) => {
      const dir = s.name.endsWith('n') ? 1 : -1;
      const look = (d: number) => {
        g.teleport(s.x, s.z + dir * d, dir > 0 ? 0 : Math.PI);
        g.advance(20, false);
        const p = g.player();
        return g.lizardInView({ x: p.x, y: p.y + 1.2, z: p.z });
      };
      return { name: s.name, peek: look(0.1), out: look(0.15) };
    });
    // Head out of the first one while the hawk hunts: it circles, gets the odd glimpse from low over
    // the sea, never strikes, and gives up.
    const s = g.shelters()[0];
    const dir = s.name.endsWith('n') ? 1 : -1;
    g.teleport(s.x, s.z + dir * 0.08, dir > 0 ? 0 : Math.PI);
    g.advance(20, false);
    g.hawkDo('on');
    g.hawkDo('hunt');
    let gaveUp = -1;
    for (let i = 0; i < 12 * 60; i++) {
      g.advance(1, false);
      if (!g.hawk().hunting) {
        gaveUp = i;
        break;
      }
    }
    return { views, gaveUp, hits: g.wounds().hits };
  });
  for (const v of r.views) {
    // Some of it shows, but not enough; a step further out and it's plain to see.
    expect(v.peek.seen, v.name).toBeGreaterThan(0);
    expect(v.peek.sees, v.name).toBe(false);
    expect(v.out.sees, v.name).toBe(true);
  }
  expect(r.gaveUp).toBeGreaterThan(0);
  expect(r.hits).toBe(0);
  expect(errors).toEqual([]);
});
