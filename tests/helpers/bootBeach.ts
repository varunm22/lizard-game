import type { Page } from '@playwright/test';

/**
 * Load the sea lion beach (`?level=beach&test`) without advancing time or drawing anything. The sea
 * lions and the rival males (and females) are held still unless a test asks for them, and so are
 * the vitals bars unless `vitals` (the bull's hit still takes health).
 */
export async function bootBeach(page: Page, { sealions = false, rivals = false, vitals = false } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?level=beach&test');
  await page.waitForFunction(() => window.__beach?.ready === true);
  await page.evaluate(
    ({ sealions, rivals, vitals }) => {
      window.__beach!.pause({ sealions: !sealions, rivals: !rivals });
      if (!vitals) window.__beach!.setVitals({ frozen: true });
    },
    { sealions, rivals, vitals },
  );
  return errors;
}
