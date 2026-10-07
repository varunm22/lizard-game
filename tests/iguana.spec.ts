import { expect, test, type Page } from '@playwright/test';
import { bootGame } from './helpers/bootGame';
import { screenshot } from './helpers/screenshot';

test('other marine iguanas bask on the lava shore, lying across the sun, and sneeze salt', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await bootGame(page, { iguanas: true });
  const start = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    return { iguanas: g.iguanas(), shoreX: g.iguanas().map((i) => g.shoreX(i.z)), waterY: g.ocean().waterY, clips: g.lizard().clips };
  });
  expect(start.iguanas.length).toBeGreaterThanOrEqual(2);
  for (const [i, ig] of start.iguanas.entries()) {
    // Up on the shore, out of the water, basking (idle) with the player's own clips.
    expect(ig.x).toBeLessThan(start.shoreX[i]);
    expect(ig.x).toBeGreaterThan(start.shoreX[i] - 0.6);
    expect(ig.y).toBeGreaterThan(start.waterY);
    expect(ig.grounded).toBe(true);
    expect(ig.swimming).toBe(false);
    expect(ig.activity).toBe('bask');
    expect(ig.clip).toBe('idle');
    // On bare black lava, not the beach.
    expect(ig.lava).toBeGreaterThan(0.8);
  }

  // A sneeze: the head comes up and jerks down, and a puff of salt spray comes out of the nose.
  const sneeze = await page.evaluate(() => {
    const g = window.__game!;
    const before = g.iguanas()[0].sneezes;
    g.iguanaDo(0, 'sneeze');
    let spray = 0;
    let sneezing = false;
    for (let k = 0; k < 120 && spray === 0; k++) {
      g.advance(1, false);
      sneezing ||= g.iguanas()[0].sneezing;
      spray = g.saltSpray();
    }
    const ig = g.iguanas()[0];
    // Side on, a little ahead.
    const fx = Math.sin(ig.yaw);
    const fz = Math.cos(ig.yaw);
    g.viewFrom({ x: fz * 0.14 + fx * 0.05, y: 0.04, z: -fx * 0.14 + fz * 0.05 }, { x: ig.x + fx * 0.08, y: ig.y + 0.025, z: ig.z + fz * 0.08 });
    g.advance(3);
    return { sneezes: g.iguanas()[0].sneezes - before, sneezing, spray, after: g.saltSpray() };
  });
  expect(sneeze.sneezing).toBe(true);
  expect(sneeze.sneezes).toBe(1);
  expect(sneeze.spray).toBeGreaterThan(5);
  await screenshot(page, 'iguana-sneeze.png');
  // The spray settles in a second.
  expect(await page.evaluate(() => (window.__game!.advance(60, false), window.__game!.saltSpray()))).toBe(0);

  // Left to themselves for a minute, each sneezes now and then; those that don't go to feed stay
  // basking on the shore, now and then shuffling to a new spot, and lie across the sun's rays.
  const later = await page.evaluate(() => {
    const g = window.__game!;
    const before = g.iguanas().map((i) => i.sneezes);
    const fed = new Set<number>();
    for (let s = 0; s < 60; s++) {
      g.advance(60, false);
      g.iguanas().forEach((i, n) => i.activity !== 'bask' && i.activity !== 'shuffle' && fed.add(n));
    }
    return { sneezes: g.iguanas().map((i, n) => i.sneezes - before[n]), fed: [...fed], now: g.iguanas() };
  });
  for (const n of later.sneezes) expect(n).toBeGreaterThan(0);
  await page.evaluate(() => {
    const g = window.__game!;
    const ig = g.iguanas().find((i) => i.activity === 'bask' && !i.swimming) ?? g.iguanas()[0];
    g.viewFrom({ x: -0.2, y: 0.09, z: 0.16 }, { x: ig.x, y: ig.y + 0.02, z: ig.z });
    g.advance(2);
  });
  await screenshot(page, 'iguana-bask.png');
  await page.evaluate(() => window.__game!.viewFrom(null));
  const sunYaw = Math.atan2(2.5, 1.7);
  for (const [i, ig] of later.now.entries()) {
    if (later.fed.includes(i) || ig.activity !== 'bask') continue;
    expect(ig.swimming).toBe(false);
    expect(Math.abs(ig.z - ig.home.z)).toBeLessThan(0.3);
    expect(ig.lava).toBeGreaterThan(0.8);
    // Broadside: facing within about 25° of square to the sun.
    expect(Math.abs(Math.cos(ig.yaw - sunYaw))).toBeLessThan(0.45);
  }
  expect(errors).toEqual([]);
});

