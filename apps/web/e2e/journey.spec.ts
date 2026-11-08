import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic people).
const DEV = {
  employee: '00000000-0000-4000-8000-000000000101',
  hr: '00000000-0000-4000-8000-000000000104',
};

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

test('an employee opens My journey: events on the track, filters, and the detail', async ({
  page,
}) => {
  await signInAs(page, DEV.employee);
  await page.goto('/journey');
  await expect(page.getByRole('heading', { name: 'My journey' })).toBeVisible();
  const journey = page.getByRole('region', { name: 'Journey' });
  const joined = journey.getByRole('button', { name: /^Joined/ });
  await expect(joined).toBeVisible();
  await expect(journey.getByLabel('Designation lane')).toBeVisible();
  // The page itself never scrolls sideways; the track does, inside its card.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);

  await joined.click();
  await expect(page.getByRole('region', { name: 'Event detail' })).toContainText('Joined');
  // Turning the lifecycle filter off hides the card.
  const filter = journey.getByRole('group', { name: 'Show events' }).getByRole('button', {
    name: /Lifecycle/,
  });
  await filter.click();
  await expect(filter).toHaveAttribute('aria-pressed', 'false');
  await expect(journey.getByRole('button', { name: /^Joined/ })).toHaveCount(0);
});

test('HR sees the compact journey on a profile and opens the full one', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'the person record is a desktop screen for HR');
  await signInAs(page, DEV.hr);
  await page.goto('/people');
  await page
    .getByRole('link', { name: /Dev Employee/ })
    .first()
    .click();
  const compact = page.getByRole('region', { name: 'Journey' });
  await expect(compact).toContainText('events');
  await compact.getByRole('button', { name: 'View full journey →' }).click();
  await expect(page.getByRole('group', { name: 'Show events' })).toBeVisible();
});
