import { expect, test } from '@playwright/test';
import { bootBeach } from './helpers/bootBeach';
import { screenshot } from './helpers/screenshot';

/**
 * The sea lion beach (`?level=beach`): the ground, the bull's warning and charge, a pup's nudge, the
 * rival males' displays and shoving matches, claiming and holding a display rock, and the female.
 */

test('the beach loads: the reef start, the sea lions, the lek and its males, the seabirds', async ({ page }) => {
  const errors = await bootBeach(page);
  const s = await page.evaluate(() => {
    const g = window.__beach!;
    let worst = 0;
    for (let i = 0; i < 40; i++) {
      const x = -4.5 + (i % 8) * 1.2;
      const z = -4.5 + Math.floor(i / 8) * 2.2;
      const hit = g.groundAt(x, z, 1);
      if (hit !== null && hit - g.terrainHeight(x, z) < 0.01) worst = Math.max(worst, Math.abs(hit - g.terrainHeight(x, z)));
    }
    const start = g.start();
    g.advance(30);
    return { worst, start, player: g.player(), sealions: g.sealions(), rivals: g.rivals(), rocks: g.displayRocks(), birds: g.birds(), run: g.run(), bullDepth: g.depth(g.sealions().bull.x, g.sealions().bull.z) };
  });
  expect(errors).toEqual([]);
  expect(s.worst).toBeLessThan(0.006);
  // On the reef, out of the water.
  expect(s.player.swimming).toBe(false);
  expect(Math.hypot(s.player.x - s.start.x, s.player.z - s.start.z)).toBeLessThan(0.05);
  expect(s.sealions.cows.length).toBe(5);
  expect(s.sealions.pups.length).toBe(3);
  expect(s.sealions.bull.state).toBe('patrol');
  // He swims his beat in water deep enough to swim in.
  expect(s.bullDepth).toBeGreaterThan(0.14);
  // Each male on top of his rock, each rock his.
  expect(s.rivals.owner).toEqual([0, 1, 2]);
  s.rivals.males.forEach((m, i) => {
    expect(Math.hypot(m.x - s.rocks[i].x, m.z - s.rocks[i].z)).toBeLessThan(s.rocks[i].r);
    expect(m.y).toBeGreaterThan(s.rocks[i].top - 0.02);
  });
  expect(s.birds.filter((b) => b.kind === 'penguin').length).toBe(4);
  expect(s.birds.filter((b) => b.kind === 'cormorant').length).toBe(2);
  expect(s.run.goals.length).toBe(10);
  await screenshot(page, 'beach-start.png');
});

test('the bull warns a lizard on his beach, then charges: standing still it is hit, running off his stretch it gets away', async ({ page }) => {
  const errors = await bootBeach(page, { sealions: true });
  const r = await page.evaluate(() => {
    const g = window.__beach!;
    const steps = (s: number, input?: { move: { x: number; y: number }; run?: boolean }) => {
      if (input) g.setInput(input, Math.round(s * 60));
      g.advance(Math.round(s * 60));
    };
    const bull = g.sealions().bull;
    // Up the sand in front of him, and on his stretch.
    let x = bull.x;
    g.teleport(x, g.shoreZ(x) + 0.5, Math.PI);
    let seen = '';
    for (let i = 0; i < 80 && g.sealions().bull.hits === 0; i++) {
      steps(0.1);
      const st = g.sealions().bull.state[0];
      if (!seen.endsWith(st)) seen += st;
    }
    const hit = { seen, ...g.sealions().bull, vitals: g.vitals() };
    // Off his beach while he goes back to his beat; then down onto it, and up the beach as he rears.
    g.teleport(0, 2.8, 0);
    for (let i = 0; i < 150 && g.sealions().bull.state !== 'patrol'; i++) steps(0.1);
    steps(4.5);
    // Straight up the beach from in front of him, in a lane clear of the cows and pups lying there.
    const s = g.sealions();
    const lying = [...s.cows, ...s.pups].map((c) => c.x);
    x = [0, -0.2, 0.2, -0.4, 0.4, -0.6, 0.6].map((d) => s.bull.x + d).find((lx) => lying.every((cx) => Math.abs(cx - lx) > 0.25))!;
    g.teleport(x, g.shoreZ(x) + 0.7, 0);
    for (let i = 0; i < 40 && g.sealions().bull.state !== 'rear'; i++) steps(0.1);
    const reared = g.sealions().bull.state;
    steps(3, { move: { x: 0, y: 1 }, run: true });
    const p = g.player();
    return { hit, reared, dodge: g.sealions().bull, off: !g.onBullStretch(p.x, p.z), goals: g.run().goals.filter((x) => x.done).map((x) => x.id) };
  });
  expect(r.hit.seen).toMatch(/^p?rc/);
  expect(r.hit.hits).toBe(1);
  // A third of its health gone, and thrown aside.
  expect(r.hit.vitals.health).toBeCloseTo(0.65, 2);
  expect(r.reared).toBe('rear');
  expect(r.off).toBe(true);
  expect(r.dodge.dodged).toBe(1);
  expect(r.dodge.hits).toBe(1);
  expect(r.goals).toContain('bull');
  expect(errors).toEqual([]);
});

