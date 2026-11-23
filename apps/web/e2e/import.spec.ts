import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database. Synthetic rows as an old system's export would have them;
// MIG- codes stay clear of iPro's own IDS- sequence. A6 is a desktop screen.
const DEV = { hrHead: '00000000-0000-4000-8000-000000000105' };

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

const HEADER =
  'employee_code,legal_name,work_email,engagement_type,joining_date,status,designation,department,location,manager_code,bucket';
const row = (code: string, joining: string, manager = '') =>
  `${code},Migrated ${code},${code.toLowerCase()}@old.test,permanent,${joining},active,Software Engineer,Engineering,Chennai office,${manager},billable`;

test('HR head checks a file, fixes it, then loads it; nothing loads while errors remain', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'A6 is a desktop screen');
  await signInAs(page, DEV.hrHead);
  await page.goto('/');
  await page.getByRole('link', { name: 'Import people' }).click();
  await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible();

  const file = page.getByLabel('CSV file');
  const result = page.getByRole('status', { name: 'Result' });
  await file.setInputFiles({
    name: 'people.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        HEADER,
        row('MIG-7001', '2024-01-08'),
        row('MIG-7002', '2024-02-30'),
        row('MIG-7003', '2024-03-04', 'MIG-9999'),
      ].join('\n'),
    ),
  });
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(result).toContainText('Nothing was loaded');
  const errors = page.getByRole('table', { name: 'Errors' });
  await expect(errors).toContainText("joining_date 2024-02-30 isn't a real date");
  await expect(errors).toContainText("Manager MIG-9999 isn't in the file or in iPro");
  await expect(page.getByRole('button', { name: /^Load/ })).toBeDisabled();

  await file.setInputFiles({
    name: 'people.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [HEADER, row('MIG-7002', '2024-02-28', 'MIG-7001'), row('MIG-7001', '2024-01-08')].join('\n'),
    ),
  });
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(result).toContainText('2 of 2 rows are ready to load');
  await page.getByRole('button', { name: 'Load 2 rows' }).click();
  await expect(result).toContainText('Loaded 2 of 2 rows');

  const people = (await (await page.request.get('/api/people?q=Migrated MIG-7002')).json()) as {
    employeeCode: string;
    manager: { name: string } | null;
  }[];
  expect(people.map((p) => [p.employeeCode, p.manager?.name])).toEqual([
    ['MIG-7002', 'Migrated MIG-7001'],
  ]);
});
