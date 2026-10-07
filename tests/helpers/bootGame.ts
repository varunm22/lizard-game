import type { Page } from '@playwright/test';

/**
 * Load the game without advancing simulation time or drawing anything (`?test`). The hawk, the
 * other iguanas and the crabs are off unless a test asks for them: each iguana costs about as much
 * as the player, and the crabs as much again. `iguanas` is true for all three, or which of them.
 * The vitals bars are held too unless `vitals` asks for them to drift, so a long swim can't drown or
 * chill the lizard.
 */
export async function bootGame(page: Page, { hawk = false, iguanas = false as boolean | number[], crabs = false, vitals = false } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?test');
  await page.waitForFunction(() => window.__game?.ready === true);
  await page.evaluate(
    ({ hawk, iguanas, crabs, vitals }) => {
      const g = window.__game!;
      if (!hawk) g.hawkDo('off');
      if (!vitals) g.setVitals({ frozen: true });
      const still = g.iguanas().map((_, i) => i).filter((i) => iguanas !== true && !(iguanas || []).includes(i));
      g.pause({ iguanas: still, crabs: !crabs });
    },
    { hawk, iguanas, crabs, vitals },
  );
  return errors;
}
