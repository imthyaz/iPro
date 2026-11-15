import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database with the scripted model (LLM_PROVIDER=fake): it calls the
// real tools as the signed-in user and states only what they return.
const DEV = {
  manager: '00000000-0000-4000-8000-000000000102',
  employee: '00000000-0000-4000-8000-000000000101',
};

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

test('Ask iPro answers from iPro’s own data, with a link to the screen behind it', async ({
  page,
}) => {
  await signInAs(page, DEV.manager);
  await page.goto('/');
  await page.getByRole('button', { name: 'Ask iPro' }).click();
  const panel = page.getByRole('complementary', { name: 'Ask iPro' });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'How many approvals are waiting for me?' }).click();

  const waiting = ((await (await page.request.get('/api/approvals')).json()) as unknown[]).length;
  const thread = panel.getByRole('log', { name: 'Conversation' });
  await expect(thread).toContainText(`You have ${waiting} approval`);
  await expect(thread.getByRole('link', { name: 'Action inbox' })).toBeVisible();

  // A follow-up in the same conversation, typed and sent with Enter.
  await panel.getByLabel('Your question').fill('Who is on leave today?');
  await panel.getByLabel('Your question').press('Enter');
  await expect(thread).toContainText(/on leave today\./);

  // The panel never makes the page scroll sideways (full screen on a phone).
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('an employee asking for their balances gets each leave type', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'One person; the desktop run covers it');
  await signInAs(page, DEV.employee);
  await page.goto('/');
  await page.getByRole('button', { name: 'Ask iPro' }).click();
  const panel = page.getByRole('complementary', { name: 'Ask iPro' });
  await panel.getByRole('button', { name: 'How many casual leaves do I have?' }).click();
  await expect(panel.getByRole('log', { name: 'Conversation' })).toContainText('Casual leave:');
});