test('a curious pup comes over and nudges the lizard, then goes back to its mother', async ({ page }) => {
  const errors = await bootBeach(page, { sealions: true });
  const r = await page.evaluate(() => {
    const g = window.__beach!;
    const pup = g.sealions().pups[0];
    g.teleport(pup.x + 0.35, pup.z, -Math.PI / 2);
    const before = g.player();
    let seen = '';
    for (let i = 0; i < 40; i++) {
      g.advance(6);
      const st = g.sealions().pups[0].state[0];
      if (!seen.endsWith(st)) seen += st;
    }
    const after = g.player();
    return { seen, nudges: g.sealions().nudges, moved: Math.hypot(after.x - before.x, after.z - before.z), goals: g.run().goals.filter((x) => x.done).map((x) => x.id) };
  });
  expect(r.seen).toMatch(/^r?cnb/);
  expect(r.nudges).toBe(1);
  expect(r.moved).toBeGreaterThan(0.03);
  expect(r.goals).toContain('pup');
  expect(errors).toEqual([]);
});

test('displaying back at the young male makes him back down; a vacant rock is claimed; seeing off his challenge brings a female, who chooses the lizard', async ({ page }) => {
  const errors = await bootBeach(page, { rivals: true });
  const r = await page.evaluate(() => {
    const g = window.__beach!;
    const steps = (s: number, input?: { move: { x: number; y: number } }) => {
      if (input) g.setInput(input, Math.round(s * 60));
      g.advance(Math.round(s * 60));
    };
    // The clock runs once it has moved.
    steps(0.2, { move: { x: 0, y: 0.3 } });
    const rock = g.displayRocks()[0];
    g.teleport(rock.x, rock.z - 0.5, 0);
    // Answer each of his displays.
    const answer = () => {
      if (g.rivals().males[0].displaying) {
        steps(0.3);
        g.display();
        steps(1.3);
      }
    };
    for (let i = 0; i < 80 && g.rivals().males[0].state !== 'retreat'; i++) {
      steps(0.1);
      answer();
    }
    const backedDown = { state: g.rivals().males[0].state, exchanges: g.rivals().males[0].exchanges, owner: g.rivals().owner };
    // Up onto the vacant rock: claimed after a moment.
    g.teleport(rock.x, rock.z, 0, rock.top + 0.01);
    steps(1);
    const early = g.rivals().owner[0];
    steps(1.5);
    const claimed = g.rivals().owner[0];
    // He comes back for it; out-displayed again, he goes, and a female comes over.
    g.rivalTo(0, 'return');
    for (let i = 0; i < 200 && g.rivals().defended === 0; i++) {
      steps(0.1);
      answer();
    }
    const defended = g.rivals().defended;
    let female = '';
    for (let i = 0; i < 200 && !g.rivals().chosen; i++) {
      steps(0.1);
      const f = g.rivals().females.find((x) => x.state !== 'bask');
      if (f && !female.endsWith(f.state[0])) female += f.state[0];
      if (f?.state === 'watch') {
        g.display();
        steps(1.3);
      }
    }
    return { backedDown, early, claimed, defended, female, rivals: g.rivals(), run: g.run() };
  });
  expect(r.backedDown).toMatchObject({ state: 'retreat', exchanges: 2, owner: [null, 1, 2] });
  expect(r.early).toBe(null);
  expect(r.claimed).toBe('player');
  expect(r.defended).toBe(1);
  expect(r.female).toMatch(/^cw/);
  expect(r.rivals.courtship).toBe(2);
  expect(r.rivals.chosen).toBe(true);
  expect(r.run.state).toBe('home');
  expect(r.run.goals.filter((x) => x.done).map((x) => x.id)).toEqual(expect.arrayContaining(['display', 'claim', 'hold', 'chosen']));
  expect(errors).toEqual([]);
});

test('the old male never backs down: pushing alone only holds him, butting as he eases off wins the shove', async ({ page }) => {
  const errors = await bootBeach(page, { rivals: true });
  const r = await page.evaluate(() => {
    const g = window.__beach!;
    const steps = (s: number, input?: { move: { x: number; y: number } }) => {
      if (input) g.setInput(input, Math.round(s * 60));
      g.advance(Math.round(s * 60));
    };
    const m = g.rivals().males[1];
    g.teleport(m.x, m.z - 0.35, 0);
    for (let i = 0; i < 40 && !g.rivals().match; i++) steps(0.1, { move: { x: 0, y: 0.6 } });
    const engaged = !!g.rivals().match;
    // Held head to head: the lizard's own input doesn't move it.
    const held = g.run().held;
    // Pushing without butting: three seconds, no way through.
    steps(3, { move: { x: 0, y: 1 } });
    const pushOnly = g.rivals().match?.push ?? null;
    // Butting each time he eases off.
    for (let i = 0; i < 200 && g.rivals().match; i++) {
      const easing = g.rivals().match!.t >= 0.7;
      g.setInput({ move: { x: 0, y: 1 }, jump: easing && i % 2 === 0 } as never, 3);
      g.advance(3);
    }
    return { engaged, held, pushOnly, rivals: g.rivals() };
  });
  expect(r.engaged).toBe(true);
  expect(r.held).toBe(true);
  expect(r.pushOnly).not.toBe(null);
  expect(Math.abs(r.pushOnly!)).toBeLessThan(0.1);
  expect(r.rivals.shoveWins).toBe(1);
  expect(r.rivals.males[1].state).toBe('retreat');
  expect(r.rivals.owner[1]).toBe(null);
  expect(errors).toEqual([]);
});

