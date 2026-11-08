import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic people). Dev Employee resigns, Dev Manager and
// Dev HR accept, then the resignation is withdrawn and approved, so the dev data ends as it began.
const DEV = {
  employee: '00000000-0000-4000-8000-000000000101',
  manager: '00000000-0000-4000-8000-000000000102',
  managerTwo: '00000000-0000-4000-8000-000000000103',
  hr: '00000000-0000-4000-8000-000000000104',
};

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

/** Approves every open card about Dev Employee for the signed-in user (to finish a cut-short run). */
async function approveAll(page: Page, title: RegExp) {
  const cards = (await (await page.request.get('/api/approvals')).json()) as {
    approvalId: string;
    title: string;
  }[];
  for (const c of cards.filter((x) => title.test(x.title))) {
    await page.request.post(`/api/approvals/${c.approvalId}/approve`, { data: {} });
  }
}

/** A run cut short leaves an open resignation: withdraw it the way a person would. */
async function tidyUp(page: Page) {
  await signInAs(page, DEV.employee);
  const mine = await (await page.request.get('/api/exits/mine')).json();
  if (!mine.current) return;
  await page.request.post(`/api/exits/${mine.current.id}/withdraw`, {
    data: { reason: 'Tidying up an earlier test run' },
  });
  for (const who of [DEV.manager, DEV.hr]) {
    await signInAs(page, who);
    await approveAll(page, /^Withdraw resignation: Dev Employee/);
  }
}

test('resign, the manager and HR accept, then withdraw with their approval', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === 'mobile',
    'one person resigns; the form is checked on mobile below',
  );
  await tidyUp(page);

  await signInAs(page, DEV.employee);
  await page.goto('/resign');
  const form = page.getByRole('form', { name: 'Resignation' });
  await expect(form).toContainText('Your notice period is');
  await form.getByLabel('Main reason').selectOption('higher_studies');
  page.once('dialog', (dialog) => dialog.accept());
  await form.getByRole('button', { name: 'Send resignation' }).click();
  const mine = page.getByRole('region', { name: 'My resignation' });
  await expect(mine).toContainText('Resignation submitted');
  await expect(mine).toContainText('Waiting for the manager');

  await signInAs(page, DEV.manager);
  await page.goto('/');
  const card = page
    .getByRole('list', { name: 'Approvals' })
    .getByRole('listitem')
    .filter({ hasText: 'Resignation: Dev Employee' });
  await expect(card).toContainText('Record the retention conversation on the exit page first');
  await expect(card.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await card.getByRole('link', { name: 'Open' }).click();
  const accept = page.getByRole('form', { name: 'Accept as manager' });
  await accept.getByLabel('The retention conversation').fill('Offered study leave; declined');
  await accept.getByRole('button', { name: 'Accept and send to HR' }).click();
  await expect(page.getByText('Waiting for HR (last working day)')).toBeVisible();

  await signInAs(page, DEV.hr);
  await page.goto('/exits');
  await page
    .getByRole('list', { name: 'Exits' })
    .getByRole('link', { name: /Dev Employee/ })
    .click();
  const hr = page.getByRole('form', { name: 'Accept as HR' });
  await expect(hr.getByRole('button', { name: 'Accept the resignation' })).toBeVisible();
  await hr.getByRole('button', { name: 'Accept the resignation' }).click();
  const detail = page.getByRole('complementary', { name: 'Exit' });
  await expect(detail).toContainText('Serving notice');
  await expect(detail).toContainText('Offered study leave; declined');
  await expect(detail).toContainText(/0 of \d+ done/);
  // What still stands before the exit, then the exit interview (HR only, decision #81).
  const before = detail.getByRole('status', { name: 'Before the exit' });
  await expect(before).toContainText('Record the exit interview first');
  await expect(before).toContainText('The exit checklist isn’t finished');
  const interview = detail.getByRole('form', { name: 'Exit interview' });
  await interview.getByLabel('Why are you leaving?').fill('Higher studies abroad');
  await interview.getByLabel('Would you come back to Ideassion?').selectOption('yes');
  await interview.getByRole('button', { name: 'Save the interview' }).click();
  await expect(detail).toContainText('Higher studies abroad');
  await expect(before).not.toContainText('Record the exit interview first');
  await expect(detail.getByRole('button', { name: 'Complete exit' })).toHaveCount(0);

  await signInAs(page, DEV.employee);
  await page.goto('/resign');
  await mine.getByRole('button', { name: 'Withdraw…' }).click();
  await mine.getByLabel('Why are you withdrawing?').fill('Deferred my studies by a year');
  await mine.getByRole('button', { name: 'Withdraw resignation' }).click();
  await expect(mine).toContainText('Withdrawal waiting for your manager and HR');

  for (const who of [DEV.manager, DEV.hr]) {
    await signInAs(page, who);
    await page.goto('/');
    const w = page
      .getByRole('list', { name: 'Approvals' })
      .getByRole('listitem')
      .filter({ hasText: 'Withdraw resignation: Dev Employee' });
    await w.getByRole('button', { name: 'Approve' }).click();
    await expect(w).toHaveCount(0);
  }

  await signInAs(page, DEV.employee);
  await page.goto('/resign');
  await expect(page.getByRole('form', { name: 'Resignation' })).toBeVisible();
});

test('the resignation form shows the notice on a phone', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'the full flow runs on desktop');
  await signInAs(page, DEV.managerTwo);
  await page.goto('/me');
  await page.getByRole('link', { name: 'Resign…' }).click();
  const form = page.getByRole('form', { name: 'Resignation' });
  await expect(form).toContainText(/Your notice period is \d+ days/);
  await expect(form.getByLabel('Last working day you propose')).toBeVisible();
});
