import { expect, test, type Page } from '@playwright/test';

/**
 * Slice 14d (decision #99): the built app runs under its content security policy with nothing
 * blocked, so the policy can stay strict. Runs against the seeded dev database.
 */
const DEV = {
  employee: '00000000-0000-4000-8000-000000000101',
  manager: '00000000-0000-4000-8000-000000000102',
};

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

const RECORD_VIOLATIONS = () => {
  const seen: string[] = [];
  (window as unknown as { __csp: string[] }).__csp = seen;
  document.addEventListener('securitypolicyviolation', (e) =>
    seen.push(`${e.violatedDirective} ${e.blockedURI}`),
  );
};

for (const [who, paths] of [
  ['employee', ['/', '/attendance', '/leave', '/hybrid', '/journey', '/requests']],
  ['manager', ['/', '/team-today', '/team-calendar', '/team-journeys']],
] as const) {
  test(`${who} screens run under the content security policy with nothing blocked`, async ({
    page,
  }) => {
    await signInAs(page, DEV[who]);
    await page.addInitScript(RECORD_VIOLATIONS);
    for (const path of paths) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      const policy = await page
        .locator('meta[http-equiv="Content-Security-Policy"]')
        .getAttribute('content');
      expect(policy).toContain("script-src 'self'");
      expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual(
        [],
      );
    }
  });
}
