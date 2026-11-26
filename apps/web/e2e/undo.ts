import { expect, test, type Page } from '@playwright/test';

/** Approvals wait out a 10-second undo window before they are sent (decision #86). */
export const UNDO_MS = 10_000;

/**
 * Puts the page on a clock the test can move, for every test in the file. Time still flows normally;
 * `sendPendingApprovals` only jumps it forward past the undo window instead of waiting 10 real
 * seconds, which pushed busy runs past their time limit.
 */
export function installTestClock(): void {
  test.beforeEach(async ({ page }) => {
    await page.clock.install();
  });
}

/** Jumps past the undo window, then waits until every pending approval has been sent. */
export async function sendPendingApprovals(page: Page): Promise<void> {
  await page.clock.fastForward(UNDO_MS);
  await expect(page.getByText(/· sending/)).toHaveCount(0);
}
