import { expect, test } from '@playwright/test';

test('signed out, the shell shows the dev sign-in and reaches a healthy API', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Development sign-in' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Dev HR\b/ }).first()).toBeVisible();
  await expect(page.getByTestId('api-status')).toHaveText('Connected');
});

test('health endpoint returns ok through the web origin', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'ok', checks: { database: 'ok' } });
});
