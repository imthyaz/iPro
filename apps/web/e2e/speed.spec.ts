import { gzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';

/**
 * Slice 14 done-when #3, speed (decision #97): employee and manager pages load in under 2 s on 4G,
 * and check-in completes in under 3 s. "4G" is Lighthouse's mobile network: 150 ms round trip,
 * 1.6 Mbps down, 750 Kbps up. The phone project also runs the CPU 4× slower, standing in for a
 * mid-range phone; there the limits are a regression guard (4 s), and real phones are timed in the
 * pilot. Each page is a cold
 * load (empty cache, no service worker) measured to the moment its heading shows and every API
 * call it makes has answered. Runs against the seeded dev database and the built app.
 */
const DEV = {
  employee: '00000000-0000-4000-8000-000000000101',
  manager: '00000000-0000-4000-8000-000000000102',
  // A different employee per project for check-in, so desktop and mobile don't share a day.
  checkIn: {
    desktop: '00000000-0000-4000-8000-000000000104',
    mobile: '00000000-0000-4000-8000-000000000106',
  },
};
const BUDGET = {
  'speed-desktop': { page: 2_000, checkIn: 3_000 },
  'speed-mobile': { page: 4_000, checkIn: 4_000 },
} as const;
const budget = (project: string) => BUDGET[project as keyof typeof BUDGET];
const OFFICE = { latitude: 13.0, longitude: 80.2 };

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

async function throttle(page: Page, phone: boolean) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  if (phone) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}

/**
 * Timed inside the page, from the browser's own navigation start, so the test's own work on a slowed
 * CPU doesn't count: when each h1 first appeared, and when the last API call answered.
 */
const RECORD_HEADINGS = () => {
  const seen: Record<string, number> = {};
  (window as unknown as { __h1: Record<string, number> }).__h1 = seen;
  new MutationObserver(() => {
    for (const h of document.querySelectorAll('h1')) {
      const text = h.textContent ?? '';
      if (!(text in seen)) seen[text] = performance.now();
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
};

/** Waits for the heading and for the API to go quiet, then returns the in-page load time. */
async function loadTime(page: Page, heading: string): Promise<number> {
  await page.waitForFunction(
    (h) => (window as unknown as { __h1: Record<string, number> }).__h1[h] !== undefined,
    heading,
    { polling: 250, timeout: 15_000 },
  );
  // Quiet: no API call started or still running in the last 500 ms.
  await page.waitForFunction(
    () => {
      const api = performance
        .getEntriesByType('resource')
        .filter((e) => new URL(e.name).pathname.startsWith('/api/')) as PerformanceResourceTiming[];
      const last = Math.max(0, ...api.map((e) => e.responseEnd));
      return api.every((e) => e.responseEnd > 0) && performance.now() - last > 500;
    },
    undefined,
    { polling: 250, timeout: 15_000 },
  );
  return page.evaluate((h) => {
    const shown = (window as unknown as { __h1: Record<string, number> }).__h1[h]!;
    const api = performance
      .getEntriesByType('resource')
      .filter((e) => new URL(e.name).pathname.startsWith('/api/')) as PerformanceResourceTiming[];
    return Math.round(Math.max(shown, ...api.map((e) => e.responseEnd)));
  }, heading);
}

const PAGES: { who: 'employee' | 'manager'; path: string; heading: string }[] = [
  { who: 'employee', path: '/', heading: 'Action inbox' },
  { who: 'employee', path: '/attendance', heading: 'My attendance' },
  { who: 'employee', path: '/leave', heading: 'My leave' },
  { who: 'employee', path: '/hybrid', heading: 'Plan my week' },
  { who: 'employee', path: '/journey', heading: 'My journey' },
  { who: 'employee', path: '/requests', heading: 'My requests' },
  { who: 'manager', path: '/', heading: 'Action inbox' },
  { who: 'manager', path: '/team-today', heading: 'Team today' },
  { who: 'manager', path: '/team-calendar', heading: 'Team calendar' },
  { who: 'manager', path: '/team-journeys', heading: 'Team journeys' },
];

for (const p of PAGES) {
  test(`${p.who} ${p.path} loads within budget on 4G`, async ({ page }, testInfo) => {
    await signInAs(page, DEV[p.who]);
    await throttle(page, testInfo.project.name === 'speed-mobile');
    await page.addInitScript(RECORD_HEADINGS);
    await page.goto(p.path);
    const ms = await loadTime(page, p.heading);
    testInfo.annotations.push({ type: 'load', description: `${p.path} ${ms} ms` });
    expect(ms, `${p.path} took ${ms} ms`).toBeLessThan(budget(testInfo.project.name).page);
  });
}

test('check-in completes within budget on 4G', async ({ page, context }, testInfo) => {
  const project = testInfo.project.name === 'speed-mobile' ? 'mobile' : 'desktop';
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(OFFICE);
  await signInAs(page, DEV.checkIn[project]);
  await page.goto('/');
  const card = page.getByRole('region', { name: /^Today/ });
  const button = card.getByRole('button', { name: 'Check in' });
  await expect(button.or(card.getByRole('button', { name: 'Check out' }))).toBeVisible();
  test.skip(!(await button.isVisible()), 'Already checked in today on this database');
  await throttle(page, project === 'mobile');
  await card.getByRole('radio', { name: 'Office' }).click();
  const start = Date.now();
  await button.click();
  await expect(card.getByRole('status')).toContainText('Checked in at', { timeout: 10_000 });
  const ms = Date.now() - start;
  testInfo.annotations.push({ type: 'check-in', description: `${ms} ms` });
  expect(ms, `check-in took ${ms} ms`).toBeLessThan(budget(testInfo.project.name).checkIn);
});

/**
 * The first download (the page's scripts, preloads and styles) stays under 130 KB gzipped: 115 KB
 * today, from 194 KB before 14b. A size check doesn't depend on the test machine's speed, so it catches
 * a screen or library slipping back into the first download (decision #97).
 */
test('the first download stays under 130 KB gzipped', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'speed-desktop', 'Same files for every device');
  const html = await (await page.request.get('/')).text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map(
    (m) => m[1]!,
  );
  expect(assets.length).toBeGreaterThan(1);
  let total = 0;
  for (const path of assets) total += gzipSync(await (await page.request.get(path)).body()).length;
  testInfo.annotations.push({
    type: 'first download',
    description: `${Math.round(total / 1024)} KB gzipped`,
  });
  expect(total).toBeLessThan(130 * 1024);
});
