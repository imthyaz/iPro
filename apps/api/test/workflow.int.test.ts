import type { INestApplication } from '@nestjs/common';
import type { ApprovalCard, NotificationView, WorkflowView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { WorkflowService } from '../src/workflow/workflow.service.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only.
const U = {
  admin: '00000000-0000-4000-8000-00000000f001',
  hr: '00000000-0000-4000-8000-00000000f002',
  hrHead: '00000000-0000-4000-8000-00000000f003',
  boss: '00000000-0000-4000-8000-00000000f004',
  lead: '00000000-0000-4000-8000-00000000f005',
  lead2: '00000000-0000-4000-8000-00000000f006',
  emp: '00000000-0000-4000-8000-00000000f007',
};
const email = (id: string) => `${id}@test.ipro.test`;

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const people: Record<string, { personId: string; engagementId: string }> = {};
const agents: Record<string, ReturnType<typeof as>> = {};
const today = businessDate(new Date());

/** A configured two-step workflow with no side effect: the team manager, then HR head. */
const twoStep = {
  name: 'Equipment request',
  steps: [
    {
      id: 'manager',
      label: 'Manager approval',
      approver: { kind: 'manager' },
      authorize: { area: 'leave', action: 'approve' },
    },
    {
      id: 'hr_head',
      label: 'HR head approval',
      approver: { kind: 'role', role: 'hr_head' },
      authorize: { area: 'assignment_history', action: 'approve' },
    },
  ],
  onApproved: 'none',
};

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

const cards = async (who: string) =>
  (await agents[who]!.get('/api/approvals').expect(200)).body as ApprovalCard[];
const cardFor = async (who: string, instanceId: string) =>
  (await cards(who)).find((c) => c.instanceId === instanceId);
const submit = async (title: string) =>
  (
    await agents
      .emp!.post('/api/workflows', {
        key: 'equipment',
        subjectPersonId: people.emp!.personId,
        title,
        payload: {},
      })
      .expect(201)
  ).body as WorkflowView;

beforeAll(async () => {
  tenant = await newTenant(pool, 'Workflow tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Wf Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Wf HR', ['employee', 'hr']);
  await addUser(db, tenant, U.hrHead, 'Wf HR Head', ['employee', 'hr_head']);
  await addUser(db, tenant, U.boss, 'Wf Boss', ['employee', 'manager']);
  await addUser(db, tenant, U.lead, 'Wf Lead', ['employee', 'manager']);
  await addUser(db, tenant, U.lead2, 'Wf Lead Two', ['employee', 'manager']);
  await addUser(db, tenant, U.emp, 'Wf Employee', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  people.boss = (
    await agents.hr!.post('/api/people', person('Bina Boss', email(U.boss))).expect(201)
  ).body;
  people.lead = (
    await agents
      .hr!.post('/api/people', person('Lalit Lead', email(U.lead), people.boss!.engagementId))
      .expect(201)
  ).body;
  people.lead2 = (
    await agents.hr!.post('/api/people', person('Lata Leadtwo', email(U.lead2))).expect(201)
  ).body;
  people.emp = (
    await agents
      .hr!.post('/api/people', person('Esha Employee', email(U.emp), people.lead!.engagementId))
      .expect(201)
  ).body;
  // Sign in again so each session picks up the person link.
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  await agents.admin!.put('/api/workflow-definitions/equipment', twoStep).expect(200);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('a workflow defined in config (done-when #1)', () => {
  it('refuses definitions with unknown actions or permissions', async () => {
    await agents
      .admin!.put('/api/workflow-definitions/bad', { ...twoStep, onApproved: 'launch.rockets' })
      .expect(400);
    const badStep = {
      ...twoStep,
      steps: [{ ...twoStep.steps[0], authorize: { area: 'salary', action: 'read' } }],
    };
    await agents.admin!.put('/api/workflow-definitions/bad', badStep).expect(400);
    await agents.hr!.put('/api/workflow-definitions/bad', twoStep).expect(403);
  });

  it('runs end to end: return with a required comment, resubmit, approve twice', async () => {
    const item = await submit('New laptop');
    expect(item).toMatchObject({ status: 'pending', subject: { name: 'Esha Employee' } });
    expect(item.steps).toMatchObject([
      { label: 'Manager approval', assignedTo: 'Wf Lead', decision: null },
    ]);

    // Only the subject's manager sees the first step; the submitter can't approve.
    const card = await cardFor('lead', item.id);
    expect(card).toMatchObject({
      stepLabel: 'Manager approval',
      subject: { name: 'Esha Employee' },
      overdue: false,
    });
    expect(await cardFor('hrHead', item.id)).toBeUndefined();
    await agents.emp!.post(`/api/approvals/${card!.approvalId}/approve`, {}).expect(403);

    // Returning needs a comment (API and database).
    await agents
      .lead!.post(`/api/approvals/${card!.approvalId}/reject`, { comment: '  ' })
      .expect(400);
    const returned = (
      await agents
        .lead!.post(`/api/approvals/${card!.approvalId}/reject`, { comment: 'Which model?' })
        .expect(201)
    ).body as WorkflowView;
    expect(returned).toMatchObject({ status: 'returned', canResubmit: false });
    const notes = (await agents.emp!.get('/api/notifications').expect(200))
      .body as NotificationView[];
    expect(
      notes.some((n) => n.kind === 'workflow_returned' && n.title === 'Returned: New laptop'),
    ).toBe(true);

    const again = (await agents.emp!.post(`/api/workflows/${item.id}/resubmit`, {}).expect(201))
      .body as WorkflowView;
    expect(again.status).toBe('pending');
    const second = await cardFor('lead', item.id);
    await agents
      .lead!.post(`/api/approvals/${second!.approvalId}/approve`, { comment: 'OK' })
      .expect(201);

    const third = await cardFor('hrHead', item.id);
    expect(third).toMatchObject({ stepLabel: 'HR head approval' });
    const done = (
      await agents.hrHead!.post(`/api/approvals/${third!.approvalId}/approve`, {}).expect(201)
    ).body as WorkflowView;
    expect(done.status).toBe('approved');
    expect(done.completedAt).not.toBeNull();
    expect(done.steps.map((s) => [s.label, s.decision, s.comment])).toEqual([
      ['Manager approval', 'rejected', 'Which model?'],
      ['Manager approval', 'approved', 'OK'],
      ['HR head approval', 'approved', null],
    ]);
    const { rows } = await pool.query(
      `select count(*)::int as n from audit_log where table_name in ('approval', 'workflow_instance') and record_id in
       (select id from approval where instance_id = $1 union select $1)`,
      [item.id],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(7);
  });

  it('escalates an overdue step to the approver’s manager, who can then decide', async () => {
    const item = await submit('Second monitor');
    const service = app.get(WorkflowService);
    // 10 days on, the 3-working-day window has passed.
    const result = await runWithContext({ tenantId: tenant }, () =>
      service.sweep(addDays(today, 10)),
    );
    expect(result.escalated).toBeGreaterThanOrEqual(1);
    const card = await cardFor('boss', item.id);
    // Escalated by the sweep run 10 days ahead; the card's overdue flag uses the real date.
    expect(card).toMatchObject({ escalated: true });
    const view = (await agents.emp!.get(`/api/workflows/${item.id}`).expect(200))
      .body as WorkflowView;
    expect(view.steps[0]).toMatchObject({ assignedTo: 'Wf Lead', escalatedTo: 'Wf Boss' });
    const leadNotes = (await agents.lead!.get('/api/notifications').expect(200))
      .body as NotificationView[];
    expect(
      leadNotes.some(
        (n) => n.kind === 'approval_reminder' && n.title === 'Reminder: Second monitor',
      ),
    ).toBe(true);
    // Running the sweep again changes nothing.
    await runWithContext({ tenantId: tenant }, () => service.sweep(addDays(today, 10)));
    expect(
      (
        await pool.query(
          `select count(*)::int as n from notification where kind = 'approval_escalated' and title like '%Second monitor'`,
        )
      ).rows[0].n,
    ).toBe(1);
    await agents.boss!.post(`/api/approvals/${card!.approvalId}/approve`, {}).expect(201);
    expect(await cardFor('hrHead', item.id)).toBeDefined();
  });

  it('a delegate decides on behalf of the manager on leave', async () => {
    await agents
      .lead!.post('/api/delegations', {
        delegateUserId: U.lead2,
        startsOn: today,
        endsOn: addDays(today, 5),
        reason: 'On leave',
      })
      .expect(201);
    const item = await submit('Headset');
    const card = await cardFor('lead2', item.id);
    expect(card).toMatchObject({ onBehalfOf: 'Wf Lead' });
    const after = (
      await agents.lead2!.post(`/api/approvals/${card!.approvalId}/approve`, {}).expect(201)
    ).body as WorkflowView;
    expect(after.steps[0]).toMatchObject({
      decision: 'approved',
      decidedBy: 'Wf Lead Two',
      onBehalfOf: 'Wf Lead',
    });
  });

  it('a running item keeps the version it started under', async () => {
    const item = await submit('Desk lamp');
    await agents
      .admin!.put('/api/workflow-definitions/equipment', {
        ...twoStep,
        steps: [{ ...twoStep.steps[1], label: 'Only HR head' }],
      })
      .expect(200);
    const view = (await agents.emp!.get(`/api/workflows/${item.id}`).expect(200))
      .body as WorkflowView;
    expect(view.steps[0]!.label).toBe('Manager approval');
    const next = await submit('Desk lamp two');
    expect(next.steps[0]!.label).toBe('Only HR head');
  });

  it('the submitter can withdraw; others cannot', async () => {
    const item = await submit('Chair');
    await agents.lead!.post(`/api/workflows/${item.id}/withdraw`).expect(403);
    const withdrawn = (await agents.emp!.post(`/api/workflows/${item.id}/withdraw`).expect(201))
      .body as WorkflowView;
    expect(withdrawn.status).toBe('withdrawn');
    expect(await cardFor('hrHead', item.id)).toBeUndefined();
  });
});

describe('profile change requests', () => {
  it('an employee’s change goes to HR, who sees from → to on the card; HR changes directly', async () => {
    const request = (
      await agents
        .emp!.patch(`/api/people/${people.emp!.personId}/profile`, { phone: '+919999999999' })
        .expect(200)
    ).body as { requestId: string };
    expect(request.requestId).toBeDefined();
    const card = await cardFor('hr', request.requestId);
    expect(card!.changes).toEqual([{ label: 'Phone', from: '+910000000001', to: '+919999999999' }]);
    await agents.hr!.post(`/api/approvals/${card!.approvalId}/approve`, {}).expect(201);
    const after = await agents.hr!.get(`/api/people/${people.emp!.personId}`).expect(200);
    expect(after.body.profile.phone).toBe('+919999999999');

    expect(
      (
        await agents
          .hr!.patch(`/api/people/${people.emp!.personId}/profile`, { nationality: 'Indian' })
          .expect(200)
      ).body,
    ).toEqual({
      applied: true,
    });
    await agents
      .lead!.patch(`/api/people/${people.emp!.personId}/profile`, { phone: '+911111111' })
      .expect(403);
  });
});

describe('shift change requests (decision #47)', () => {
  it('a manager requests a team member’s shift change; HR approves and it applies', async () => {
    const from = addDays(today, 14);
    const request = (
      await agents
        .lead!.post('/api/shifts/change-requests', {
          personIds: [people.emp!.personId],
          shiftId: org.middleEastShift,
          effectiveFrom: from,
          startTime: '11:00',
          endTime: '20:00',
          reason: 'Gulf customer project (synthetic)',
        })
        .expect(201)
    ).body as { requestIds: string[] };
    const card = await cardFor('hr', request.requestIds[0]!);
    expect(card!.changes.map((c) => [c.label, c.from, c.to])).toEqual([
      ['Shift', 'General (Mon–Fri)', 'Middle East (Sun–Thu)'],
      ['Working week', 'Mon–Fri', 'Sun–Thu'],
      ['Hours', '09:30–18:30', '11:00–20:00'],
      ['From', null, from],
      ['Reason', null, 'Gulf customer project (synthetic)'],
    ]);
    await agents.hr!.post(`/api/approvals/${card!.approvalId}/approve`, {}).expect(201);
    const day = (
      await agents
        .hr!.get(`/api/people/${people.emp!.personId}/working-days?from=${from}&to=${from}`)
        .expect(200)
    ).body[0];
    expect(day).toMatchObject({ shiftCode: 'ME', startTime: '11:00', endTime: '20:00' });
    const journey = (
      await agents.hr!.get(`/api/people/${people.emp!.personId}/journey`).expect(200)
    ).body;
    expect(journey.some((e: { eventType: string }) => e.eventType === 'shift_changed')).toBe(true);
  });

  it('a manager cannot request changes for someone outside their team', async () => {
    await agents
      .lead!.post('/api/shifts/change-requests', {
        personIds: [people.lead2!.personId],
        shiftId: org.middleEastShift,
        effectiveFrom: addDays(today, 20),
        reason: 'not my team',
      })
      .expect(403);
  });
});