test('a hungry iguana goes down to the sea, puts its snout to the algae and eats them, and comes back out to bask', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await bootGame(page, { iguanas: true });
  const { waterY } = await page.evaluate(() => window.__game!.ocean());
  await page.evaluate(() => (window.__game!.advance(2, false), window.__game!.iguanaDo(1, 'feed')));
  let swam = false;
  let shot = false;
  let back = false;
  /** For each patch it grazed: the closest its drawn snout came to the fronds, and whether it was under water. */
  const grazed = new Map<number, { touch: number; under: boolean }>();
  // Run it in half-second pieces, stopping early the first time its snout is in the fronds under water, for a picture.
  for (let s = 0; s < 360 && !back; s++) {
    const r = await page.evaluate(
      ([waterY, wantShot]) => {
        const g = window.__game!;
        let swam = false;
        let shot = false;
        const seen: { id: number; touch: number; under: boolean }[] = [];
        for (let k = 0; k < 30; k++) {
          g.advance(1, false);
          const ig = g.iguanas()[1];
          swam ||= ig.swimming;
          if (ig.activity !== 'graze' || !ig.meal || ig.touch === null) continue;
          const under = ig.swimming && ig.meal.y < waterY;
          seen.push({ id: ig.meal.id, touch: ig.touch, under });
          if (under && wantShot && ig.touch < 0.015) {
            // Side on, from a little behind, under the water with it.
            g.viewFrom({ x: Math.cos(ig.yaw) * 0.14 - Math.sin(ig.yaw) * 0.04, y: 0.015, z: -Math.sin(ig.yaw) * 0.14 - Math.cos(ig.yaw) * 0.04 }, { x: ig.meal.x, y: ig.meal.y + 0.01, z: ig.meal.z });
            g.advance(1);
            shot = true;
            break;
          }
        }
        const ig = g.iguanas()[1];
        return { swam, shot, seen, back: ig.meals > 0 && ig.activity === 'bask' && !ig.swimming };
      },
      [waterY, !shot] as const,
    );
    swam ||= r.swam;
    back = r.back;
    for (const v of r.seen) grazed.set(v.id, { touch: Math.min(v.touch, grazed.get(v.id)?.touch ?? Infinity), under: v.under || !!grazed.get(v.id)?.under });
    if (r.shot) {
      shot = true;
      await screenshot(page, 'iguana-graze.png');
      await page.evaluate(() => window.__game!.viewFrom(null));
    }
  }
  const trip = await page.evaluate((ids) => {
    const g = window.__game!;
    const end = g.iguanas()[1];
    const left = new Set(g.algae().map((a) => a.id));
    return { end, shoreX: g.shoreX(end.z), eaten: ids.filter((id) => !left.has(id)).length };
  }, [...grazed.keys()]);
  // It grazed at least one patch with its snout right in the fronds, and ate it: the patch is gone.
  expect(grazed.size).toBeGreaterThan(0);
  const touched = [...grazed.values()].filter((v) => v.touch < 0.018);
  expect(touched.length).toBeGreaterThan(0);
  expect(trip.eaten).toBeGreaterThan(0);
  expect(trip.end.bites).toBeGreaterThanOrEqual(6);
  expect(trip.end.meals).toBe(1);
  // Grazing under the sea meant swimming there.
  if ([...grazed.values()].some((v) => v.under)) expect(swam).toBe(true);
  // And it came back out onto the shore to bask.
  expect(back).toBe(true);
  expect(trip.end.x).toBeLessThan(trip.shoreX);
  expect(trip.end.y).toBeGreaterThan(waterY);
  expect(errors).toEqual([]);
});

