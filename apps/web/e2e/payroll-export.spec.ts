import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic people). H9 screens are desktop tasks for HR.
const HR = '00000000-0000-4000-8000-000000000104';

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

test('HR checks last month, sees why for a person, and downloads the payroll CSV', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'H9 is a desktop screen');
  await signInAs(page, HR);
  await page.goto('/');
  await page.getByRole('link', { name: 'Payroll export' }).click();
  await expect(page.getByRole('heading', { name: 'Payroll export' })).toBeVisible();
  await expect(page.getByLabel('Month totals')).toContainText('people');

  const rows = page.getByRole('list', { name: 'Payroll rows' }).getByRole('button');
  await expect(rows.first()).toBeVisible();
  await rows.first().click();
  const detail = page.getByRole('complementary', { name: 'Payroll row' });
  await expect(detail.getByLabel('How the payable days are reached')).toContainText(
    'days employed −',
  );

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^attendance-\d{4}-\d{2}\.csv$/);
  await expect(page.getByLabel('Month totals')).toContainText('last downloaded');
});

test('HR opens a person’s leave balances and sees how each is reached', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'H9 is a desktop screen');
  await signInAs(page, HR);
  await page.goto('/leave-balances');
  const people = page.getByRole('list', { name: "People's leave balances" }).getByRole('button');
  await expect(people.first()).toBeVisible();
  await people.first().click();
  const detail = page.getByRole('complementary', { name: 'Leave balance' });
  await expect(detail.getByLabel('How the balance is reached')).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Adjust this balance' })).toBeVisible();
});
