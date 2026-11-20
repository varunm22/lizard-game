import type { Page } from '@playwright/test';

/**
 * Load the lava tunnels (`?level=tunnels&test`) without advancing time or drawing anything. The
 * vitals bars are held unless `vitals` asks for them to drift (strikes and catches still happen).
 */
export async function bootTunnels(page: Page, { vitals = false } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?level=tunnels&test');
  await page.waitForFunction(() => window.__tunnels?.ready === true);
  if (!vitals) await page.evaluate(() => window.__tunnels!.setVitals({ frozen: true }));
  return errors;
}
