import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic people), whose default shift has Saturday and
// Sunday off. Desktop and mobile ask as different people. The manager returns the request and the
// employee withdraws it, so the day is free for the next run (granting is covered by the API tests).
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

/** The latest weekend day in the last fortnight with no comp-off request open or granted. */
async function freeWeekendDay(page: Page): Promise<string> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const year = today.slice(0, 4);
  const mine = (await (await page.request.get(`/api/leave/comp-off/mine?year=${year}`)).json()) as {
    workedOn: string;
    status: string;
  }[];
  for (let n = 1; n <= 14; n++) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    const day = d.toISOString().slice(0, 10);
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    if (weekend && !mine.some((r) => r.workedOn === day && r.status !== 'withdrawn')) return day;
  }
  throw new Error('No free weekend day');
}

test('ask for comp-off for a weekend worked; the manager sees the day on the card', async ({
  page,
}, testInfo) => {
  const pair = PAIR[testInfo.project.name as 'desktop' | 'mobile'];
  await signInAs(page, pair.asker);
  const day = await freeWeekendDay(page);

  await page.goto('/leave');
  await page.getByRole('button', { name: 'Ask for comp-off' }).click();
  const form = page.getByRole('form', { name: 'Ask for comp-off' });
  await expect(form).toContainText('used for 60 days');
  await form.getByLabel('Day you worked').fill(day);
  await form.getByLabel('How much').selectOption('0.5');
  await form.getByLabel('What you worked on').fill('Release support');
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(form).toHaveCount(0);
  const row = page
    .getByRole('list', { name: 'Comp-off requests' })
    .getByRole('listitem')
    .filter({ hasText: label(day) })
    // Newest first: an earlier run's withdrawn request for the same day comes after it.
    .first();
  await expect(row).toContainText('weekly off');
  await expect(row).toContainText('Waiting for approval');

  await signInAs(page, pair.approver);
  await page.goto('/');
  const card = page
    .getByRole('list', { name: 'Approvals' })
    .getByRole('listitem')
    .filter({ hasText: `Comp-off: ${pair.name}` });
  await expect(card).toContainText('weekly off');
  await expect(card).toContainText('No check-in recorded');
  await expect(card).toContainText('0.5 days, usable for 60 days after approval');
  await expect(card).toContainText('Release support');
  await card.getByRole('button', { name: 'Reject…' }).click();
  await card.getByLabel('Why are you returning it?').fill('Please add the ticket number');
  await card.getByRole('button', { name: 'Return to requester' }).click();
  await expect(card).toHaveCount(0);

  await signInAs(page, pair.asker);
  await page.goto('/leave');
  await expect(row).toContainText('Returned');
  page.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: 'Withdraw' }).click();
  await expect(row).toContainText('Withdrawn');
});