test('algae sprout now and then on the rocks, growing in from nothing', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await bootGame(page);
  const run = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const ids = (list: { id: number }[]) => new Set(list.map((a) => a.id));
    const before = g.algae();
    // Left alone for a minute and a half, a few new patches come up by themselves.
    g.advance(90 * 60, false);
    const later = g.algae();
    const old = ids(before);
    const fresh = later.filter((a) => !old.has(a.id));
    // One sprouted now starts from nothing and grows in.
    const id = g.sproutAlgae()!;
    const at = (n: number) => g.algae().find((a) => a.id === n)!;
    const seedling = at(id);
    g.advance(20 * 60, false);
    const half = at(id).grown;
    g.advance(30 * 60, false);
    return { before: before.length, fresh, seedling, half, full: at(id).grown, wet: g.ocean().waterY };
  });
  expect(run.fresh.length).toBeGreaterThanOrEqual(2);
  expect(run.fresh.length).toBeLessThan(20);
  for (const a of [...run.fresh, run.seedling]) expect(a.y).toBeLessThan(run.wet + 0.02);
  expect(run.seedling.grown).toBe(0);
  expect(run.half).toBeGreaterThan(0.3);
  expect(run.half).toBeLessThan(0.7);
  expect(run.full).toBe(1);
  expect(errors).toEqual([]);
});

test('an iguana on its way goes round the lizard lying across its path instead of walking into it', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await bootGame(page, { iguanas: true });
  const run = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    // Send it off to feed, and once it's walking, lie the lizard across its way 20 cm ahead.
    g.iguanaDo(0, 'feed');
    let ig = g.iguanas()[0];
    for (let k = 0; k < 900 && !(ig.activity === 'to_food' && ig.state === 'walk' && !ig.swimming); k++) {
      g.advance(1, false);
      ig = g.iguanas()[0];
    }
    g.advance(30, false);
    ig = g.iguanas()[0];
    const dx = Math.sin(ig.yaw);
    const dz = Math.cos(ig.yaw);
    const start = { x: ig.x, z: ig.z };
    const px = ig.x + dx * 0.2;
    const pz = ig.z + dz * 0.2;
    g.teleport(px, pz, ig.yaw + Math.PI / 2);
    const p = g.player();
    // The lizard's body as a segment, snout to hips (its capsule's straight part, and the caps).
    const lx = Math.sin(p.yaw);
    const lz = Math.cos(p.yaw);
    const gap = (x: number, z: number) => {
      const t = Math.max(-0.06, Math.min(0.06, (x - p.x) * lx + (z - p.z) * lz));
      return Math.hypot(x - (p.x + lx * t), z - (p.z + lz * t));
    };
    let closest = Infinity;
    let past = false;
    // Backing up, and swinging one way then the other, is dithering.
    let back = 0;
    let swings = 0;
    let turn = 0;
    for (let k = 0; k < 600 && !past; k++) {
      const was = ig;
      g.advance(1, false);
      ig = g.iguanas()[0];
      back += Math.max(0, -((ig.x - was.x) * Math.sin(was.yaw) + (ig.z - was.z) * Math.cos(was.yaw)));
      const dyaw = Math.atan2(Math.sin(ig.yaw - was.yaw), Math.cos(ig.yaw - was.yaw));
      if (Math.abs(dyaw) > 0.004) {
        if (turn !== 0 && Math.sign(dyaw) !== turn) swings++;
        turn = Math.sign(dyaw);
      }
      // Its own body too: from its hips to its snout.
      const fx = Math.sin(ig.yaw);
      const fz = Math.cos(ig.yaw);
      for (const s of [-0.06, 0, 0.06]) closest = Math.min(closest, gap(ig.x + fx * s, ig.z + fz * s));
      past = (ig.x - start.x) * dx + (ig.z - start.z) * dz > 0.32;
    }
    const after = g.player();
    return { closest, past, back, swings, pushed: Math.hypot(after.x - p.x, after.z - p.z), activity: ig.activity };
  });
  // It got past the lizard without touching it (two bodies 12 mm in radius touch at 24 mm) or pushing it.
  expect(run.past).toBe(true);
  expect(run.closest).toBeGreaterThan(0.035);
  expect(run.pushed).toBeLessThan(0.002);
  // In one smooth sweep: off to one side, round the lizard and back onto its way, never backing up.
  console.log('go round', run.back, run.swings);
  expect(run.back).toBeLessThan(0.005);
  expect(run.swings).toBeLessThanOrEqual(3);
  expect(errors).toEqual([]);
});

