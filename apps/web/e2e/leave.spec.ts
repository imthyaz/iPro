import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic people). Dev Employee is IDS-0006.
const DEV = {
  employee: '00000000-0000-4000-8000-000000000101',
  managerTwo: '00000000-0000-4000-8000-000000000103',
  hr: '00000000-0000-4000-8000-000000000104',
  admin: '00000000-0000-4000-8000-000000000107',
};

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

test('HR imports balances at cut-over; the employee sees them and why on My leave', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'the import is a desktop task on shared data');
  await signInAs(page, DEV.hr);
  await page.goto('/leave-import');
  await page
    .getByLabel('Or paste the CSV')
    .fill(
      [
        'employee_code,leave_type,balance',
        'IDS-0006,CL,4.5',
        'IDS-0006,EL,7',
        'IDS-9999,CL,1',
      ].join('\n'),
    );
  await page.getByRole('button', { name: 'Check' }).click();
  const errors = page.getByRole('list', { name: 'Import errors' });
  await expect(errors).toContainText('No current employee IDS-9999');
  await expect(page.getByRole('button', { name: /^Apply/ })).toBeDisabled();

  await page
    .getByLabel('Or paste the CSV')
    .fill(['employee_code,leave_type,balance', 'IDS-0006,CL,4.5', 'IDS-0006,EL,7'].join('\n'));
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByRole('list', { name: 'Balance changes' })).toContainText('0 → 4.5');
  await page.getByRole('button', { name: 'Apply 2 changes' }).click();
  await expect(page.getByText('Applied 2 changes.')).toBeVisible();

  await signInAs(page, DEV.employee);
  await page.goto('/leave');
  const casual = page.getByRole('button', { name: 'Casual leave: 4.5 days left' });
  await expect(casual).toBeVisible();
  await expect(page.getByRole('button', { name: 'Earned leave: 7 days left' })).toBeVisible();
  await casual.click();
  const detail = page.getByRole('complementary', { name: 'Leave balance' });
  await expect(detail.getByText(/Imported balance as of/)).toBeVisible();
  await expect(detail.getByLabel('How the balance is reached')).toContainText('= 4.5');
});

test('My leave shows each balance on a phone; leave types are listed for HR', async ({ page }) => {
  await signInAs(page, DEV.managerTwo);
  await page.goto('/leave');
  const sick = page.getByRole('button', { name: /^Sick leave: / });
  await expect(sick).toBeVisible();
  await sick.click();
  await expect(
    page
      .getByRole('complementary', { name: 'Leave balance' })
      .getByRole('heading', { name: 'Sick leave' }),
  ).toBeVisible();

  await signInAs(page, DEV.hr);
  await page.goto('/leave-types');
  await page.getByRole('link', { name: /Earned leave/ }).click();
  const type = page.getByRole('complementary', { name: 'Leave type' });
  await expect(type.getByLabel('Days a year')).toHaveValue('15');
  await expect(type.getByLabel('Carry forward up to')).toHaveValue('30');
  await expect(type.getByLabel('Maximum balance')).toHaveValue('30');
  await expect(type.getByLabel('Credited')).toHaveValue('month_end');
  // HR reads leave types; admins and HR head edit them.
  await expect(type.getByRole('button', { name: 'Save' })).toHaveCount(0);
});
