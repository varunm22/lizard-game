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
  expect(s.run.goals.length).toBe(9);
  // Being chosen is the objective, not a goal.
  expect(s.run.goals.map((x) => x.id)).not.toContain('chosen');
  expect(s.run.objective).toMatchObject({ text: 'Be chosen by a female', done: false });
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

test("once the bull charges he's committed: walking up the beach off his stretch, the lizard is still caught and hurt", async ({ page }) => {
  const errors = await bootBeach(page, { sealions: true });
  const r = await page.evaluate(() => {
    const g = window.__beach!;
    const s = g.sealions();
    const lying = [...s.cows, ...s.pups];
    const x = [-1.2, -1.4, -1.0, -1.6, -0.8, -2.8, -3.0].find((lx) => lying.every((c) => Math.hypot(c.x - lx, c.z - (g.shoreZ(lx) + 1.3)) > 0.5))!;
    g.teleport(x, g.shoreZ(x) + 1.3, 0);
    g.placeBull(x, g.shoreZ(x) - 0.3, 0, 'patrol');
    let offStretch = false;
    for (let i = 0; i < 70 && g.sealions().bull.hits === 0; i++) {
      if (g.sealions().bull.state === 'charge') g.setInput({ move: { x: 0, y: 0.5 } }, 6);
      g.advance(6);
      const p = g.player();
      if (!g.onBullStretch(p.x, p.z)) offStretch = true;
    }
    return { offStretch, bull: g.sealions().bull, vitals: g.vitals() };
  });
  expect(r.offStretch).toBe(true);
  expect(r.bull.hits).toBe(1);
  expect(r.vitals.health).toBeLessThan(0.7);
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
    const mother = g.sealions().cows[g.sealions().pups[0].mother];
    return { mother, seen, nudges: g.sealions().nudges, moved: Math.hypot(after.x - before.x, after.z - before.z), goals: g.run().goals.filter((x) => x.done).map((x) => x.id) };
  });
  expect(r.seen).toMatch(/^r?cnb/);
  expect(r.nudges).toBe(1);
  // Her pup's nudge woke its mother: she's sitting up, barking for the bull.
  expect(r.mother.alarm).toBeGreaterThan(0);
  expect(r.mother.lift).toBeGreaterThan(0.6);
  expect(r.moved).toBeGreaterThan(0.03);
  expect(r.goals).toContain('pup');
  expect(errors).toEqual([]);
});

test('displaying back at the young male makes him back down; a vacant rock is claimed; seeing off his challenge is a goal, but no female comes to his rock', async ({ page }) => {
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
    // He comes back for it; out-displayed again, he goes.
    g.rivalTo(0, 'return');
    for (let i = 0; i < 200 && g.rivals().defended === 0; i++) {
      steps(0.1);
      answer();
    }
    const defended = g.rivals().defended;
    steps(2);
    return { backedDown, early, claimed, defended, rivals: g.rivals(), run: g.run() };
  });
  expect(r.backedDown).toMatchObject({ state: 'retreat', exchanges: 2, owner: [null, 1, 2] });
  expect(r.early).toBe(null);
  expect(r.claimed).toBe('player');
  expect(r.defended).toBe(1);
  // The females only come to the old male's rock.
  expect(r.rivals.females.every((f) => f.state === 'bask')).toBe(true);
  expect(r.run.goals.filter((x) => x.done).map((x) => x.id)).toEqual(expect.arrayContaining(['display', 'claim', 'hold']));
  expect(r.run.objective.hint).toMatch(/old male's rock/);
  expect(errors).toEqual([]);
});