test('an iguana looking for somewhere to bask comes and lies down beside the lizard basking nearby', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await bootGame(page, { iguanas: true });
  const run = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const ig0 = g.iguanas()[0];
    // A bare stretch of black lava 25-60 cm along the shore from it, no rock, log or cactus near.
    const yaw = ig0.yaw;
    let spot: { x: number; z: number } | null = null;
    for (const d of [0.25, -0.25, 0.3, -0.3, 0.35, -0.35, 0.4, -0.4, 0.45, -0.45, 0.5, -0.5, 0.55, -0.55, 0.6, -0.6]) {
      const z = ig0.z + d;
      for (const up of [0.15, 0.2, 0.25, 0.1, 0.3]) {
        const x = g.shoreX(z) - up;
        const ok = [-0.1, -0.05, 0, 0.05, 0.1].every((s) => {
          const px = x + Math.sin(yaw) * s;
          const pz = z + Math.cos(yaw) * s;
          for (const side of [-0.06, 0, 0.06]) {
            const qx = px + Math.cos(yaw) * side;
            const qz = pz - Math.sin(yaw) * side;
            if (g.lava(qx, qz) < 0.9 || Math.abs(g.groundAt(qx, qz)! - g.terrainHeight(qx, qz)) > 0.003) return false;
          }
          return true;
        });
        // With room all round to come and lie alongside.
        const roomy = g.obstacles().every((o) => Math.hypot(o.x - x, o.z - z) > o.radius + 0.09);
        if (ok && roomy) {
          spot = { x, z };
          break;
        }
      }
      if (spot) break;
    }
    if (!spot) throw new Error('no bare lava near the iguana');
    g.teleport(spot.x, spot.z, yaw);
    g.advance(30, false);
    g.iguanaDo(0, 'move');
    let ig = g.iguanas()[0];
    let mate: string | number | null = null;
    let took = 0;
    // Steps spent walking at the lizard from close by, getting nowhere.
    let pushing = 0;
    for (; took < 1500; took++) {
      const was = ig;
      g.advance(1, false);
      ig = g.iguanas()[0];
      mate ??= ig.mate;
      const p = g.player();
      if (ig.activity !== 'bask' && Math.hypot(ig.x - p.x, ig.z - p.z) < 0.09 && Math.hypot(ig.x - was.x, ig.z - was.z) < 0.001) pushing++;
      if (took > 300 && ig.activity === 'bask' && ig.state === 'idle') break;
    }
    g.advance(240, false);
    ig = g.iguanas()[0];
    const p = g.player();
    g.viewFrom({ x: -0.18, y: 0.14, z: 0.12 }, { x: (ig.x + p.x) / 2, y: p.y + 0.02, z: (ig.z + p.z) / 2 });
    g.advance(2);
    return { mate, took, pushing, ig, p, apart: Math.hypot(ig.x - p.x, ig.z - p.z) };
  });
  await screenshot(page, 'iguana-bask-together.png');
  // It went to the lizard, and lies alongside it, the same way round, on the lava.
  expect(run.mate).toBe('player');
  expect(run.ig.activity).toBe('bask');
  expect(run.apart).toBeLessThan(0.09);
  // Lined up and walked in along the lizard in one go, not round and round its spot first, and lay
  // down once close enough beside it rather than pushing on at it.
  expect(run.took).toBeLessThan(800);
  expect(run.pushing).toBeLessThan(40);
  expect(Math.abs(Math.cos(run.ig.yaw - run.p.yaw))).toBeGreaterThan(0.9);
  expect(run.ig.lava).toBeGreaterThan(0.8);
  expect(errors).toEqual([]);
});

