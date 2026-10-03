import { expect, test, type Page } from '@playwright/test';

/** Like traversal.spec.ts, every test drives time itself with `window.__game.advance`. */
const steps = (page: Page, n: number, draw = true) =>
  page.evaluate(([n, draw]) => window.__game!.advance(n as number, draw as boolean), [n, draw] as const);
const player = (page: Page) => page.evaluate(() => window.__game!.player());
/** Capsule centre to top: feet + skin + diameter. */
const BODY_TOP = 0.032;

test('swimming: wades in until fully under, sinks, Space tilts it up, rocks still block it, swims out', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true);
  const pond = await page.evaluate(() => window.__game!.pond());

  // Walk in from the east shore, heading west (-X), until the whole body is under.
  const entry = await page.evaluate(([px, pz]) => {
    const g = window.__game!;
    g.teleport(px + 0.5, pz + 0.1, -Math.PI / 2);
    g.setInput({ move: { x: 0, y: 1 } }, 300);
    let wadingDeepest = Infinity;
    for (let k = 0; k < 300 && !g.player().swimming; k++) {
      g.advance(1, false);
      if (!g.player().swimming) wadingDeepest = Math.min(wadingDeepest, g.player().y);
    }
    g.advance(60);
    g.setInput(null);
    return { wadingDeepest, p: g.player(), clip: g.lizard().current };
  }, [pond.x, pond.z]);
  // It walked until the water closed over its back (give or take a step), not before.
  expect(entry.wadingDeepest + BODY_TOP).toBeGreaterThan(pond.waterY - 0.006);
  expect(entry.p.swimming).toBe(true);
  expect(entry.p.state).toBe('swim');
  expect(entry.clip).toBe('swim');
  expect(entry.p.y + BODY_TOP).toBeLessThan(pond.waterY);
  // Slowed from walking pace to swimming pace.
  expect(entry.p.speed).toBeLessThan(0.15);
  await page.screenshot({ path: 'test-results/screenshots/swim.png' });

  // Mid-water with no input it sinks slowly, then A turns it on the spot.
  await page.evaluate(([px, pz, y]) => window.__game!.teleport(px - 0.08, pz - 0.1, Math.PI / 2, y), [pond.x, pond.z, pond.waterY - 0.045]);
  await steps(page, 2);
  const start = await player(page);
  await steps(page, 60);
  const sunk = await player(page);
  expect(sunk.swimming).toBe(true);
  expect(sunk.grounded).toBe(false);
  expect(start.y - sunk.y).toBeGreaterThan(0.01);
  expect(start.y - sunk.y).toBeLessThan(0.03);
  await page.evaluate(() => window.__game!.setInput({ move: { x: -1, y: 0 } }, 60));
  await steps(page, 60);
  const turned = await player(page);
  // A turns left: a quarter turn in a second, at 90°/s.
  const turn = Math.atan2(Math.sin(turned.yaw - sunk.yaw), Math.cos(turned.yaw - sunk.yaw));
  expect(Math.abs(turn)).toBeGreaterThan(1.3);
  expect(Math.hypot(turned.x - sunk.x, turned.z - sunk.z)).toBeLessThan(0.005);

  // A tap of Space tilts the snout up for about a second, rising, then it levels off and sinks.
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
  expect(tilt.pitch).toBeGreaterThan(0.45);
  expect(tilt.risen).toBeGreaterThan(0.025);
  expect(tilt.after).toBeLessThan(0.05);
  expect(tilt.still).toBe(true);

  // Under water the rocks are still solid: sinking onto the sunk rock, it rests on top.
  const rock = await page.evaluate(() => window.__game!.obstacles().find((o) => o.name === 'rock-sunk')!);
  const rockTop = await page.evaluate(([x, z]) => window.__game!.terrainHeight(x, z), [rock.x, rock.z]) + rock.height;
  expect(rockTop + BODY_TOP).toBeLessThan(pond.waterY);
  await page.evaluate(([x, z, y]) => window.__game!.teleport(x, z, 0, y), [rock.x, rock.z, rockTop + 0.003]);
  await steps(page, 120);
  const resting = await player(page);
  expect(resting.swimming).toBe(true);
  expect(resting.y).toBeGreaterThan(rockTop - 0.004);
  await page.screenshot({ path: 'test-results/screenshots/swim-on-rock.png' });

  // Swimming east up the bed, it comes out onto the shore and walks again.
  await page.evaluate(([px, pz, y]) => window.__game!.teleport(px + 0.1, pz + 0.1, Math.PI / 2, y), [pond.x, pond.z, pond.waterY - 0.05]);
  await page.evaluate(() => {
    const g = window.__game!;
    g.setInput({ move: { x: 0, y: 1 } }, 300);
    for (let k = 0; k < 300 && (g.player().swimming || g.player().climbing || g.player().y < g.pond().waterY); k++) g.advance(1, false);
    g.setInput(null);
    g.advance(30);
  });
  const out = await player(page);
  expect(out.swimming).toBe(false);
  expect(out.grounded).toBe(true);
  expect(out.y).toBeGreaterThan(pond.waterY);
  expect(errors).toEqual([]);
});
