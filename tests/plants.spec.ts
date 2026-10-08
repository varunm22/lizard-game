import { expect, test } from '@playwright/test';
import { bootGame } from './helpers/bootGame';
import { screenshot } from './helpers/screenshot';

test('big plants\' stems block the lizard and lean a little, small plants are walked through, thick plants slow it, and they creep back upright', async ({ page }) => {
  const errors = await bootGame(page);

  const plants = await page.evaluate(() => window.__game!.plants());
  const kinds = new Set(plants.map((p) => p.kind));
  expect([...kinds].sort()).toEqual(['cotton', 'fern', 'grass', 'ipomoea', 'lecocarpus', 'sesuvium', 'tiquilia', 'tomato']);
  for (const p of plants) expect(p.solid).toBe(['cotton', 'fern', 'lecocarpus', 'tomato'].includes(p.kind));
  // Plants stand on the ground and never grow out of the sea.
  const { waterY } = await page.evaluate(() => window.__game!.ocean());
  for (const p of plants) expect(p.y).toBeGreaterThan(waterY);

  // The cotton in the first patch, between the spawn and the log. Walk straight at it from two body
  // lengths away (the lizard travels -Z facing yaw pi): its stem stops the lizard, leaning a little.
  const cotton = plants.find((p) => p.kind === 'cotton' && Math.hypot(p.x - 0.16, p.z + 0.22) < 0.01)!;
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, Math.PI), [cotton.x, cotton.z + 0.3]);
  await page.evaluate(() => window.__game!.advance(20, false));

  const walk = await page.evaluate((cotton) => {
    const g = window.__game!;
    const lean = () => {
      const p = g.plants({ x: cotton.x, z: cotton.z, r: 1e-6 })[0];
      return { x: p.tiltX, z: p.tiltZ, size: Math.hypot(p.tiltX, p.tiltZ) };
    };
    g.setInput({ move: { x: 0, y: 1 } }, 150);
    let maxLean = 0;
    let settled = g.player();
    for (let k = 0; k < 150; k++) {
      g.advance(1, false);
      maxLean = Math.max(maxLean, lean().size);
      if (k === 119) settled = g.player();
    }
    const stopped = g.player();
    // Pressed against a stem the controller jitters a little from step to step, so judge "stopped"
    // by how far it got over the last half second rather than one step's speed.
    const creep = Math.hypot(stopped.x - settled.x, stopped.z - settled.z) / 0.5;
    // Back off, then watch it come back upright: lean along the way it was left leaning, each step.
    g.setInput({ move: { x: 0, y: -1 } }, 20);
    g.advance(20, false);
    const left = lean();
    const after: number[] = [];
    for (let i = 0; i < 240; i++) {
      g.advance(1, false);
      const l = lean();
      after.push((l.x * left.x + l.z * left.z) / left.size);
    }
    return { stoppedZ: stopped.z, stoppedSpeed: creep, maxLean, released: left.size, after };
  }, cotton);

  // Held up by the stem: the capsule's nose (6 cm ahead of the feet, plus the controller's skin)
  // stops just short of it.
  expect(walk.stoppedZ - cotton.z).toBeGreaterThan(0.06);
  expect(walk.stoppedZ - cotton.z).toBeLessThan(0.08);
  expect(walk.stoppedSpeed).toBeLessThan(0.02);
  // The snout pushing on it leans it a little, not flat.
  expect(walk.maxLean).toBeGreaterThan(0.1);
  expect(walk.maxLean).toBeLessThan(0.45);
  // Released, it creeps back: still most of the way over a quarter second later, upright after
  // four seconds, and never swings past upright.
  expect(walk.after[14]).toBeGreaterThan(walk.released * 0.5);
  expect(Math.min(...walk.after)).toBeGreaterThan(-0.01);
  expect(Math.abs(walk.after.at(-1)!)).toBeLessThan(0.01);

  // Small plants have no solid stem: a straight lane through the thickest grass in the clearing,
  // right over the middle of the tufts on it, clear only of the big plants' stems (the body needs
  // 2 cm each side of its line).
  const lane = await page.evaluate(() => {
    const ps = window.__game!.plants();
    const grass = ps.filter((p) => p.kind === 'grass' && Math.hypot(p.x, p.z) < 2);
    let best = { x: 0, z: 0, n: -1, onLine: [] as { x: number; z: number }[] };
    for (const p of grass) {
      const z = p.z;
      const blocked = ps.some((q) => q.solid && q.x > p.x - 0.35 && q.x < p.x + 0.2 && Math.abs(q.z - z) < 0.024);
      const onLine = grass.filter((q) => q.x > p.x - 0.1 && q.x < p.x + 0.1 && Math.abs(q.z - z) < 0.006);
      const n = grass.filter((q) => Math.hypot(q.x - p.x, q.z - z) < 0.1).length + 3 * onLine.length;
      if (!blocked && n > best.n) best = { x: p.x, z, n, onLine };
    }
    return best;
  });
  expect(lane.onLine.length).toBeGreaterThan(1);
  // Walk along it toward +X (yaw pi/2), starting in the open.
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, Math.PI / 2), [lane.x - 0.3, lane.z]);
  const speeds = await page.evaluate((lane) => {
    const g = window.__game!;
    g.advance(20, false);
    g.setInput({ move: { x: 0, y: 1 } }, 1000);
    g.advance(15, false);
    const open = g.player().speed;
    let inPatch = Infinity;
    let pressed = 0;
    for (let k = 0; k < 600 && g.player().x < lane.x + 0.15; k++) {
      g.advance(1, false);
      if (Math.abs(g.player().x - lane.x) < 0.03) inPatch = Math.min(inPatch, g.player().speed);
      for (const t of lane.onLine) {
        const p = g.plants({ x: t.x, z: t.z, r: 1e-6 })[0];
        pressed = Math.max(pressed, Math.hypot(p.tiltX, p.tiltZ));
      }
    }
    const through = g.player().x >= lane.x + 0.15;
    const offLine = Math.abs(g.player().z - lane.z);
    g.setInput(null);
    return { open, inPatch, through, offLine, pressed };
  }, lane);
  expect(speeds.open).toBeGreaterThan(0.24); // full walking speed in the open
  expect(speeds.inPatch).toBeLessThan(speeds.open * 0.85);
  expect(speeds.through).toBe(true); // slowed, but not stopped
  expect(speeds.offLine).toBeLessThan(0.01); // straight over the tufts, not round them
  expect(speeds.pressed).toBeGreaterThan(0.6); // pressed down under the body

  // From the side, walking back at the cotton from the other side: stopped at its stem.
  await page.evaluate(([x, z]) => window.__game!.teleport(x, z, 0), [cotton.x, cotton.z - 0.1]);
  await page.evaluate(() => {
    const g = window.__game!;
    g.setInput({ move: { x: 0, y: 1 } }, 30);
    g.viewFrom({ x: 0.25, y: 0.07, z: 0 });
    g.advance(30);
  });
  await screenshot(page, 'plants-push.png');
  expect(errors).toEqual([]);
});
