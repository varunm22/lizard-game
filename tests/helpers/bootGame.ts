import type { Page } from '@playwright/test';

/** Load the game without advancing simulation time; hawk scenarios opt into hunting. */
export async function bootGame(page: Page, { hawk = false } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => window.__game?.ready === true);
  if (!hawk) await page.evaluate(() => window.__game!.hawkDo('off'));
  return errors;
}
