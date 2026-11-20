import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic people). H12 is a desktop screen for HR and CXO.
const DEV = {
  manager: '00000000-0000-4000-8000-000000000102',
  hrHead: '00000000-0000-4000-8000-000000000105',
};

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

test('HR head reads the Phase 1 reports, each with how it is worked out', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'H12 is a desktop screen');
  await signInAs(page, DEV.hrHead);
  await page.goto('/');
  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const headcount = (await (
    await page.request.get(`/api/reports/headcount?asOf=${today}`)
  ).json()) as { total: number };
  await expect(page.locator('.report-tile').first()).toContainText(String(headcount.total));
  await expect(page.getByRole('region', { name: 'By department' })).toBeVisible();

  const tabs = page.getByRole('tablist', { name: 'Report' });
  await tabs.getByRole('tab', { name: 'Attrition' }).click();
  await expect(page.locator('.report-tile').first()).toContainText('%');
  await expect(page.locator('.report-why').first()).toContainText('average month-end headcount');

  await tabs.getByRole('tab', { name: 'Leave liability' }).click();
  await expect(page.locator('.report-tile').first()).toContainText('days');

  await tabs.getByRole('tab', { name: 'Seat occupancy' }).click();
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
});

test('a manager has no Reports page', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'H12 is a desktop screen');
  await signInAs(page, DEV.manager);
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Reports' })).toHaveCount(0);
  expect((await page.request.get('/api/reports/headcount?asOf=2026-01-01')).status()).toBe(403);
});