test("the old male chases the lizard off; led onto the bull's beach the bull charges him off, and his rock brings a female, who ignores a cold display but chooses a warm one", async ({ page }) => {
  const errors = await bootBeach(page, { rivals: true, sealions: true });
  const r = await page.evaluate(() => {
    const g = window.__beach!;
    const steps = (s: number, input?: { move: { x: number; y: number } }) => {
      if (input) g.setInput(input, Math.round(s * 60));
      g.advance(Math.round(s * 60));
    };
    steps(0.2, { move: { x: 0, y: 0.3 } });
    const rock = g.displayRocks()[1];
    // Near his rock: he displays, then comes off it after the lizard.
    g.teleport(rock.x, rock.z - 0.5, 0);
    for (let i = 0; i < 60 && g.rivals().males[1].state !== 'chase'; i++) steps(0.1);
    const chased = g.rivals().males[1].state;
    // Down on the bull's stretch, the old male close behind the lizard, the bull just off the beach in front.
    const s = g.sealions();
    const lying = [...s.cows, ...s.pups];
    const x = [-1.2, -1.4, -1.0, -1.6, -0.8].find((lx) => lying.every((c) => Math.hypot(c.x - lx, c.z - (g.shoreZ(lx) + 0.6)) > 0.45))!;
    const z = g.shoreZ(x) + 0.6;
    g.teleport(x, z - 0.25, Math.PI);
    g.placeRival(1, x, z, Math.PI);
    g.placeBull(x, g.shoreZ(x) - 0.4, 0, 'patrol');
    let seen = '';
    for (let i = 0; i < 60 && g.rivals().males[1].state !== 'routed'; i++) {
      steps(0.1);
      const st = g.sealions().bull.state[0];
      if (!seen.endsWith(st)) seen += st;
    }
    const routed = { male: g.rivals().males[1].state, owner: g.rivals().owner[1], quarry: g.sealions().bull.quarry, routs: g.sealions().bull.routs, hits: g.sealions().bull.hits };
    g.pause({ sealions: true });
    // Up onto his vacant rock: claimed, and a female comes over.
    g.teleport(rock.x, rock.z, 0, rock.top + 0.01);
    steps(2.5);
    const claimed = g.rivals().owner[1];
    let female = '';
    for (let i = 0; i < 100 && !g.rivals().females.some((f) => f.state === 'watch'); i++) {
      steps(0.1);
      const f = g.rivals().females.find((x) => x.state !== 'bask');
      if (f && !female.endsWith(f.state[0])) female += f.state[0];
    }
    // Cold, a display does nothing.
    g.setVitals({ warmth: 0.3 });
    const coldHint = g.run().objective.hint;
    g.display();
    steps(1.3);
    g.display();
    steps(1.3);
    const cold = g.rivals().courtship;
    g.setVitals({ warmth: 0.7 });
    for (let i = 0; i < 10 && !g.rivals().chosen; i++) {
      g.display();
      steps(1.3);
    }
    return { chased, seen, routed, claimed, female, cold, coldHint, rivals: g.rivals(), run: g.run() };
  });
  expect(r.chased).toBe('chase');
  expect(r.seen).toMatch(/rc/);
  expect(r.routed).toMatchObject({ male: 'routed', owner: null, routs: 1, hits: 0 });
  expect(r.claimed).toBe('player');
  expect(r.female).toMatch(/^cw?/);
  expect(r.coldHint).toMatch(/cold/i);
  expect(r.cold).toBe(0);
  expect(r.rivals.courtship).toBe(2);
  expect(r.rivals.chosen).toBe(true);
  expect(r.run.state).toBe('home');
  expect(r.run.objective.done).toBe(true);
  expect(errors).toEqual([]);
});

test('the old male cannot be shoved; the seasoned one can, butting as he eases off, but not by a cold lizard', async ({ page }) => {
  const errors = await bootBeach(page, { rivals: true });
  const r = await page.evaluate(() => {
    const g = window.__beach!;
    const steps = (s: number, input?: { move: { x: number; y: number } }) => {
      if (input) g.setInput(input, Math.round(s * 60));
      g.advance(Math.round(s * 60));
    };
    const butt = (n: number) => {
      for (let i = 0; i < n && g.rivals().match; i++) {
        const easing = g.rivals().match!.t >= 0.7;
        g.setInput({ move: { x: 0, y: 1 }, jump: easing && i % 2 === 0 } as never, 3);
        g.advance(3);
      }
    };
    const engage = (i: number) => {
      const m = g.rivals().males[i];
      g.teleport(m.x, m.z - 0.3, 0);
      for (let k = 0; k < 60 && !g.rivals().match; k++) steps(0.1, { move: { x: 0, y: 0.6 } });
      return !!g.rivals().match;
    };
    // The old male: butting all the way, the lizard loses.
    const oldEngaged = engage(1);
    butt(300);
    const old = { losses: g.rivals().shoveLosses, wins: g.rivals().shoveWins, owner: g.rivals().owner[1] };
    g.restart();
    g.pause({ rivals: false });
    // The seasoned male, the lizard cold: pushing and butting, it can't win.
    g.setVitals({ warmth: 0.3 });
    const coldEngaged = engage(2);
    butt(300);
    const cold = { losses: g.rivals().shoveLosses, wins: g.rivals().shoveWins };
    g.restart();
    g.setVitals({ warmth: 0.7 });
    const engaged = engage(2);
    const held = g.run().held;
    // Pushing without butting: three seconds, no way through.
    steps(3, { move: { x: 0, y: 1 } });
    const pushOnly = g.rivals().match?.push ?? null;
    butt(300);
    return { oldEngaged, old, coldEngaged, cold, engaged, held, pushOnly, rivals: g.rivals() };
  });
  expect(r.oldEngaged).toBe(true);
  expect(r.old).toMatchObject({ wins: 0, owner: 1 });
  expect(r.old.losses).toBeGreaterThan(0);
  expect(r.coldEngaged).toBe(true);
  expect(r.cold.wins).toBe(0);
  expect(r.engaged).toBe(true);
  expect(r.held).toBe(true);
  expect(r.pushOnly).not.toBe(null);
  expect(Math.abs(r.pushOnly!)).toBeLessThan(0.1);
  expect(r.rivals.shoveWins).toBe(1);
  expect(r.rivals.males[2].state).toBe('retreat');
  expect(r.rivals.owner[2]).toBe(null);
  expect(errors).toEqual([]);
});

