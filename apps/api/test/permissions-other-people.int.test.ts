import type { INestApplication } from '@nestjs/common';
import type { ApprovalCard, NotificationView, WorkflowView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

/**
 * Slice 14 done-when #1, for the routes open to any signed-in user (decision #96): each acts only
 * on the caller's own items, so someone else's workflow, approval or notification is refused and
 * stays as it was. Synthetic people only.
 */
const U = {
  admin: '00000000-0000-4000-8000-000000714101',
  hr: '00000000-0000-4000-8000-000000714102',
  lead: '00000000-0000-4000-8000-000000714103',
  emp: '00000000-0000-4000-8000-000000714104',
  // A manager and employee with no link to emp or lead.
  other: '00000000-0000-4000-8000-000000714105',
};
const email = (id: string) => `${id}@test.ipro.test`;

const { pool, db } = testDb();
let app: INestApplication;
let org: ReturnType<typeof seedOrgIds>;
const people: Record<string, { personId: string; engagementId: string }> = {};
const agents: Record<string, ReturnType<typeof as>> = {};
let item: WorkflowView;
let card: ApprovalCard;

const person = (legalName: string, workEmail: string, manager?: string) => ({
  person: { legalName, phone: '+910000000001' },
  engagement: {
    legalEntityId: org.legalEntity,
    type: 'permanent',
    workEmail,
    joiningDate: '2025-01-06',
  },
  assignment: {
    designationId: org.softwareEngineer,
    departmentId: org.engineering,
    locationId: org.chennai,
    managerEngagementId: manager,
    bucket: 'billable',
  },
});

const workflow = async (who: string) =>
  (await agents[who]!.get(`/api/workflows/${item.id}`).expect(200)).body as WorkflowView;

beforeAll(async () => {
  const tenant = await newTenant(pool, 'Permissions: other people');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Po Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Po HR', ['employee', 'hr']);
  await addUser(db, tenant, U.lead, 'Po Lead', ['employee', 'manager']);
  await addUser(db, tenant, U.emp, 'Po Employee', ['employee']);
  await addUser(db, tenant, U.other, 'Po Other', ['employee', 'manager']);
  app = await createTestApp({ TENANT_ID: tenant });
  const hr = as(app, await signIn(app, U.hr));
  people.lead = (
    await hr.post('/api/people', person('Lalit Lead', email(U.lead))).expect(201)
  ).body;
  people.emp = (
    await hr
      .post('/api/people', person('Esha Employee', email(U.emp), people.lead!.engagementId))
      .expect(201)
  ).body;
  people.other = (
    await hr.post('/api/people', person('Oviya Other', email(U.other))).expect(201)
  ).body;
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  await agents
    .admin!.put('/api/workflow-definitions/equipment', {
      name: 'Equipment request',
      steps: [
        {
          id: 'manager',
          label: 'Manager approval',
          approver: { kind: 'manager' },
          authorize: { area: 'leave', action: 'approve' },
        },
      ],
      onApproved: 'none',
    })
    .expect(200);
  item = (
    await agents
      .emp!.post('/api/workflows', {
        key: 'equipment',
        subjectPersonId: people.emp!.personId,
        title: 'New laptop',
        payload: {},
      })
      .expect(201)
  ).body;
  const cards = (await agents.lead!.get('/api/approvals').expect(200)).body as ApprovalCard[];
  card = cards.find((c) => c.instanceId === item.id)!;
  expect(card).toBeDefined();
}, 120_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('someone else’s items (slice 14 done-when #1; decision #96)', () => {
  it('cannot read, comment on, withdraw or resubmit someone else’s request', async () => {
    const other = agents.other!;
    expect((await other.get(`/api/workflows/${item.id}`)).status).toBe(403);
    expect(
      (await other.post(`/api/workflows/${item.id}/comments`, { body: 'Hello' })).status,
    ).toBeGreaterThanOrEqual(403);
    expect((await other.post(`/api/workflows/${item.id}/withdraw`)).status).toBeGreaterThanOrEqual(
      403,
    );
    expect(
      (await other.post(`/api/workflows/${item.id}/resubmit`, { payload: {} })).status,
    ).toBeGreaterThanOrEqual(403);
    expect((await workflow('emp')).status).toBe('pending');
    expect((await other.get('/api/workflows')).body).not.toContainEqual(
      expect.objectContaining({ id: item.id }),
    );
  });

  it('cannot approve, reject or bulk-approve an approval that isn’t theirs', async () => {
    for (const who of ['other', 'emp', 'hr']) {
      const a = agents[who]!;
      expect((await a.post(`/api/approvals/${card.approvalId}/approve`, {})).status).toBe(403);
      expect(
        (await a.post(`/api/approvals/${card.approvalId}/reject`, { comment: 'No' })).status,
      ).toBe(403);
      await a.post('/api/approvals/bulk-approve', { approvalIds: [card.approvalId] });
      const theirs = (await a.get('/api/approvals').expect(200)).body as ApprovalCard[];
      expect(theirs.map((c) => c.approvalId)).not.toContain(card.approvalId);
    }
    expect((await workflow('emp')).status).toBe('pending');
  });

  it('cannot mark someone else’s notification read', async () => {
    const [note] = (await agents.lead!.get('/api/notifications').expect(200))
      .body as NotificationView[];
    expect(note).toBeDefined();
    expect(note!.read).toBe(false);
    // Scoped to the caller's own notifications: a no-op that doesn't reveal the id exists.
    await agents.other!.post(`/api/notifications/${note!.id}/read`).expect(204);
    await agents.other!.post('/api/notifications/read-all');
    const after = (await agents.lead!.get('/api/notifications').expect(200))
      .body as NotificationView[];
    expect(after.find((n) => n.id === note!.id)!.read).toBe(false);
  });

  it('the right approver still can (the refusals above are not a blanket deny)', async () => {
    await agents.lead!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(201);
    expect((await workflow('emp')).status).toBe('approved');
  });
});
