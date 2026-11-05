import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic people). Desktop and mobile run at once, so each
// regularises as a different person, approved by that person's manager.
const DEV = {
  employee: '00000000-0000-4000-8000-000000000101',
  manager: '00000000-0000-4000-8000-000000000102',
  hr: '00000000-0000-4000-8000-000000000104',
  hrHead: '00000000-0000-4000-8000-000000000105',
  admin: '00000000-0000-4000-8000-000000000107',
};
const PAIR = {
  desktop: { asker: DEV.employee, approver: DEV.manager },
  mobile: { asker: DEV.hr, approver: DEV.hrHead },
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

interface Day {
  date: string;
  status: string | null;
  working: boolean;
  flags: string[];
  regularised: boolean;
}

/** The most recent past working day, within the 5-day window, that can be regularised. */
async function dayToRegularise(page: Page): Promise<string> {
  const me = await (await page.request.get('/api/me')).json();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  for (let back = 1; back <= 5; back++) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - back);
    const date = d.toISOString().slice(0, 10);
    const days = (await (
      await page.request.get(`/api/people/${me.personId}/attendance?month=${date.slice(0, 7)}`)
    ).json()) as Day[];
    const day = days.find((x) => x.date === date)!;
    const needs =
      day.status === 'absent' ||
      day.flags.includes('missing_check_out') ||
      (day.status === null && day.working);
    if (needs && !day.regularised) return date;
  }
  throw new Error('No working day in the last 5 days');
}

test('an employee regularises a missed day; their manager approves it on the card', async ({
  page,
}, testInfo) => {
  const pair = PAIR[testInfo.project.name as 'desktop' | 'mobile'];
  await signInAs(page, pair.asker);
  const date = await dayToRegularise(page);
  await page.goto('/attendance');
  await page.getByLabel('Month').fill(date.slice(0, 7));
  await page.getByRole('button', { name: new RegExp(`^${label(date)}:`) }).click();
  const detail = page.getByRole('complementary', { name: 'Attendance day' });
  await detail.getByLabel('Reason').selectOption('forgot_to_punch');
  await detail.getByLabel('Mark as').selectOption('present');
  await detail.getByLabel('In at').fill('09:30');
  await detail.getByLabel('Out at').fill('18:30');
  await detail.getByRole('button', { name: 'Send to my manager' }).click();
  await expect(detail.getByText('waiting for your manager')).toBeVisible();

  await signInAs(page, pair.approver);
  await page.goto('/');
  const card = page
    .getByRole('list', { name: 'Approvals' })
    .getByRole('listitem')
    .filter({ hasText: `Regularise ${date}` });
  await expect(card.getByText('Forgot to punch')).toBeVisible();
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0);

  await signInAs(page, pair.asker);
  await page.goto('/attendance');
  await page.getByLabel('Month').fill(date.slice(0, 7));
  await page.getByRole('button', { name: new RegExp(`^${label(date)}: Present`) }).click();
  await expect(
    page
      .getByRole('complementary', { name: 'Attendance day' })
      .getByText(/corrected by a regularisation/),
  ).toBeVisible();
});

test('HR head corrects a day with no check-out from the exceptions list', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'H9 is a desktop screen');
  // A device pushes one punch for a synthetic person yesterday: a day with no check-out.
  await signInAs(page, DEV.admin);
  const device = await page.request.post('/api/biometric/devices', {
    data: {
      code: 'E2E-H9',
      name: 'E2E H9 reader',
      locationId: (
        await (await page.request.get('/api/org/units/locations?asOf=2026-01-01')).json()
      ).find((l: { name: string }) => l.name === 'Chennai office').id,
    },
  });
  expect(device.status()).toBe(201);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const y = new Date(`${today}T00:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  const yesterday = y.toISOString().slice(0, 10);
  const push = await page.request.post('/api/biometric/punches', {
    headers: { 'x-device-key': (await device.json()).key },
    data: {
      punches: [
        { employeeCode: 'IDS-0007', at: `${yesterday}T09:05:00+05:30`, externalId: 'h9-1' },
      ],
    },
  });
  expect((await push.json()).accepted).toBe(1);

  await signInAs(page, DEV.hrHead);
  await page.goto('/attendance-exceptions');
  const row = page
    .getByRole('list', { name: 'Attendance exceptions' })
    .getByRole('listitem')
    .filter({ hasText: 'Asha Synthetic' })
    .filter({ hasText: label(yesterday) });
  await expect(row).toContainText('No check-out');
  await row.getByRole('checkbox').check();
  const panel = page.getByRole('complementary', { name: 'Correct attendance' });
  await panel.getByLabel('Out at').fill('18:00');
  await panel.getByLabel('Reason').fill('Reader missed the evening punch');
  await panel.getByRole('button', { name: 'Correct 1 day' }).click();
  await expect(row).toHaveCount(0);
});
