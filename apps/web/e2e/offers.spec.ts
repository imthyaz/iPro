import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic users and people from `pnpm db:seed`).
const DEV = {
  manager: '00000000-0000-4000-8000-000000000102',
  hr: '00000000-0000-4000-8000-000000000104',
  admin: '00000000-0000-4000-8000-000000000107',
};

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

const inDays = (days: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + days * 86_400_000),
  );
const shortDate = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`));

test('HR makes an offer on one screen; the hiring manager approves on the card; HR moves the date, then withdraws', async ({
  page,
}, testInfo) => {
  const name = `Arun Candidate ${testInfo.project.name} ${Date.now()}`;
  await signInAs(page, DEV.admin);
  // One template per project: desktop and mobile run at the same time.
  const letterName = `Offer letter (e2e ${testInfo.project.name})`;
  const template = await page.request.put(
    `/api/letter-templates/e2e_offer_${testInfo.project.name}`,
    {
      data: {
        name: letterName,
        type: 'offer',
        body: 'Dear {{person.legalName}}, welcome as {{assignment.designation}}.',
        approverRole: null,
        signature: 'employee',
      },
    },
  );
  expect(template.ok()).toBe(true);

  // H3: the offer on one screen.
  await signInAs(page, DEV.hr);
  await page.goto('/offers');
  await page.getByRole('link', { name: 'New offer' }).click();
  await page.getByLabel('Candidate’s legal name').fill(name);
  await page.getByLabel('Personal email').fill(`arun.${Date.now()}@personal.test`);
  await page.getByLabel('Joining date').fill(inDays(14));
  await page.getByLabel('Designation').selectOption({ label: 'Software Engineer' });
  await page.getByLabel('Department').selectOption({ label: 'Engineering' });
  await page.getByLabel('Location').selectOption({ label: 'Chennai office' });
  await page.getByLabel('Hiring manager').selectOption({ label: 'Dev Manager (IDS-0002)' });
  await page.getByLabel('Annual CTC (₹)').fill('9,00,000');
  await page.getByLabel('Offer letter').selectOption({ label: letterName });
  await page.getByRole('button', { name: 'Send for approval' }).click();

  const detail = page.getByRole('complementary', { name: 'Offer' });
  await expect(detail.getByRole('heading', { name })).toBeVisible();
  await expect(detail.getByText('Waiting for approval')).toBeVisible();
  const offerId = page.url().split('/').at(-1)!;

  // The hiring manager decides on the card: role and how pay sits against the band, not the pay.
  await signInAs(page, DEV.manager);
  await page.goto('/');
  const card = page
    .getByRole('list', { name: 'Approvals' })
    .getByRole('listitem')
    .filter({ hasText: name });
  await expect(card.getByText('Within the grade band')).toBeVisible();
  await expect(card.getByText('9,00,000')).toHaveCount(0);
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0);

  // The candidate signs (development stand-in for Zoho Sign).
  await signInAs(page, DEV.hr);
  const offer = await (await page.request.get(`/api/offers/${offerId}`)).json();
  const signed = await page.request.post(`/api/letters/${offer.letter.id}/fake-signer`, {
    data: { action: 'sign' },
  });
  expect(signed.status()).toBe(204);

  // H4: accepted; the joining date moves.
  await page.goto(`/offers/${offerId}`);
  await expect(detail.getByText('Accepted', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'Change joining date' }).click();
  await detail.getByLabel('New joining date').fill(inDays(21));
  await detail.getByLabel('Why').fill('Notice period at current employer');
  await detail.getByRole('button', { name: 'Move joining date' }).click();
  await expect(detail.getByText(shortDate(inDays(21)), { exact: true })).toBeVisible();

  // Withdrawing needs a reason and a confirmation.
  await detail.getByRole('button', { name: 'Withdraw offer…' }).click();
  await detail.getByLabel('Reason').fill('Position frozen');
  page.once('dialog', (dialog) => dialog.accept());
  await detail.getByRole('button', { name: 'Withdraw offer' }).click();
  await expect(detail.getByText('Withdrawn', { exact: true })).toBeVisible();
});
