import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic users, and the dev Chennai holiday calendar).
const DEV = { admin: '00000000-0000-4000-8000-000000000107' };

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

test('an admin adds a holiday to the Chennai calendar for next year, then removes it', async ({
  page,
}, testInfo) => {
  const nextYear = new Date().getFullYear() + 1;
  // Desktop and mobile run at once: each uses its own date and name.
  const date = `${nextYear}-03-${testInfo.project.name === 'mobile' ? '17' : '16'}`;
  const name = `Company day ${testInfo.project.name}`;
  await signInAs(page, DEV.admin);
  await page.goto('/holidays');
  await page.getByLabel('Year').selectOption(String(nextYear));
  await page.getByRole('link', { name: /Chennai/ }).click();

  const detail = page.getByRole('complementary', { name: 'Holiday calendar' });
  await detail.getByLabel('Date').fill(date);
  await detail.getByLabel('Holiday', { exact: true }).fill(name);
  await detail.getByRole('button', { name: 'Add holiday' }).click();
  const row = detail.getByRole('listitem').filter({ hasText: name });
  await expect(row).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(row).toHaveCount(0);
});
