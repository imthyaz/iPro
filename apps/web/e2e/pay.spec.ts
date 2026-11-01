import { expect, test, type Page } from '@playwright/test';

// Runs against the seeded dev database (synthetic users and people from `pnpm db:seed`).
const DEV = {
  hr: '00000000-0000-4000-8000-000000000104',
  hrHead: '00000000-0000-4000-8000-000000000105',
};

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

test('an unpaid intern becomes paid: HR asks on the Pay tab; HR head approves on the card', async ({
  page,
}, testInfo) => {
  const name = `Uma Intern ${testInfo.project.name} ${Date.now()}`;
  await signInAs(page, DEV.hr);
  const options = await (await page.request.get('/api/people/form-options')).json();
  const created = await page.request.post('/api/people', {
    data: {
      person: { legalName: name },
      engagement: {
        legalEntityId: options.legalEntities[0].id,
        type: 'intern',
        joiningDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
          new Date(),
        ),
      },
      assignment: {
        designationId: options.designations.find(
          (d: { title: string }) => d.title === 'Software Engineer',
        ).id,
        departmentId: options.departments.find((d: { name: string }) => d.name === 'Engineering')
          .id,
        locationId: options.locations.find((l: { name: string }) => l.name === 'Chennai office').id,
        bucket: 'trainee',
      },
    },
  });
  expect(created.status()).toBe(201);
  const { personId } = await created.json();

  await page.goto(`/people/${personId}`);
  const record = page.getByRole('complementary', { name: 'Person record' });
  await record.getByRole('tab', { name: 'Pay' }).click();
  await record.getByRole('button', { name: 'Change pay…' }).click();
  await record.getByLabel('Reason').fill('Stipend');
  await record.getByLabel('Paid per').selectOption('month');
  await record.getByLabel('Amount (₹)').fill('15,000');
  await record.getByRole('button', { name: 'Send for approval' }).click();
  await expect(record.getByText('Sent for approval.')).toBeVisible();

  await signInAs(page, DEV.hrHead);
  await page.goto('/');
  const card = page
    .getByRole('list', { name: 'Approvals' })
    .getByRole('listitem')
    .filter({ hasText: name });
  await expect(card.getByText('Unpaid')).toBeVisible();
  await expect(card.getByText('₹15,000 a month')).toBeVisible();
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0);

  await page.goto(`/people/${personId}`);
  await record.getByRole('tab', { name: 'Journey' }).click();
  await expect(record.getByText('Became paid')).toBeVisible();
});
