import type { Page } from '@playwright/test';

/** Load the lava tunnels (`?level=tunnels&test`) without advancing time or drawing anything. */
export async function bootTunnels(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?level=tunnels&test');
  await page.waitForFunction(() => window.__tunnels?.ready === true);
  return errors;
}
