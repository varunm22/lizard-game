import { expect, test, type Page } from '@playwright/test';
import { bootGame } from './helpers/bootGame';
import { screenshot } from './helpers/screenshot';

/** Like traversal.spec.ts, every test drives time itself with `window.__game.advance`. */
const steps = (page: Page, n: number, draw = false) =>
  page.evaluate(([n, draw]) => window.__game!.advance(n as number, draw as boolean), [n, draw] as const);
const player = (page: Page) => page.evaluate(() => window.__game!.player());
/** Capsule centre to top: feet + skin + diameter. */
const BODY_TOP = 0.032;
/**
 * A line across the sandy beach, from 30 cm up the sand to 1.6 m out to sea, with no rock, tree or
 * log near it, and where that line meets the waterline.
 */
async function beachLane(page: Page) {
  return page.evaluate(() => {
    const g = window.__game!;
    const obstacles = g.obstacles();
    for (let z = 1.1; z < 2.2; z += 0.02) {
      for (const lane of [z, 2.2 - z]) {
        const shore = g.shoreX(lane);
        const clear = obstacles.every((o) => Math.abs(o.z - lane) > o.radius + 0.08 || o.x < shore - 0.35 || o.x > shore + 1.65);
        if (clear) return { ...g.ocean(), z: lane, shore };
      }
    }
    throw new Error('no clear lane across the beach');
  });
}

