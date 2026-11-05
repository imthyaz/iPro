import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database: synthetic people at the dev Chennai office, which the seed
// places at a made-up point (13.0, 80.2) with the default 200 m geofence.
const OFFICE = { latitude: 13.0, longitude: 80.2 };
// Desktop and mobile run at once, so each checks in as a different person.
const PERSON = {
  desktop: '00000000-0000-4000-8000-000000000101',
  mobile: '00000000-0000-4000-8000-000000000103',
};
const DEV = { admin: '00000000-0000-4000-8000-000000000107' };

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

test('check in from home with one tap, flagged outside the office area, then check out', async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(['geolocation']);
  // About 2 km north of the office.
  await context.setGeolocation({ latitude: OFFICE.latitude + 0.018, longitude: OFFICE.longitude });
  await signInAs(page, PERSON[testInfo.project.name as 'desktop' | 'mobile']);
  await page.goto('/');

  const card = page.getByRole('region', { name: /^Today/ });
  await card.getByRole('radio', { name: 'Office' }).click();
  await card.getByRole('button', { name: 'Check in' }).click();
  await expect(card.getByRole('status')).toContainText('Checked in at');
  await expect(card.getByText(/marked for your manager to see/)).toBeVisible();

  await context.setGeolocation({ latitude: OFFICE.latitude, longitude: OFFICE.longitude });
  await card.getByRole('button', { name: 'Check out' }).click();
  await expect(card.getByRole('status')).toContainText('Checked out at');
  await expect(card.getByText(/marked for your manager to see/)).toHaveCount(0);

  // My attendance: today shows on the calendar with its flag and the "why".
  await page.goto('/attendance');
  const today = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date());
  await page
    .getByRole('button', { name: new RegExp(`^${today}: .*Outside the office area`) })
    .click();
  const detail = page.getByRole('complementary', { name: 'Attendance day' });
  await expect(detail.getByRole('heading', { name: today })).toBeVisible();
  await expect(detail.getByText('Outside the office area')).toBeVisible();
  await expect(detail.getByText(/less the shift’s break/)).toBeVisible();
});

test('an admin registers a biometric device and its punches arrive at once', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'admin set-up; the push is not a browser flow');
  await signInAs(page, DEV.admin);
  await page.goto('/devices');
  await page.getByLabel('Code').fill('E2E-LOBBY');
  await page.getByLabel('Name', { exact: true }).fill('E2E lobby reader');
  await page.getByLabel('Location', { exact: true }).selectOption({ label: 'Chennai office' });
  await page.getByRole('button', { name: 'Add device' }).click();
  const key = (await page.getByTestId('device-key').textContent())!;
  expect(key.length).toBeGreaterThan(30);

  // The device's agent pushes yesterday morning's punch for Dev Employee.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const push = await page.request.post('/api/biometric/punches', {
    headers: { 'x-device-key': key },
    data: {
      punches: [
        { employeeCode: 'IDS-0006', at: `${yesterday}T09:15:00+05:30`, externalId: 'e2e-1' },
      ],
    },
  });
  expect(push.status()).toBe(200);
  expect(await push.json()).toMatchObject({ accepted: 1 });
  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: 'E2E lobby reader' });
  await expect(row).not.toContainText('last push never');
});
