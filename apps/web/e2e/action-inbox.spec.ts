import { expect, test, type Locator, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic people). Dev Lead Three's ten teammates exist for
// this test alone, so no other test's cards land in that inbox.
const LEAD = '00000000-0000-4000-8000-000000000108';
const TEAM = Array.from(
  { length: 10 },
  (_, i) => `00000000-0000-4000-8000-${String(111 + i).padStart(12, '0')}`,
);
const DEV = { employee: '00000000-0000-4000-8000-000000000101' };

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

/** One working day at least a week ahead that this person has free, as unpaid leave. */
async function applyOneDay(page: Page) {
  const types = (await (await page.request.get('/api/leave-types')).json()) as {
    id: string;
    code: string;
  }[];
  const lop = types.find((t) => t.code === 'LOP')!.id;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  for (let n = 7; n < 90; n++) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    const day = d.toISOString().slice(0, 10);
    const preview = await (
      await page.request.post('/api/leave/requests/preview', {
        data: { leaveTypeId: lop, from: day, to: day },
      })
    ).json();
    if (preview.days !== 1 || preview.problems.length > 0) continue;
    const sent = await page.request.post('/api/leave/requests', {
      data: { leaveTypeId: lop, from: day, to: day, reason: 'Personal work' },
    });
    expect(sent.status()).toBe(201);
    return;
  }
  throw new Error('No free working day found');
}

/** Drags a card to the right from its middle, as a finger would. */
async function swipeRight(page: Page, card: Locator) {
  const box = (await card.locator('.muted').first().boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 10, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, y, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.8, y, { steps: 6 });
  await page.mouse.up();
}

test('a manager clears 10 leave requests from the Action inbox on a phone in under a minute', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Slice 11 done-when #1 is about a phone');
  test.setTimeout(180_000);
  // A retry starts from an empty inbox: approve anything an earlier attempt left behind.
  await signInAs(page, LEAD);
  const left = (await (await page.request.get('/api/approvals')).json()) as {
    approvalId: string;
  }[];
  if (left.length > 0) {
    const cleared = await page.request.post('/api/approvals/bulk-approve', {
      data: { approvalIds: left.map((c) => c.approvalId) },
    });
    expect(cleared.status()).toBe(200);
  }
  for (const teammate of TEAM) {
    await signInAs(page, teammate);
    await applyOneDay(page);
  }

  await signInAs(page, LEAD);
  const started = Date.now();
  await page.goto('/');
  const list = page.getByRole('list', { name: 'Waiting on you' });
  const cards = list.getByRole('listitem').filter({ hasText: 'Dev Teammate' });
  await expect(cards).toHaveCount(10);
  // The card carries what's needed to decide: balance or loss of pay, who else is off, policy fit.
  await expect(cards.first()).toContainText('Also off');
  await expect(cards.first()).toContainText('Policy');

  // A swipe approves one; undo brings it back.
  await swipeRight(page, cards.first());
  const bar = page.getByRole('region', { name: 'Approvals' });
  await expect(bar.getByRole('status')).toContainText('Approved: ');
  await expect(cards).toHaveCount(9);
  await bar.getByRole('button', { name: 'Undo' }).click();
  await expect(cards).toHaveCount(10);

  // Swipe one, then select the rest and approve them together.
  await swipeRight(page, cards.first());
  await expect(cards).toHaveCount(9);
  await page.getByRole('button', { name: 'Select all routine (9)' }).click();
  await page.getByRole('button', { name: 'Approve 9' }).click();
  await expect(cards).toHaveCount(0);
  await expect(bar.getByRole('status').filter({ hasText: 'Approved 9 requests' })).toBeVisible();
  // Both sends go out after their 10-second undo windows; the inbox then shows none left.
  await expect(page.getByText(/· sending/)).toHaveCount(0, { timeout: 20_000 });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Action inbox' })).toBeVisible();
  await expect(cards).toHaveCount(0);
  expect(Date.now() - started).toBeLessThan(60_000);

  // Each request really is approved.
  for (const teammate of [TEAM[0]!, TEAM[9]!]) {
    await signInAs(page, teammate);
    const year = new Date().getFullYear();
    const mine = (await (
      await page.request.get(`/api/leave/requests/mine?year=${year}`)
    ).json()) as {
      status: string;
    }[];
    const next = (await (
      await page.request.get(`/api/leave/requests/mine?year=${year + 1}`)
    ).json()) as { status: string }[];
    expect([...mine, ...next].map((r) => r.status)).toContain('approved');
  }
});

test('notifications: the full list, mark all read, and topics that can be switched off', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Settings change the same person; one project');
  await signInAs(page, DEV.employee);
  await page.goto('/');
  await page.getByRole('link', { name: /^Notifications/ }).click();
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();

  const topics = page.getByRole('list', { name: 'Topics' });
  const approvals = topics.getByRole('checkbox', { name: /Approvals waiting for you/ });
  await expect(approvals).toBeChecked();
  await expect(approvals).toBeDisabled();
  const requests = topics.getByRole('checkbox', { name: /Your requests/ });
  await requests.uncheck();
  await expect(requests).not.toBeChecked();
  await page.reload();
  await expect(topics.getByRole('checkbox', { name: /Your requests/ })).not.toBeChecked();
  await topics.getByRole('checkbox', { name: /Your requests/ }).check();
  await expect(topics.getByRole('checkbox', { name: /Your requests/ })).toBeChecked();

  const email = page.getByRole('list', { name: 'Email' }).getByRole('checkbox');
  await expect(email).not.toBeChecked();

  const markAll = page.getByRole('button', { name: 'Mark all read' });
  if (await markAll.isVisible()) {
    await markAll.click();
    await expect(page.getByRole('heading', { name: 'Recent (0 unread)' })).toBeVisible();
  }
});
