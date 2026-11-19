import type { Page } from '@playwright/test';

/**
 * Load the mangrove lagoon (`?level=lagoon&test`) without advancing time or drawing anything. The
 * herons and the sharks and rays are held still unless a test asks for them (`true`, or for herons
 * the indices of the ones it uses), and so are the vitals bars unless `vitals` (strikes still take health).
 */
export async function bootLagoon(page: Page, { herons = false as boolean | number[], swimmers = false, vitals = false } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?level=lagoon&test');
  await page.waitForFunction(() => window.__lagoon?.ready === true);
  await page.evaluate(
    ({ herons, swimmers, vitals }) => {
      const held = herons === true ? false : herons === false ? true : herons;
      window.__lagoon!.pause({ herons: held, swimmers: !swimmers });
      if (!vitals) window.__lagoon!.setVitals({ frozen: true });
    },
    { herons, swimmers, vitals },
  );
  return errors;
}