test('swimming: wades in until fully under, sinks, Space tilts it up, rocks still block it, swims out', async ({ page }) => {
  const errors = await bootGame(page);
  const sea = await beachLane(page);

  // Off the beach the sea floor shelves down to a couple of lizard lengths deep.
  const offshore = await page.evaluate(([x, z]) => window.__game!.terrainHeight(x, z), [sea.shore + 2, sea.z]);
  expect(sea.waterY - offshore).toBeGreaterThan(0.3);

  // Walk down the beach into the sea, heading east (+X), until the whole body is under.
  const entry = await page.evaluate(([shore, z]) => {
    const g = window.__game!;
    g.teleport(shore - 0.2, z, Math.PI / 2);
    g.setInput({ move: { x: 0, y: 1 } }, 400);
    let wadingDeepest = Infinity;
    for (let k = 0; k < 400 && !g.player().swimming; k++) {
      g.advance(1, false);
      if (!g.player().swimming) wadingDeepest = Math.min(wadingDeepest, g.player().y);
    }
    g.advance(60);
    g.setInput(null);
    return { wadingDeepest, p: g.player(), clip: g.lizard().current };
  }, [sea.shore, sea.z]);
  // It walked until the water closed over its back (give or take a step), not before.
  expect(entry.wadingDeepest + BODY_TOP).toBeGreaterThan(sea.waterY - 0.006);
  expect(entry.p.swimming).toBe(true);
  expect(entry.p.state).toBe('swim');
  expect(entry.clip).toBe('swim');
  expect(entry.p.y + BODY_TOP).toBeLessThan(sea.waterY);
  // Slowed from walking pace to swimming pace.
  expect(entry.p.speed).toBeLessThan(0.15);
  await screenshot(page, 'swim.png');

  // Mid-water with no input it sinks slowly, then A turns it on the spot.
  await page.evaluate(([x, z, y]) => window.__game!.teleport(x, z, Math.PI / 2, y), [sea.shore + 1.3, sea.z, sea.waterY - 0.06]);
  await steps(page, 2);
  const start = await player(page);
  await steps(page, 60);
  const sunk = await player(page);
  expect(sunk.swimming).toBe(true);
  expect(sunk.grounded).toBe(false);
  expect(start.y - sunk.y).toBeGreaterThan(0.035);
  expect(start.y - sunk.y).toBeLessThan(0.06);
  await page.evaluate(() => window.__game!.setInput({ move: { x: -1, y: 0 } }, 60));
  await steps(page, 60);
  const turned = await player(page);
  // A turns left: a quarter turn in a second, at 90°/s.
  const turn = Math.atan2(Math.sin(turned.yaw - sunk.yaw), Math.cos(turned.yaw - sunk.yaw));
  expect(Math.abs(turn)).toBeGreaterThan(1.3);
  expect(Math.hypot(turned.x - sunk.x, turned.z - sunk.z)).toBeLessThan(0.005);

  // A tap of Space eases the snout up for about half a second, rising, then it levels off and sinks.
  const tilt = await page.evaluate(() => {
    const g = window.__game!;
    const y0 = g.player().y;
    g.setInput({ jump: true }, 1);
    let pitch = 0;
    for (let i = 0; i < 40; i++) {
      g.advance(1, false);
      pitch = Math.max(pitch, g.player().swimPitch);
    }
    const risen = g.player().y - y0;
    g.advance(60, false);
    return { pitch, risen, after: g.player().swimPitch, still: g.player().swimming };
  });
  expect(tilt.pitch).toBeGreaterThan(0.35);
  expect(tilt.pitch).toBeLessThan(0.55);
  expect(tilt.risen).toBeGreaterThan(0.025);
  expect(tilt.after).toBeLessThan(0.05);
  expect(tilt.still).toBe(true);

  // Under water the rocks are still solid: sinking onto the sunk rock, it rests on top.
  const rock = await page.evaluate(() => window.__game!.obstacles().find((o) => o.name === 'rock-sunk')!);
  const rockTop = await page.evaluate(([x, z]) => window.__game!.terrainHeight(x, z), [rock.x, rock.z]) + rock.height;
  expect(rockTop + BODY_TOP).toBeLessThan(sea.waterY);
  await page.evaluate(([x, z, y]) => window.__game!.teleport(x, z, 0, y), [rock.x, rock.z, rockTop + 0.003]);
  await steps(page, 120);
  const resting = await player(page);
  expect(resting.swimming).toBe(true);
  expect(resting.y).toBeGreaterThan(rockTop - 0.004);
  await screenshot(page, 'swim-on-rock.png');

  // Swimming back west over the shelf, it comes out onto the beach and walks again.
  await page.evaluate(([x, z, y]) => window.__game!.teleport(x, z, -Math.PI / 2, y), [sea.shore + 0.9, sea.z, sea.waterY - 0.06]);
  await page.evaluate(() => {
    const g = window.__game!;
    g.setInput({ move: { x: 0, y: 1 } }, 600);
    for (let k = 0; k < 600 && (g.player().swimming || g.player().climbing || g.player().y < g.ocean().waterY); k++) g.advance(1, false);
    g.setInput(null);
    g.advance(30);
  });
  const out = await player(page);
  expect(out.swimming).toBe(false);
  expect(out.grounded).toBe(true);
  expect(out.y).toBeGreaterThan(sea.waterY);
  expect(errors).toEqual([]);
});

