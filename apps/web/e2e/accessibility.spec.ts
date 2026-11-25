import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Slice 14 done-when #3, accessibility (decision #97): employee and manager screens pass the
 * automated WCAG 2.1 A and AA checks (axe-core), on desktop and phone, in light and dark, including
 * the panels and forms they open. Automated checks catch about half of WCAG; the rest (keyboard
 * order, screen reader wording) is in the manual checklist in docs/accessibility.md.
 */
const DEV = {
  employee: '00000000-0000-4000-8000-000000000101',
  manager: '00000000-0000-4000-8000-000000000102',
};
const WCAG_21_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

/** Every violation, one line each, so a failure says what and where. */
async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(WCAG_21_AA).analyze();
  return result.violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${v.help}`),
  );
}

const SCREENS: {
  who: 'employee' | 'manager';
  path: string;
  heading: string;
  /** Opens a panel or form on the screen before checking. */
  open?: (page: Page) => Promise<void>;
  label?: string;
}[] = [
  { who: 'employee', path: '/', heading: 'Action inbox' },
  { who: 'employee', path: '/attendance', heading: 'My attendance' },
  { who: 'employee', path: '/leave', heading: 'My leave' },
  {
    who: 'employee',
    path: '/',
    heading: 'Action inbox',
    label: 'apply leave form',
    open: async (page) => {
      await page.getByRole('link', { name: /Apply leave/ }).click();
      await expect(page.getByRole('form', { name: 'Apply leave' })).toBeVisible();
    },
  },
  { who: 'employee', path: '/hybrid', heading: 'Plan my week' },
  { who: 'employee', path: '/journey', heading: 'My journey' },
  { who: 'employee', path: '/requests', heading: 'My requests' },
  { who: 'employee', path: '/notifications', heading: 'Notifications' },
  { who: 'employee', path: '/policies', heading: 'Policies' },
  {
    who: 'employee',
    path: '/',
    heading: 'Action inbox',
    label: 'Ask iPro panel',
    open: async (page) => {
      await page.getByRole('button', { name: 'Ask iPro' }).click();
      await expect(page.getByRole('complementary', { name: 'Ask iPro' })).toBeVisible();
    },
  },
  { who: 'manager', path: '/', heading: 'Action inbox' },
  { who: 'manager', path: '/team-today', heading: 'Team today' },
  { who: 'manager', path: '/team-calendar', heading: 'Team calendar' },
  { who: 'manager', path: '/team-journeys', heading: 'Team journeys' },
];

for (const s of SCREENS) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`${s.who} ${s.label ?? s.path} (${colorScheme}) passes WCAG 2.1 AA checks`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await signInAs(page, DEV[s.who]);
      await page.goto(s.path);
      await expect(page.getByRole('heading', { name: s.heading, level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      if (s.open) await s.open(page);
      expect(await violations(page)).toEqual([]);
    });
  }
}
