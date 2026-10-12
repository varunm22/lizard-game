import type { Page } from '@playwright/test';

/**
 * Load the nesting dunes (`?level=dunes&test`) without advancing time or drawing anything. The racer
 * snakes and the other hatchlings are held still unless a test asks for them (`true`, or the indices
 * of the ones it uses): each hatchling costs about as much as the player.
 */
export async function bootDunes(page: Page, { racers = false as boolean | number[], hatchlings = false as boolean | number[] } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?level=dunes&test');
  await page.waitForFunction(() => window.__dunes?.ready === true);
  await page.evaluate(
    ({ racers, hatchlings }) => {
      const g = window.__dunes!;
      const held = (sel: boolean | number[]) => (sel === true ? false : sel === false ? true : sel);
      g.pause({ racers: held(racers), hatchlings: held(hatchlings) });
    },
    { racers, hatchlings },
  );
  return errors;
}