test('ripples: wading in rings the water gently, jumping in makes a bigger splash, surfacing rings it too', async ({ page }) => {
  const errors = await bootGame(page);
  const sea = await beachLane(page);
  /** Run up to `n` steps with `input`, returning the first new ripple and where the lizard was then. */
  const firstRipple = (input: object, n: number) =>
    page.evaluate(([input, n]) => {
      const g = window.__game!;
      g.setInput(input as object, n as number);
      for (let k = 0; k < (n as number); k++) {
        g.advance(1, false);
        const fresh = g.ripples().find((r) => r.age < 0.017);
        if (fresh) {
          g.setInput(null);
          return { ripple: fresh, p: g.player() };
        }
      }
      return null;
    }, [input, n] as const);

  // Walking down the beach: a gentle ring where its feet meet the water.
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, Math.PI / 2), [sea.shore - 0.2, sea.z]);
  const wade = await firstRipple({ move: { x: 0, y: 1 } }, 300);
  expect(wade).not.toBeNull();
  expect(wade!.ripple.strength).toBeLessThan(0.6);
  expect(Math.hypot(wade!.ripple.x - wade!.p.x, wade!.ripple.z - wade!.p.z)).toBeLessThan(0.02);

  // Running and jumping off the shore: a much bigger ring.
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, Math.PI / 2), [sea.shore - 0.25, sea.z]);
  await page.evaluate(() => window.__game!.advance(10, false));
  await page.evaluate(() => window.__game!.setInput({ move: { x: 0, y: 1 }, run: true }, 25));
  await page.evaluate(() => window.__game!.advance(25, false));
  const splash = await firstRipple({ move: { x: 0, y: 1 }, run: true, jump: true }, 60);
  expect(splash).not.toBeNull();
  expect(splash!.ripple.strength).toBeGreaterThan(wade!.ripple.strength + 0.4);
  await page.evaluate(() => window.__game!.advance(20));
  await screenshot(page, 'ripple-splash.png');

  // Rising from under water with Space, its back reaching the surface rings it (once the splash
  // is a couple of seconds old: gentle ripples are kept sparse).
  await page.evaluate(() => window.__game!.advance(90, false));
  await page.evaluate(([x, z, y]) => window.__game!.teleport(x, z, Math.PI / 2, y), [sea.shore + 1.3, sea.z, sea.waterY - 0.05]);
  await page.evaluate(() => window.__game!.advance(10, false));
  const surfacing = await firstRipple({ jump: true }, 60);
  expect(surfacing).not.toBeNull();
  expect(surfacing!.p.swimming).toBe(true);
  expect(surfacing!.ripple.strength).toBeGreaterThan(0.3);
  expect(errors).toEqual([]);
});

test('swimming: climbs out of the sea onto a domed rock without falling back in', async ({ page }) => {
  const errors = await bootGame(page);

  // Swim at the rock island from every side, holding W and tapping Space to keep near the surface.
  // Its crown is a dome with no flat spot right past the rim, which used to refuse the climb: the
  // lizard surfaced against the face, stood up, and fell straight back in.
  const runs = await page.evaluate(() => {
    const g = window.__game!;
    const w = g.ocean().waterY;
    const rock = g.obstacles().find((o) => o.name === 'rock-island')!;
    const runs: { side: number; backIn: number; swimming: boolean; onTop: boolean }[] = [];
    for (let side = 0; side < 8; side++) {
      const a = (side / 8) * Math.PI * 2;
      const x = rock.x + Math.sin(a) * (rock.radius + 0.12);
      const z = rock.z + Math.cos(a) * (rock.radius + 0.12);
      if ((g.groundAt(x, z) ?? -Infinity) > w - 0.06) continue;
      g.teleport(x, z, a + Math.PI, w - 0.04);
      g.advance(5, false);
      let backIn = 0;
      let wasOut = false;
      for (let k = 0; k < 400; k++) {
        g.setInput({ move: { x: 0, y: 1 }, jump: k % 40 < 20 }, 1);
        g.advance(1, false);
        const p = g.player();
        if (wasOut && p.swimming) backIn++;
        wasOut = !p.swimming && !p.climbing;
        if (wasOut && p.grounded && Math.hypot(p.x - rock.x, p.z - rock.z) < rock.radius * 0.6) break;
      }
      g.setInput(null);
      g.advance(60, false);
      const p = g.player();
      runs.push({ side, backIn, swimming: p.swimming, onTop: p.y > w && Math.hypot(p.x - rock.x, p.z - rock.z) < rock.radius });
    }
    return runs;
  });
  expect(runs.length).toBeGreaterThan(4);
  for (const r of runs) expect(r).toEqual({ side: r.side, backIn: 0, swimming: false, onTop: true });
  await page.evaluate(() => window.__game!.advance(1));
  await screenshot(page, 'swim-climb-out.png');
  expect(errors).toEqual([]);
});
