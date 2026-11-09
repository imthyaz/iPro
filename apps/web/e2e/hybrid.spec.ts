import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic people). Desktop and mobile plan as different
// people, each approved by that person's manager, in the first week ahead nobody has planned yet.
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

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The first Monday, two or more weeks ahead, with nothing booked and nothing waiting. */
async function freeWeek(page: Page, offset: number): Promise<string> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  for (let n = 2 + offset; n < 60; n += 2) {
    const week = addDays(monday, n * 7);
    const view = await (await page.request.get(`/api/hybrid/week?start=${week}`)).json();
    if (view.fit.booked === 0 && view.exception === null && view.policy?.requiredDays > 0) {
      return week;
    }
  }
  throw new Error('No free week');
}

test('plan a week below policy; the manager approves it on the card', async ({
  page,
}, testInfo) => {
  const pair = PAIR[testInfo.project.name as 'desktop' | 'mobile'];
  await signInAs(page, pair.asker);
  const week = await freeWeek(page, testInfo.project.name === 'mobile' ? 1 : 0);

  await page.goto(`/hybrid?week=${week}`);
  const days = page.getByRole('list', { name: 'Days' }).getByRole('radiogroup');
  await expect(days.first()).toBeVisible();
  const count = await days.count();
  await days.nth(0).getByText('Office', { exact: true }).click();
  for (let i = 1; i < count; i++) await days.nth(i).getByText('WFH', { exact: true }).click();
  await expect(page.getByLabel('Policy meter')).toContainText('1 of');
  await page.getByRole('button', { name: 'Save my week' }).click();

  const below = page.getByRole('status', { name: 'Below policy' });
  await expect(below).toContainText('office days booked');
  await page.getByLabel('Why? Your manager sees this').fill('Release week with the US team');
  await page.getByRole('button', { name: 'Send to my manager' }).click();
  await expect(page.getByText('Sent to your manager.')).toBeVisible();
  await expect(page.getByLabel('Policy meter')).toContainText('waiting for your manager');

  await signInAs(page, pair.approver);
  await page.goto('/');
  const card = page
    .getByRole('list', { name: 'Waiting on you' })
    .getByRole('listitem')
    .filter({ hasText: `Hybrid week below policy: ${pair.name}` });
  await expect(card).toContainText('office days booked');
  await expect(card).toContainText('Release week with the US team');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0);
  // Approvals wait out their 10-second undo window before they are sent (decision #86).
  await expect(page.getByText(/· sending/)).toHaveCount(0, { timeout: 20_000 });

  await signInAs(page, pair.asker);
  await page.goto(`/hybrid?week=${week}`);
  await expect(page.getByLabel('Policy meter')).toContainText('Approved by your manager');
});