test('swimming beside a penguin ticks its goal', async ({ page }) => {
  const errors = await bootBeach(page);
  const r = await page.evaluate(() => {
    const g = window.__beach!;
    const p = g.birds()[3];
    g.teleport(p.x, p.z, 0, -0.06);
    g.advance(20);
    return { player: g.player(), birds: g.birdGoals() };
  });
  expect(r.player.swimming).toBe(true);
  expect(r.birds.penguin).toBe(true);
  expect(errors).toEqual([]);
});

test('the penguins swim only over open water: their loops keep clear of the lava and the rocks', async ({ page }) => {
  const errors = await bootBeach(page);
  const bad = await page.evaluate(() => {
    const g = window.__beach!;
    g.advance(1);
    const out: string[] = [];
    for (const l of g.swimLoops()) {
      for (let k = 0; k < 96; k++) {
        const a = (k / 96) * Math.PI * 2;
        const x = l.x + Math.cos(a) * l.rx;
        const z = l.z + Math.sin(a) * l.rz;
        // A penguin's body round its middle, as well as the middle itself.
        for (const [dx, dz] of [[0, 0], [0.06, 0], [-0.06, 0], [0, 0.06], [0, -0.06]]) {
          const top = Math.max(g.terrainHeight(x + dx, z + dz), g.groundAt(x + dx, z + dz, 2) ?? -9);
          if (top > -0.07) out.push(`${x.toFixed(2)},${z.toFixed(2)}: ${top.toFixed(3)}`);
        }
      }
    }
    return out;
  });
  expect(bad).toEqual([]);
  expect(errors).toEqual([]);
});

test('the sea lions lie on the sand: a cow lying down or sitting up rests her belly and rump on it, never above', async ({ page }) => {
  const errors = await bootBeach(page);
  const cows = await page.evaluate(() => {
    window.__beach!.advance(1);
    return window.__beach!.sealions().cows;
  });
  for (const c of cows) {
    // Rump to mid-belly: on the sand (a little sunk in, at most), lying or sitting up.
    for (const gap of c.gaps.slice(0, 4)) {
      expect(gap).toBeGreaterThan(-0.01);
      expect(gap).toBeLessThan(0.008);
    }
  }
  // Sitting up, her chest is lifted off the sand on her fore-flippers.
  const sitting = cows.find((c) => c.lift === 1)!;
  expect(sitting.gaps[sitting.gaps.length - 2]).toBeGreaterThan(0.02);
  expect(errors).toEqual([]);
});

test('a penguin and a cormorant go to sea and come back: in from the edge, swimming and diving clear of rock, out onto the rock', async ({ page }) => {
  const errors = await bootBeach(page);
  const r = await page.evaluate(() => {
    const g = window.__beach!;
    const seen = ['', ''];
    const dived = [false, false];
    const bad: string[] = [];
    for (let i = 0; i < 1100 && !seen.every((s) => /wisob a$/.test(s)); i++) {
      g.advance(6);
      g.birdTrips().forEach((t, k) => {
        const mark = t.state === 'ashore' ? ' a' : t.state[0];
        if (!seen[k].endsWith(mark)) seen[k] += mark;
        if (t.under > 0.5) dived[k] = true;
        const top = Math.max(g.terrainHeight(t.x, t.z), g.groundAt(t.x, t.z, 2) ?? -9);
        // At sea, water under it all the way round; ashore and walking, on the ground, not in it or floating.
        if (t.state === 'sea' && top > t.y - 0.005) bad.push(`${t.kind} sea over rock ${t.x.toFixed(2)},${t.z.toFixed(2)}`);
        if ((t.state === 'walk' || t.state === 'back' || t.state === 'ashore') && Math.abs(t.y - top) > 0.004) bad.push(`${t.kind} ${t.state} off the ground by ${(t.y - top).toFixed(3)}`);
      });
    }
    return { seen, dived, bad: bad.slice(0, 5) };
  });
  for (const s of r.seen) expect(s).toMatch(/ awisob a$/);
  expect(r.dived).toEqual([true, true]);
  expect(r.bad).toEqual([]);
  expect(errors).toEqual([]);
});
