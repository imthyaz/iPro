import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic people). Team journeys is a desktop screen.
const DEV = {
  manager: '00000000-0000-4000-8000-000000000102',
  hrHead: '00000000-0000-4000-8000-000000000105',
};

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

test('a manager sees their team side by side, grouped, with details on focus', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'M6 is a desktop screen');
  await signInAs(page, DEV.manager);
  await page.goto('/');
  await page.getByRole('link', { name: 'Team journeys' }).click();
  await expect(page.getByRole('heading', { name: 'Team journeys' })).toBeVisible();
  await expect(page.getByLabel('Summary')).toContainText('Active headcount');
  // Grouped by reportees for a manager.
  await expect(page.getByRole('button', { name: /^Reports to / }).first()).toBeVisible();
  const marker = page.locator('.team-dot').first();
  await marker.focus();
  await expect(page.getByRole('tooltip')).toBeVisible();

  await page.getByRole('radiogroup', { name: 'Group by' }).getByText('Department').click();
  await expect(page.getByRole('button', { name: /^Engineering/ })).toBeVisible();
  // The page never scrolls sideways; the grid does, inside its box.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test('HR head sees everyone and can narrow the range', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'H11 is a desktop screen');
  await signInAs(page, DEV.hrHead);
  await page.goto('/team-journeys');
  await expect(page.getByLabel('Show', { exact: true })).toHaveValue('all');
  await expect(page.locator('.team-row').first()).toBeVisible();
  const before = await page.locator('.team-row').count();
  expect(before).toBeGreaterThan(5);
  await page.getByRole('radiogroup', { name: 'Range' }).getByText('Last 12 mo + next 6 mo').click();
  await expect(page.getByLabel('Summary')).toContainText('Joiners');
});
