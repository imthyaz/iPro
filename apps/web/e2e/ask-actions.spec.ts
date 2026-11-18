import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database with the scripted model, which prepares a leave card from
// the question. Nothing may change until the card is confirmed (slice 12 done-when #3).
const DEV = { employee: '00000000-0000-4000-8000-000000000101' };

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

/** A free working day at least three weeks ahead, as unpaid leave (no balance needed). */
async function freeDay(page: Page): Promise<string> {
  const types = (await (await page.request.get('/api/leave-types')).json()) as {
    id: string;
    code: string;
  }[];
  const lop = types.find((t) => t.code === 'LOP')!.id;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  for (let n = 21; n < 120; n++) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    const day = d.toISOString().slice(0, 10);
    const preview = await (
      await page.request.post('/api/leave/requests/preview', {
        data: { leaveTypeId: lop, from: day, to: day },
      })
    ).json();
    if (preview.days === 1 && preview.problems.length === 0) return day;
  }
  throw new Error('No free working day found');
}

const requestsOn = async (page: Page, day: string) =>
  (
    (await (await page.request.get(`/api/leave/requests/mine?year=${day.slice(0, 4)}`)).json()) as {
      from: string;
      status: string;
    }[]
  ).filter((r) => r.from === day && r.status !== 'cancelled' && r.status !== 'withdrawn');

test('leave asked for in Ask iPro is applied only when the card is confirmed', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'One person applies; the desktop run covers it');
  await signInAs(page, DEV.employee);
  const day = await freeDay(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Ask iPro' }).click();
  const panel = page.getByRole('complementary', { name: 'Ask iPro' });
  await panel.getByLabel('Your question').fill(`Apply LOP leave on ${day}`);
  await panel.getByRole('button', { name: 'Ask', exact: true }).click();

  const card = panel.getByRole('region', { name: /^Apply / });
  await expect(card).toContainText(day);
  await expect(card).toContainText('Goes to');
  // Nothing has been applied yet.
  expect(await requestsOn(page, day)).toHaveLength(0);

  await card.getByRole('button', { name: 'Apply' }).click();
  await expect(card.getByRole('status')).toContainText('Done.');
  expect((await requestsOn(page, day)).map((r) => r.status)).toEqual(['applied']);
  await expect(card.getByRole('button', { name: 'Apply' })).toHaveCount(0);
});
