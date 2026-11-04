import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic users and people from `pnpm db:seed`).
const DEV = {
  manager: '00000000-0000-4000-8000-000000000102',
  hr: '00000000-0000-4000-8000-000000000104',
  admin: '00000000-0000-4000-8000-000000000107',
};

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

/** Two months ago today, in India: this month's check-in is due today. */
function twoMonthsAgo(): string {
  const date = new Date();
  date.setMonth(date.getMonth() - 2);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
}

test('the manager records a monthly probation check-in from the inbox', async ({
  page,
}, testInfo) => {
  const name = `Meera Monthly ${testInfo.project.name} ${Date.now()}`;
  await signInAs(page, DEV.hr);
  const options = await (await page.request.get('/api/people/form-options')).json();
  const created = await page.request.post('/api/people', {
    data: {
      person: { legalName: name },
      engagement: {
        legalEntityId: options.legalEntities[0].id,
        type: 'permanent',
        joiningDate: twoMonthsAgo(),
      },
      assignment: {
        designationId: options.designations.find(
          (d: { title: string }) => d.title === 'Software Engineer',
        ).id,
        departmentId: options.departments.find((d: { name: string }) => d.name === 'Engineering')
          .id,
        locationId: options.locations.find((l: { name: string }) => l.name === 'Chennai office').id,
        managerEngagementId: options.managers.find(
          (m: { name: string }) => m.name === 'Dev Manager',
        ).engagementId,
        bucket: 'billable',
      },
    },
  });
  expect(created.status()).toBe(201);
  await signInAs(page, DEV.admin);
  expect((await page.request.post('/api/jobs/probation-sweep/run')).status()).toBe(201);

  await signInAs(page, DEV.manager);
  await page.goto('/');
  const card = page.getByRole('listitem', { name: `Check-in: ${name}` });
  await expect(card.getByText(`Month 2 check-in: ${name}`)).toBeVisible();
  await card.getByLabel('On track').check();
  await card.getByLabel('Notes').fill('Settled in; owns the release notes');
  await card.getByRole('button', { name: 'Record check-in' }).click();
  await expect(card).toHaveCount(0);
});
