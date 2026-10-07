import type { Page } from '@playwright/test';

/**
 * Draw the game as it is and save a screenshot for people to look at (tests never check pixels) to
 * test-results/screenshots/. Only with SCREENSHOTS=1 (`npm run screenshots`): on a software
 * renderer a page's first screenshot costs it 2 to 6 s, and a frame can take a quarter second to draw.
 */
export async function screenshot(page: Page, name: string) {
  if (!process.env.SCREENSHOTS) return;
  await page.evaluate(() => window.__game!.advance(0, true));
  await page.screenshot({ path: `test-results/screenshots/${name}` });
}
