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
  expect(s.bullDepth).toBeGreaterThan(0.03);
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
    for (let i = 0; i < 40 && g.sealions().bull.hits === 0; i++) {
      steps(0.1);
      const st = g.sealions().bull.state[0];
      if (!seen.endsWith(st)) seen += st;
    }
    const hit = { seen, ...g.sealions().bull, vitals: g.vitals() };
    // Off his beach while he goes back to his beat; then down onto it, and up the beach as he rears.
    g.teleport(0, 2.8, 0);
    for (let i = 0; i < 150 && g.sealions().bull.state !== 'patrol'; i++) steps(0.1);
    steps(4.5);
    x = g.sealions().bull.x;
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
