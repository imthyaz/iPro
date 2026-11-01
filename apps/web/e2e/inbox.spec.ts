import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic users and people from `pnpm db:seed`).
const DEV = {
  employee: '00000000-0000-4000-8000-000000000101',
  hr: '00000000-0000-4000-8000-000000000104',
  admin: '00000000-0000-4000-8000-000000000107',
  managerTwo: '00000000-0000-4000-8000-000000000103',
};

/** Desktop and mobile run in parallel, so each changes a different synthetic person. */
const requester = (project: string) =>
  project === 'mobile'
    ? { id: DEV.managerTwo, name: 'Dev Manager Two' }
    : { id: DEV.employee, name: 'Dev Employee' };

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

/** A phone number unique to this run and project, so parallel runs find their own card. */
const uniquePhone = () =>
  `+91 9${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0')}`;

/** The approval card asking for this phone number (the new value, not an old one). */
const cardFor = (page: Page, phone: string) =>
  page
    .getByRole('list', { name: 'Approvals' })
    .getByRole('listitem')
    .filter({ has: page.locator('strong', { hasText: phone }) });

async function requestPhoneChange(page: Page, who: { id: string }, phone: string) {
  await signInAs(page, who.id);
  await page.goto('/me');
  await page.getByRole('button', { name: 'Request a change' }).click();
  await page.getByLabel('Phone').fill(phone);
  await page.getByRole('button', { name: 'Send to HR' }).click();
  await expect(page.getByText('Sent to HR for approval.')).toBeVisible();
}

test('an employee’s change is approved by HR in one tap from the inbox', async ({
  page,
}, testInfo) => {
  const who = requester(testInfo.project.name);
  const phone = uniquePhone();
  await requestPhoneChange(page, who, phone);

  await signInAs(page, DEV.hr);
  await page.goto('/');
  const card = cardFor(page, phone);
  await expect(card.getByText(`Profile change: ${who.name}`)).toBeVisible();
  await expect(card.getByText(`HR review · for ${who.name}`, { exact: false })).toBeVisible();
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0);

  await signInAs(page, who.id);
  await page.goto('/me');
  await expect(page.getByText(phone)).toBeVisible();
  await page.goto('/requests');
  await page
    .getByRole('link', { name: /Profile change/ })
    .first()
    .click();
  const detail = page.getByRole('complementary', { name: 'Request' });
  await expect(detail.getByText('Approved').first()).toBeVisible();
});

test('rejecting needs a comment; the requester sees it and can withdraw', async ({
  page,
}, testInfo) => {
  const who = requester(testInfo.project.name);
  const phone = uniquePhone();
  await requestPhoneChange(page, who, phone);

  await signInAs(page, DEV.hr);
  await page.goto('/');
  const card = cardFor(page, phone);
  await card.getByRole('button', { name: 'Reject…' }).click();
  const send = card.getByRole('button', { name: 'Return to requester' });
  await expect(send).toBeDisabled();
  await card.getByLabel('Why are you returning it?').fill('Please use your personal mobile number');
  await send.click();
  await expect(card).toHaveCount(0);

  await signInAs(page, who.id);
  await page.goto('/requests');
  await page
    .getByRole('link', { name: /Profile change.*Returned to you/ })
    .first()
    .click();
  const detail = page.getByRole('complementary', { name: 'Request' });
  await expect(detail.getByText('Returned to you')).toBeVisible();
  await expect(detail.getByText(/Please use your personal mobile number/)).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await detail.getByRole('button', { name: 'Withdraw' }).click();
  await expect(detail.getByText('Withdrawn')).toBeVisible();
});

test('a published policy appears in the inbox and is accepted after opening it', async ({
  page,
}) => {
  const code = `E2E-${Date.now()}`;
  const title = `Remote work policy ${code}`;
  await signInAs(page, DEV.admin);
  const created = await page.request.post('/api/policies', {
    data: { code, title, appliesTo: {}, requiresAcknowledgement: true },
  });
  expect(created.status()).toBe(201);
  const { policyId } = await created.json();
  const published = await page.request.post(`/api/policies/${policyId}/versions`, {
    multipart: {
      effectiveFrom: '2026-01-01',
      file: {
        name: 'Remote work.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(`%PDF-1.4\n% synthetic ${code}\n`),
      },
    },
  });
  expect(published.status()).toBe(201);

  await signInAs(page, DEV.employee);
  await page.goto('/');
  const card = page.getByRole('listitem', { name: title });
  await card.getByRole('link', { name: 'Read and accept' }).click();

  const policy = page.getByRole('listitem', { name: title });
  const accept = policy.getByRole('button', { name: 'Accept' });
  await expect(policy.getByRole('checkbox')).toBeDisabled();
  await policy.getByRole('button', { name: 'Open Remote work.pdf' }).click();
  await policy.getByRole('checkbox').check();
  await accept.click();
  await expect(policy.getByText(/^Accepted /)).toBeVisible();
});
