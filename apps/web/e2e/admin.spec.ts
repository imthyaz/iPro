import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic users and people from `pnpm db:seed`).
const DEV = {
  manager: '00000000-0000-4000-8000-000000000102',
  managerTwo: '00000000-0000-4000-8000-000000000103',
  hr: '00000000-0000-4000-8000-000000000104',
  admin: '00000000-0000-4000-8000-000000000107',
};

/** Desktop and mobile run in parallel, so each works on a different synthetic person. */
const subject = (project: string) =>
  project === 'mobile'
    ? { name: 'Chitra Synthetic', manager: DEV.managerTwo }
    : { name: 'Bala Synthetic', manager: DEV.manager };

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

async function openPerson(page: Page, name: string) {
  await page.goto('/people');
  await page.getByLabel('Search').fill(name);
  await page.getByRole('link', { name: new RegExp(name) }).click();
  return page.getByRole('complementary', { name: 'Person record' });
}

test('admin saves a letter template (unknown fields refused); HR generates a letter from it', async ({
  page,
}, testInfo) => {
  const key = `e2e_${testInfo.project.name}_${Date.now()}`;
  const name = `Address proof ${key}`;
  await signInAs(page, DEV.admin);
  await page.goto('/templates/letters');
  await page.getByRole('link', { name: 'New letter' }).click();
  const editor = page.getByRole('complementary', { name: 'Template' });
  await editor.getByLabel('Key').fill(key);
  await editor.getByLabel('Name').fill(name);
  await editor.getByLabel('Letter text').fill('Salary: {{person.salary}}');
  await editor.getByRole('button', { name: 'Save template' }).click();
  await expect(editor.getByText(/Unknown field \{\{person\.salary\}\}/)).toBeVisible();

  await editor
    .getByLabel('Letter text')
    .fill(
      '# To whom it may concern\n\nThis confirms that  works with us until {{extra.validUntil}}.',
    );
  // Insert a field at the cursor, as an admin would.
  await editor.getByLabel('Letter text').evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    const at = el.value.indexOf('that ') + 5;
    el.setSelectionRange(at, at);
  });
  await editor.getByRole('button', { name: '{{person.legalName}}' }).click();
  await expect(editor.getByLabel('Letter text')).toHaveValue(
    /that \{\{person\.legalName\}\} works/,
  );
  await editor.getByRole('button', { name: 'Save template' }).click();
  await expect(editor.getByText(/^Version 1. Saving makes version 2/)).toBeVisible();

  await signInAs(page, DEV.hr);
  const record = await openPerson(page, subject(testInfo.project.name).name);
  await record.getByRole('tab', { name: 'Letters' }).click();
  await record.getByLabel('New letter from template').selectOption({ label: name });
  await record.getByLabel('Valid Until').fill('31 Mar 2027');
  await record.getByRole('button', { name: 'Generate letter' }).click();
  const letter = record.getByRole('listitem').filter({ hasText: name });
  await expect(letter.getByText('Ready')).toBeVisible();
});

test('admin publishes a policy; HR sees who is pending', async ({ page }, testInfo) => {
  const code = `E2E-${testInfo.project.name}-${Date.now()}`;
  const title = `Travel policy ${code}`;
  await signInAs(page, DEV.admin);
  await page.goto('/policy-admin');
  await page.getByRole('button', { name: 'New policy' }).click();
  await page.getByLabel('Code').fill(code);
  await page.getByLabel('Title').fill(title);
  await page.getByRole('checkbox', { name: 'permanent' }).check();
  await page.getByRole('button', { name: 'Create policy' }).click();

  const detail = page.getByRole('complementary', { name: 'Policy' });
  await expect(detail.getByRole('heading', { name: title })).toBeVisible();
  await expect(detail.getByText(/applies to permanent/)).toBeVisible();
  await detail.getByLabel('PDF').setInputFiles({
    name: 'Travel.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(`%PDF-1.4\n% synthetic ${code}\n`),
  });
  await detail.getByRole('button', { name: 'Publish' }).click();
  await expect(detail.getByText(/Version 1 · in force from/)).toBeVisible();
  const url = page.url();

  await signInAs(page, DEV.hr);
  await page.goto(url);
  const pending = page
    .getByRole('complementary', { name: 'Policy' })
    .getByRole('list', { name: 'Pending' });
  await expect(pending.getByRole('link', { name: 'Dev Employee' })).toBeVisible();
});

test('a manager asks HR to move a team member to another shift', async ({ page }, testInfo) => {
  const who = subject(testInfo.project.name);
  await signInAs(page, who.manager);
  await page.goto('/shifts');
  await page.getByRole('tab', { name: 'Request a change' }).click();
  await page.getByLabel('Find people').fill(who.name);
  await page.getByRole('checkbox', { name: new RegExp(who.name) }).check();
  const shift = page.getByLabel('Shift', { exact: true });
  const middleEast = await shift
    .locator('option', { hasText: 'Middle East' })
    .getAttribute('value');
  await shift.selectOption(middleEast!);
  await page.getByLabel('Reason').fill('Customer project in Dubai');
  await page.getByRole('button', { name: 'Send to HR' }).click();
  await expect(page.getByText('Sent to HR: 1 request.')).toBeVisible();

  await page.goto('/requests');
  await expect(
    page.getByRole('link', { name: new RegExp(`Shift change: ${who.name} → Middle East`) }).first(),
  ).toBeVisible();
});
