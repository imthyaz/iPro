import { expect, test, type Page } from '@playwright/test';
import { policyDocx } from '../../api/test/docx.js';

// Runs against the seeded dev database with the scripted model, which answers policy questions by
// searching the policy clauses and quoting the best match. Synthetic policy text only.
const DEV = {
  employee: '00000000-0000-4000-8000-000000000101',
  admin: '00000000-0000-4000-8000-000000000107',
};

async function signInAs(page: Page, userId: string) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  const response = await page.request.post('/api/auth/dev/login', { data: { userId } });
  expect(response.status()).toBe(204);
}

test('a policy answer quotes the clause and links to it in the policy', async ({
  page,
}, testInfo) => {
  // Desktop and mobile run at once: each publishes its own policy with its own team word.
  const team = `${testInfo.project.name}${Date.now()}`;
  await signInAs(page, DEV.admin);
  const created = await page.request.post('/api/policies', {
    data: {
      code: `NOTICE-${team}`.toUpperCase().slice(0, 30),
      title: `Notice policy ${team}`,
      appliesTo: {},
      requiresAcknowledgement: false,
    },
  });
  expect(created.status()).toBe(201);
  const { policyId } = (await created.json()) as { policyId: string };
  const published = await page.request.post(`/api/policies/${policyId}/versions`, {
    multipart: {
      effectiveFrom: '2026-01-01',
      file: {
        name: 'Notice policy.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: policyDocx([
          `Notice policy ${team}`,
          '1. Scope. This policy covers resignations.',
          `2. Notice period. Leads in ${team} serve 60 days of notice.`,
        ]),
      },
    },
  });
  expect(published.status()).toBe(201);
  expect((await published.json()).current).toMatchObject({ textStatus: 'ready', clauseCount: 3 });

  await signInAs(page, DEV.employee);
  await page.goto('/');
  await page.getByRole('button', { name: 'Ask iPro' }).click();
  const panel = page.getByRole('complementary', { name: 'Ask iPro' });
  await panel.getByLabel('Your question').fill(`What is the notice period for leads in ${team}?`);
  await panel.getByRole('button', { name: 'Ask', exact: true }).click();
  const thread = panel.getByRole('log', { name: 'Conversation' });
  await expect(thread).toContainText(`Leads in ${team} serve 60 days of notice.`);

  await thread.getByRole('link', { name: `Notice policy ${team} 2: Notice period` }).click();
  await expect(page).toHaveURL(new RegExp(`/policies\\?policy=${policyId}&clause=\\d+`));
  const clause = page.getByRole('list', { name: 'Clauses' }).locator('[aria-current="true"]');
  await expect(clause).toContainText(`Leads in ${team} serve 60 days of notice.`);
});
