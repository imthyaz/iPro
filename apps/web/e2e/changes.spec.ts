import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic users and people from `pnpm db:seed`).
const DEV = {
  hr: '00000000-0000-4000-8000-000000000104',
  hrHead: '00000000-0000-4000-8000-000000000105',
};

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

/** The first day of next month, in India. */
function nextMonth(): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const [y, m] = today.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** Desktop and mobile run in parallel, so each changes a different synthetic person. */
const subject = (project: string) => (project === 'mobile' ? 'Chitra Synthetic' : 'Bala Synthetic');

test('HR asks for a promotion from next month; HR head approves on the card; it shows as upcoming', async ({
  page,
}, testInfo) => {
  const name = subject(testInfo.project.name);
  const reason = `Promotion ${testInfo.project.name}`;

  await signInAs(page, DEV.hr);
  await page.goto('/people');
  await page.getByLabel('Search').fill(name);
  await page.getByRole('link', { name: new RegExp(name) }).click();
  const record = page.getByRole('complementary', { name: 'Person record' });
  await record.getByRole('tab', { name: 'Role history' }).click();
  await record.getByRole('button', { name: 'Change role…' }).click();
  await record.getByLabel('Effective from').fill(nextMonth());
  await record.getByLabel('Reason').fill(reason);
  await record.getByLabel('Designation').selectOption({ label: 'Senior Software Engineer' });
  await record.getByRole('button', { name: 'Send for approval' }).click();
  await expect(record.getByText('Sent to HR head for approval.')).toBeVisible();

  await signInAs(page, DEV.hrHead);
  await page.goto('/');
  const card = page
    .getByRole('list', { name: 'Approvals' })
    .getByRole('listitem')
    .filter({ hasText: reason });
  await expect(card.getByText('Senior Software Engineer')).toBeVisible();
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0);

  await page.goto('/people');
  await page.getByLabel('Search').fill(name);
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await record.getByRole('tab', { name: 'Journey' }).click();
  const event = record.getByRole('listitem').filter({ hasText: reason });
  await expect(event.getByText('Upcoming')).toBeVisible();
});