test("the bull leaves a lizard beside his cows alone, until a pup's nudge sets its mother barking", async ({ page }) => {
  const errors = await bootBeach(page, { sealions: true });
  const r = await page.evaluate(() => {
    const g = window.__beach!;
    const steps = (s: number) => g.advance(Math.round(s * 60));
    const s = g.sealions();
    const pup = s.pups[1];
    const cow = s.cows[pup.mother];
    // Beside her on the side away from her pup, on his stretch, the bull right in front.
    const ax = cow.x - pup.x;
    const az = cow.z - pup.z;
    const d = Math.hypot(ax, az);
    const x = cow.x + (ax / d) * 0.22;
    const z = cow.z + (az / d) * 0.22;
    g.teleport(x, z, Math.atan2(-ax, -az));
    const onStretch = g.onBullStretch(x, z);
    const sheltered = g.sheltered(x, z);
    g.placeBull(x, g.shoreZ(x) - 0.3, 0, 'patrol');
    steps(2);
    const quiet = g.sealions().bull.state;
    // Beside her on her pup's side: still sheltered, but the pup comes and nudges; she barks, and the bull comes up the beach.
    const px = cow.x - (ax / d) * 0.2;
    const pz = cow.z - (az / d) * 0.2;
    g.teleport(px, pz, Math.atan2(ax, az));
    const besidePup = g.sheltered(px, pz);
    let seen = '';
    for (let i = 0; i < 80 && g.sealions().bull.state !== 'charge'; i++) {
      steps(0.1);
      const st = g.sealions().bull.state[0];
      if (!seen.endsWith(st)) seen += st;
    }
    return { onStretch, sheltered, besidePup, quiet, seen, nudges: g.sealions().nudges, alarm: g.sealions().cows[pup.mother].alarm };
  });
  expect(r.onStretch).toBe(true);
  expect(r.sheltered).toBe(true);
  expect(r.besidePup).toBe(true);
  expect(r.quiet).toBe('patrol');
  expect(r.nudges).toBe(1);
  expect(r.alarm).toBeGreaterThan(0);
  expect(r.seen).toMatch(/rc$/);
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

test('a standing penguin is solid: the lizard walking into it stops against it', async ({ page }) => {
  const errors = await bootBeach(page);
  const r = await page.evaluate(() => {
    const g = window.__beach!;
    // The second penguin on the point stands still (the first goes to sea).
    const [px, pz] = [3.55, -3.45];
    g.teleport(px - 0.18, pz, Math.PI / 2);
    g.advance(2);
    g.setInput({ move: { x: 0, y: 1 } }, 100);
    g.advance(100);
    return { gap: Math.hypot(g.player().x - px, g.player().z - pz) };
  });
  expect(r.gap).toBeGreaterThan(0.04);
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
        // Its solid body goes with it: trunk, neck and head within its own height of its feet.
        if (t.solid.length < 2 || t.solid.some((d) => d > 0.15)) bad.push(`${t.kind} solid body ${t.solid.map((d) => d.toFixed(3)).join(',')} from it`);
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
