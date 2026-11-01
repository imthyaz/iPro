import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

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

async function ok<T>(response: Awaited<ReturnType<APIRequestContext['post']>>): Promise<T> {
  expect(response.ok(), `${response.url()} → ${response.status()}`).toBe(true);
  return (response.status() === 204 ? undefined : await response.json()) as T;
}

const inDays = (days: number) => {
  const date = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
};

/**
 * Saves a template both projects use. Desktop and mobile run at once, so when the other saved the same
 * version a moment earlier, finding it there is enough.
 */
async function saveShared(api: APIRequestContext, kind: string, key: string, data: object) {
  const saved = await api.put(`/api/${kind}/${key}`, { data });
  if (saved.ok()) return;
  const list = (await (await api.get(`/api/${kind}`)).json()) as { key: string }[];
  expect(list.some((t) => t.key === key)).toBe(true);
}

/**
 * HR offers, the hiring manager approves and the candidate signs (through the development signer),
 * so a pre-joiner exists with a sign-in of their own (decisions #54, #55).
 */
async function preJoiner(page: Page, name: string, policyTitle: string): Promise<string> {
  const api = page.request;
  const run = `${Date.now()}`;
  await signInAs(page, DEV.admin);
  await saveShared(api, 'letter-templates', 'e2e_offer', {
    name: 'Offer letter (e2e)',
    type: 'offer',
    body: 'Dear {{person.legalName}}, welcome as {{assignment.designation}}.',
    approverRole: null,
    signature: 'employee',
  });
  await saveShared(api, 'checklist-templates', 'e2e_onboarding', {
    name: 'Onboarding (e2e)',
    stage: 'onboarding',
    appliesTo: {},
    tasks: [
      {
        title: 'Upload your PAN card',
        owner: { kind: 'employee' },
        dueOffsetDays: -2,
        mandatory: true,
        requiresDocument: true,
      },
    ],
  });
  const policy = await ok<{ policyId: string }>(
    await api.post('/api/policies', {
      data: {
        code: `E2E-OB-${run}`,
        title: policyTitle,
        appliesTo: {},
        requiresAcknowledgement: true,
      },
    }),
  );
  await ok(
    await api.post(`/api/policies/${policy.policyId}/versions`, {
      multipart: {
        effectiveFrom: inDays(0),
        file: {
          name: 'Leave policy.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from(`%PDF-1.4\n% synthetic ${run}\n`),
        },
      },
    }),
  );

  await signInAs(page, DEV.hr);
  const options = await ok<{
    legalEntities: { id: string }[];
    designations: { id: string; title: string }[];
    departments: { id: string; name: string }[];
    locations: { id: string; name: string }[];
    managers: { engagementId: string; name: string }[];
  }>(await api.get('/api/people/form-options'));
  const offer = await ok<{ id: string }>(
    await api.post('/api/offers', {
      data: {
        person: { legalName: name, personalEmail: `joiner.${run}@personal.test` },
        engagement: {
          legalEntityId: options.legalEntities[0]!.id,
          type: 'permanent',
          joiningDate: inDays(10),
        },
        assignment: {
          designationId: options.designations.find((d) => d.title === 'Software Engineer')!.id,
          departmentId: options.departments.find((d) => d.name === 'Engineering')!.id,
          locationId: options.locations.find((l) => l.name === 'Chennai office')!.id,
          managerEngagementId: options.managers.find((m) => m.name === 'Dev Manager')!.engagementId,
          bucket: 'billable',
        },
        compensation: { amount: '80000000', rateUnit: 'year' },
        letterTemplateKey: 'e2e_offer',
      },
    }),
  );
  const submitted = await ok<{ letter: { id: string }; person: { personId: string } }>(
    await api.post(`/api/offers/${offer.id}/submit`),
  );

  await signInAs(page, DEV.manager);
  const cards = await ok<{ approvalId: string; subject: { personId: string } }[]>(
    await api.get('/api/approvals'),
  );
  const card = cards.find((c) => c.subject.personId === submitted.person.personId)!;
  await ok(await api.post(`/api/approvals/${card.approvalId}/approve`, { data: {} }));

  await signInAs(page, DEV.hr);
  await ok(
    await api.post(`/api/letters/${submitted.letter.id}/fake-signer`, { data: { action: 'sign' } }),
  );
  // Locally the guest invitation is a dev sign-in user for the joiner.
  const users = await ok<{ id: string; displayName: string }[]>(
    await api.get('/api/auth/dev/users'),
  );
  return users.find((u) => u.displayName === name)!.id;
}

test('a new joiner completes KYC, a document task and a policy on the portal before Day 1', async ({
  page,
}, testInfo) => {
  const name = `Nila Joiner ${testInfo.project.name} ${Date.now()}`;
  const policyTitle = `Leave policy ${testInfo.project.name} ${Date.now()}`;
  const joinerId = await preJoiner(page, name, policyTitle);

  await signInAs(page, joinerId);
  await page.goto('/');
  await page.getByRole('link', { name: /Your onboarding/ }).click();
  await expect(page.getByRole('heading', { name: `Welcome, ${name}` })).toBeVisible();
  await expect(page.getByText('in 10 days')).toBeVisible();
  await expect(page.getByText('Dev Manager')).toBeVisible();

  // KYC detail (a synthetic PAN unique to this run), masked once saved.
  const digits = String(Date.now()).slice(-4);
  await page.getByLabel('Type').selectOption('pan');
  await page
    .getByLabel('Number')
    .fill(`ABCP${testInfo.project.name === 'mobile' ? 'M' : 'D'}${digits}K`);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`••••••${digits.slice(1)}K`)).toBeVisible();

  // The scan, then the task that needs it.
  await page.getByLabel('Title').fill('PAN card');
  await page.getByLabel('File').setInputFiles({
    name: 'pan.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% synthetic scan\n'),
  });
  await page.getByRole('button', { name: 'Upload' }).click();
  const task = page.getByRole('listitem', { name: 'Upload your PAN card' });
  await task.getByLabel('Document').selectOption({ label: 'PAN card (v1)' });
  await task.getByRole('button', { name: 'Mark done' }).click();
  await expect(task).toHaveCount(0);

  // The policy: opened before it can be accepted.
  const policy = page.getByRole('listitem', { name: policyTitle });
  await policy.getByRole('button', { name: /^Open / }).click();
  await policy.getByRole('checkbox').check();
  await policy.getByRole('button', { name: 'Accept' }).click();
  await expect(policy).toHaveCount(0);
  await expect(page.getByText(/Onboarding \(e2e\): 1 of 1 done/)).toBeVisible();
});
