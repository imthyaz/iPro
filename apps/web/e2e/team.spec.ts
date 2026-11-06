import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic people). Dev Manager has the seeded team.
const MANAGER = '00000000-0000-4000-8000-000000000102';

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

test('a manager sees where the team is today on their phone', async ({ page }) => {
  await signInAs(page, MANAGER);
  await page.goto('/');
  await page.getByRole('link', { name: 'Team today' }).click();
  await expect(page.getByRole('heading', { name: 'Team today', level: 1 })).toBeVisible();
  const totals = page.getByLabel('Team today totals');
  await expect(totals).toBeVisible();
  // Every person is in exactly one group, and the totals add up to the rows shown.
  const counts = await totals.locator('.chip').allTextContents();
  const total = counts.reduce((sum, c) => sum + Number(c.split(' ')[0]), 0);
  await expect(page.locator('main ul.rows > li')).toHaveCount(total);
});

test('a manager reads the team calendar and the compliance report', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'M4 is a desktop screen');
  await signInAs(page, MANAGER);
  await page.goto('/team-calendar');
  const calendar = page.getByRole('table');
  await expect(calendar.getByRole('columnheader', { name: 'Person' })).toBeVisible();
  await expect(calendar.getByRole('rowheader').first()).toBeVisible();
  // The month scrolls inside its box; the page itself doesn't scroll sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);

  await page.goto('/hybrid-compliance');
  await expect(page.getByRole('heading', { name: 'Hybrid compliance' })).toBeVisible();
  await expect(page.getByText(/an office day counts 1, a half day/)).toBeVisible();
});
