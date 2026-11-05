import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic people). Desktop and mobile run at once, so each
// applies as a different person, approved by that person's manager. Neither has a casual balance.
const DEV = {
  managerTwo: '00000000-0000-4000-8000-000000000103',
  hr: '00000000-0000-4000-8000-000000000104',
  hrHead: '00000000-0000-4000-8000-000000000105',
  cxo: '00000000-0000-4000-8000-000000000106',
};
const PAIR = {
  desktop: { asker: DEV.hr, approver: DEV.hrHead, name: 'Dev HR' },
  mobile: { asker: DEV.managerTwo, approver: DEV.cxo, name: 'Dev Manager Two' },
};

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

const label = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`));

/** Two consecutive working days at least a week ahead (not a weekend or seeded holiday). */
async function twoWorkingDays(page: Page, offsetWeeks: number): Promise<[string, string]> {
  const types = (await (await page.request.get('/api/leave-types')).json()) as {
    id: string;
    code: string;
  }[];
  const lop = types.find((t) => t.code === 'LOP')!.id;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  for (let n = 7 + offsetWeeks * 7; n < 60 + offsetWeeks * 7; n++) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    const from = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
    const to = d.toISOString().slice(0, 10);
    const preview = await (
      await page.request.post('/api/leave/requests/preview', {
        data: { leaveTypeId: lop, from, to },
      })
    ).json();
    if (preview.days === 2 && preview.problems.length === 0) return [from, to];
  }
  throw new Error('No two working days found');
}

test('apply leave from home in three taps; the manager approves it on the card', async ({
  page,
}, testInfo) => {
  const pair = PAIR[testInfo.project.name as 'desktop' | 'mobile'];
  await signInAs(page, pair.asker);
  const [from, to] = await twoWorkingDays(page, testInfo.project.name === 'mobile' ? 2 : 0);

  await page.goto('/');
  await page.getByRole('link', { name: /Apply leave/ }).click();
  const form = page.getByRole('form', { name: 'Apply leave' });
  await form.getByRole('radio', { name: 'Casual leave' }).click();
  await form.getByLabel('From').fill(from);
  await form.getByLabel('To').fill(to);
  // No casual balance: the form says so and offers the days as loss of pay.
  await expect(form.getByRole('status', { name: 'What this leave is' })).toContainText('2 days');
  await expect(form.getByText('2 days would be loss of pay')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Send to my manager' })).toBeDisabled();
  await form.getByLabel('Take 2 days beyond my balance as loss of pay').check();
  await form.getByRole('button', { name: 'Send to my manager' }).click();
  await expect(page.getByText(/^Sent: Casual leave/)).toBeVisible();

  await signInAs(page, pair.approver);
  await page.goto('/');
  const card = page
    .getByRole('list', { name: 'Approvals' })
    .getByRole('listitem')
    .filter({ hasText: `Casual leave: ${pair.name}` });
  await expect(card).toContainText('Loss of pay');
  await expect(card).toContainText('Planned');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0);

  await signInAs(page, pair.asker);
  await page.goto('/leave');
  const request = page
    .getByRole('list', { name: 'Leave requests' })
    .getByRole('listitem')
    .filter({ hasText: label(from) });
  await expect(request).toContainText('Approved');
  await expect(request).toContainText('2 days loss of pay');

  await page.goto('/attendance');
  await page.getByLabel('Month').fill(from.slice(0, 7));
  await expect(
    page.getByRole('button', { name: new RegExp(`^${label(from)}: On leave`) }),
  ).toBeVisible();

  // Cancelled before it starts: the days come off the calendar.
  await page.goto('/leave');
  page.once('dialog', (dialog) => dialog.accept());
  await request.getByRole('button', { name: 'Cancel' }).click();
  await expect(request).toContainText('Cancelled');
});
