import type { Page } from '@playwright/test';

/**
 * Load the game without advancing simulation time or drawing anything (`?test`). The hawk, the other iguanas and the crabs are
 * off unless a test asks for them: the iguanas and crabs cost most of each simulated step.
 */
export async function bootGame(page: Page, { hawk = false, iguanas = false, crabs = false } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?test');
  await page.waitForFunction(() => window.__game?.ready === true);
  await page.evaluate(
    ({ hawk, paused }) => {
      if (!hawk) window.__game!.hawkDo('off');
      window.__game!.pause(paused);
    },
    { hawk, paused: [...(iguanas ? [] : ['iguanas' as const]), ...(crabs ? [] : ['crabs' as const])] },
  );
  return errors;
}
