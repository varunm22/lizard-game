import { expect, test } from '@playwright/test';
import { bootGame } from './helpers/bootGame';

// What a frame costs to draw, counted rather than timed: on a phone or a laptop's integrated GPU,
// draw calls and triangles are what the frame rate comes down to. The budgets leave about 10% over
// what the spawn view draws now; raise one only knowing what a change added.
const MAX_CALLS = 400;
const MAX_TRIANGLES = 1_350_000;

test('the spawn view stays within its draw budget, and each creature is one mesh', async ({ page }) => {
  const errors = await bootGame(page, { iguanas: true, crabs: true });
  const stats = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(30);
    return g.renderStats();
  });
  expect(stats.calls).toBeLessThan(MAX_CALLS);
  expect(stats.triangles).toBeLessThan(MAX_TRIANGLES);
  // The lizard, 3 iguanas, 18 crabs, the tortoise and the hawk.
  expect(stats.skinned).toBe(24);
  expect(errors).toEqual([]);
});

test('a render style with outlines and dither draws with one extra call, and classic is restored', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  const errors = await bootGame(page);
  const stats = await page.evaluate(() => {
    const g = window.__game!;
    g.advance(5);
    const classic = g.renderStats();
    g.style('retro');
    const retro = g.renderStats();
    return { classic: classic.calls, retro: retro.calls, back: g.style('classic') };
  });
  expect(stats.retro).toBe(stats.classic + 1);
  expect(stats.back).toBe('classic');
  expect([...errors, ...consoleErrors]).toEqual([]);
});
