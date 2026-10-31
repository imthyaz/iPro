import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic users and people from `pnpm db:seed`).
const DEV = {
  hr: '00000000-0000-4000-8000-000000000104',
  manager: '00000000-0000-4000-8000-000000000102',
  managerTwo: '00000000-0000-4000-8000-000000000103',
};

/** Desktop and mobile run in parallel, so each edits a different synthetic person. */
const kycSubject = (project: string) =>
  project === 'mobile'
    ? { name: /Chitra Synthetic/, manager: DEV.managerTwo }
    : { name: /Bala Synthetic/, manager: DEV.manager };

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

test('HR creates a person in one screen; the record opens with a code and a Joined event', async ({
  page,
}) => {
  const name = `Test Person ${Date.now()}`;
  await signInAs(page, DEV.hr);
  await page.goto('/people');
  await page.getByRole('link', { name: 'New person' }).click();

  await page.getByLabel('Legal name').fill(name);
  await page.getByLabel('Designation').selectOption({ label: 'Software Engineer' });
  await page.getByLabel('Department').selectOption({ label: 'Engineering' });
  await page.getByLabel('Location').selectOption({ label: 'Chennai office' });
  await page.getByLabel('Reports to').selectOption({ label: 'Dev Manager (IDS-0002)' });
  await page.getByLabel(/Annual CTC/).fill('9,00,000');
  await page.getByRole('button', { name: 'Create person' }).click();

  const record = page.getByRole('complementary', { name: 'Person record' });
  await expect(record.getByRole('heading', { name })).toBeVisible();
  await expect(record.getByText(/IDS-\d{4} · Software Engineer · Engineering/)).toBeVisible();
  await record.getByRole('tab', { name: 'Journey' }).click();
  await expect(record.getByText('Joined as Software Engineer')).toBeVisible();
  await record.getByRole('tab', { name: 'Pay' }).click();
  await expect(record.getByText('₹9,00,000 a year')).toBeVisible();
});

test('KYC is masked; HR unmasks with a logged action; a manager has no KYC tab', async ({
  page,
}, testInfo) => {
  const subject = kycSubject(testInfo.project.name);
  await signInAs(page, DEV.hr);
  await page.goto('/people');
  await page.getByRole('link', { name: subject.name }).click();
  const record = page.getByRole('complementary', { name: 'Person record' });
  await record.getByRole('tab', { name: 'KYC' }).click();
  await record.getByLabel('Type').selectOption('passport');
  const passportNumber = `Z${String(Date.now()).slice(-7)}`;
  await record.getByLabel('Number').fill(passportNumber);
  await record.getByRole('button', { name: 'Save' }).click();

  // Wait for the new value: an earlier run may have left another passport on screen.
  const passport = record.getByLabel('Passport, masked');
  await expect(passport).toHaveText(`••••${passportNumber.slice(-4)}`);
  await record.getByRole('button', { name: 'Show full Passport (logged)' }).click();
  await expect(record.getByLabel('Passport value')).toHaveText(passportNumber);

  await signInAs(page, subject.manager);
  await page.goto('/people');
  await page.getByRole('link', { name: subject.name }).click();
  const managerView = page.getByRole('complementary', { name: 'Person record' });
  await expect(managerView.getByRole('tab', { name: 'Profile' })).toBeVisible();
  await expect(managerView.getByRole('tab', { name: 'KYC' })).toHaveCount(0);
  await expect(managerView.getByRole('tab', { name: 'Pay' })).toHaveCount(0);
});

test('the org tree for a past date shows only who was there then', async ({ page }) => {
  await signInAs(page, DEV.hr);
  await page.goto('/org-tree');
  // Seed: Dev CXO and Dev HR Head joined 3 Apr 2023; Dev Manager on 1 Jun 2023.
  await page.getByLabel('As of').fill('2023-05-01');
  const tree = page.getByRole('list', { name: 'Reporting lines' });
  await expect(tree.getByText('Dev CXO')).toBeVisible();
  await expect(tree.getByText('Dev HR Head')).toBeVisible();
  await expect(tree.getByText('Dev Manager', { exact: true })).toHaveCount(0);
  await page.getByLabel('As of').fill('2023-06-01');
  await expect(tree.getByText('Dev Manager', { exact: true })).toBeVisible();
});