test('crabs groom the other iguanas too, hopping onto a still one and off again when it moves', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await bootGame(page, { iguanas: true, crabs: true });
  const run = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    // Keep the lizard out of it, inland.
    g.teleport(0, 0, 0);
    let groomed: { crab: number; iguana: number } | null = null;
    for (let s = 0; s < 120 && !groomed; s++) {
      g.advance(30, false);
      const i = g.crabs().findIndex((c) => c.state === 'groom' && typeof c.grooming === 'number');
      if (i >= 0) groomed = { crab: i, iguana: g.crabs()[i].grooming as number };
    }
    if (!groomed) return { groomed, count: g.crabs().length };
    const c = g.crabs()[groomed.crab];
    const ig = g.iguanas()[groomed.iguana];
    g.viewFrom({ x: Math.cos(ig.yaw) * 0.16, y: 0.1, z: -Math.sin(ig.yaw) * 0.16 }, { x: ig.x, y: ig.y + 0.02, z: ig.z });
    g.advance(2);
    // Up on its back, then off again once the iguana gets up.
    const onBack = c.y - ig.y;
    g.iguanaDo(groomed.iguana, 'feed');
    let off = false;
    for (let k = 0; k < 600 && !off; k++) {
      g.advance(1, false);
      const now = g.crabs()[groomed.crab];
      off = now.state !== 'groom' && now.state !== 'hop';
    }
    return { groomed, count: g.crabs().length, onBack, off, igState: g.iguanas()[groomed.iguana].activity };
  });
  await screenshot(page, 'crab-grooms-iguana.png');
  expect(run.count).toBeGreaterThanOrEqual(15);
  expect(run.groomed).not.toBeNull();
  expect(run.onBack).toBeGreaterThan(0.015);
  expect(run.off).toBe(true);
  expect(errors).toEqual([]);
});

/** Open ground by the shore (the beach), flat and dry 15 cm all round, with no rock, log, tree or plant near. */
async function openGround(page: Page) {
  return page.evaluate(() => {
    const g = window.__game!;
    g.advance(2, false);
    const yaw = g.iguanas()[0].yaw;
    const { waterY } = g.ocean();
    const others = g.iguanas().slice(1);
    const obstacles = g.obstacles();
    let best: { x: number; z: number; yaw: number; room: number } | null = null;
    for (let z = -2.5; z < 3.5; z += 0.05) {
      for (const up of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]) {
        const x = g.shoreX(z) - up;
        const flat = [-0.15, 0, 0.15].every((s) =>
          [-0.15, 0, 0.15].every((t) => {
            const qx = x + s;
            const qz = z + t;
            return Math.abs(g.groundAt(qx, qz)! - g.terrainHeight(qx, qz)) < 0.003 && g.terrainHeight(qx, qz) > waterY + 0.01;
          }),
        );
        if (!flat || g.plants({ x, z, r: 0.3 }).length > 0 || others.some((o) => Math.hypot(o.x - x, o.z - z) < 0.4)) continue;
        const room = Math.min(...obstacles.map((o) => Math.hypot(o.x - x, o.z - z) - o.radius));
        if (!best || room > best.room) best = { x, z, yaw, room };
      }
    }
    if (!best || best.room < 0.18) throw new Error('no open ground by the shore');
    return best;
  });
}

