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

/** A joining date whose six-month probation ends in about two weeks. */
function joiningForProbationEndingSoon(): string {
  const date = new Date();
  date.setMonth(date.getMonth() - 6);
  date.setDate(date.getDate() + 15);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
}

test('the manager writes a probation review on their phone; HR confirms it on the card', async ({
  page,
}, testInfo) => {
  const name = `Priya Probation ${testInfo.project.name} ${Date.now()}`;

  // Someone on probation who reports to Dev Manager, and the daily sweep run now.
  await signInAs(page, DEV.hr);
  const options = await (await page.request.get('/api/people/form-options')).json();
  const created = await page.request.post('/api/people', {
    data: {
      person: { legalName: name },
      engagement: {
        legalEntityId: options.legalEntities[0].id,
        type: 'permanent',
        joiningDate: joiningForProbationEndingSoon(),
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

  // M5: from the inbox to the form, one tap per rating.
  await signInAs(page, DEV.manager);
  await page.goto('/');
  const card = page.getByRole('listitem', { name: `Probation review: ${name}` });
  await card.getByRole('link', { name: 'Write the review' }).click();
  const review = page.getByRole('complementary', { name: 'Review' });
  for (const [area, rating] of [
    ['Quality of work', '4'],
    ['Ownership', '4'],
    ['Collaboration', '5'],
    ['Learning', '3'],
  ] as const) {
    await review.getByRole('group', { name: area }).getByLabel(rating, { exact: true }).check();
  }
  await review.getByLabel('Strengths').fill('Took ownership of the reports module');
  await review.getByLabel('Comments').fill('Ready to confirm');
  await review.getByRole('button', { name: 'Send to HR' }).click();
  await expect(review.getByText('Waiting for HR')).toBeVisible();

  // HR decides on the card: the recommendation and ratings are on it.
  await signInAs(page, DEV.hr);
  await page.goto('/');
  const decision = page
    .getByRole('list', { name: 'Approvals' })
    .getByRole('listitem')
    .filter({ hasText: `Probation: ${name}` });
  await expect(
    decision.getByText('Quality of work 4/5, Ownership 4/5, Collaboration 5/5, Learning 3/5'),
  ).toBeVisible();
  await decision.getByRole('button', { name: 'Approve' }).click();
  await expect(decision).toHaveCount(0);

  await page.goto('/probation');
  await expect(page.getByRole('heading', { name: 'Probation' })).toBeVisible();
});