test('the lizard walks over or past a basking iguana from any side without getting stuck on it', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await bootGame(page, { iguanas: true });
  const spot = await openGround(page);
  const runs = await page.evaluate((spot) => {
    const g = window.__game!;
    const out: { angle: number; off: number; along: number }[] = [];
    // Head on, across it at angles, and from behind; through its middle and either end.
    for (const angle of [0, 0.4, 0.8, Math.PI / 2, 2.2, 2.7, Math.PI]) {
      for (const off of [-0.04, 0, 0.04]) {
        g.iguanaPlace(0, spot.x, spot.z, spot.yaw);
        g.advance(3, false);
        const ig = g.iguanas()[0];
        const yaw = ig.yaw + angle;
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        const ix = Math.sin(ig.yaw);
        const iz = Math.cos(ig.yaw);
        g.teleport(ig.x - fx * 0.13 + ix * off, ig.z - fz * 0.13 + iz * off, yaw);
        g.advance(3, false);
        const s0 = g.player();
        g.setInput({ move: { x: 0, y: 1 } }, 240);
        g.advance(240, false);
        const p = g.player();
        out.push({ angle, off, along: (p.x - s0.x) * fx + (p.z - s0.z) * fz });
      }
    }
    return out;
  }, spot);
  // Over it (climbing onto its back and down the far side), or nudging it aside: in 4 s the lizard
  // is well past where the iguana lay, never left standing with its hips on the iguana's back. Pushing
  // it a little way first (at PUSH_SPEED) before climbing over takes a good part of that.
  for (const r of runs) expect(r.along, `from ${r.angle.toFixed(2)} rad, ${r.off} m along it`).toBeGreaterThan(0.22);
  expect(errors).toEqual([]);
});

test('walking into an iguana end-on pushes it slowly out of the way', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = await bootGame(page, { iguanas: true });
  const spot = await openGround(page);
  const run = await page.evaluate((spot) => {
    const g = window.__game!;
    g.iguanaPlace(0, spot.x, spot.z, spot.yaw);
    g.advance(3, false);
    const ig = g.iguanas()[0];
    // Behind it, in line, walking up to its tail and on into its hips: too long a back to climb onto lengthways.
    const yaw = ig.yaw;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    g.teleport(ig.x - fx * 0.17, ig.z - fz * 0.17, yaw);
    g.advance(3, false);
    g.setInput({ move: { x: 0, y: 1 } }, 120);
    g.advance(120, false);
    const after = g.iguanas()[0];
    return { moved: (after.x - ig.x) * fx + (after.z - ig.z) * fz, across: Math.abs((after.x - ig.x) * fz - (after.z - ig.z) * fx) };
  }, spot);
  // Pushed along ahead of the lizard, slower than it walks (2 s at 6 cm/s at most).
  expect(run.moved).toBeGreaterThan(0.01);
  expect(run.moved).toBeLessThan(0.13);
  expect(errors).toEqual([]);
});

test("an iguana passing close behind the lizard doesn't pull the camera in", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = await bootGame(page, { iguanas: true });
  const spot = await openGround(page);
  const run = await page.evaluate((spot) => {
    const g = window.__game!;
    g.iguanaPlace(0, spot.x, spot.z, spot.yaw);
    // The lizard lies 7 cm off the iguana's flank, facing away from it, so the camera's arm runs back over the iguana.
    const lx = Math.cos(spot.yaw);
    const lz = -Math.sin(spot.yaw);
    g.teleport(spot.x + lx * 0.07, spot.z + lz * 0.07, Math.atan2(lx, lz));
    let arm = Infinity;
    for (let k = 0; k < 60; k++) {
      g.advance(1, false);
      arm = Math.min(arm, g.camera().arm);
    }
    return { arm, distance: g.camera().distance };
  }, spot);
  expect(run.arm).toBeGreaterThan(run.distance - 0.01);
  expect(errors).toEqual([]);
});
