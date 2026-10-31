import type { INestApplication } from '@nestjs/common';
import type { ChecklistRunView, MyTaskView, NotificationView } from '@ipro/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { ChecklistsService } from '../src/workflow/checklists.service.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only.
const U = {
  admin: '00000000-0000-4000-8000-0000000c1001',
  hr: '00000000-0000-4000-8000-0000000c1002',
  lead: '00000000-0000-4000-8000-0000000c1003',
  emp: '00000000-0000-4000-8000-0000000c1004',
  it: '00000000-0000-4000-8000-0000000c1005',
};
const email = (id: string) => `${id}@test.ipro.test`;
const PDF = Buffer.from('%PDF-1.4\n% synthetic\n');

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const people: Record<string, { personId: string; engagementId: string }> = {};
const agents: Record<string, ReturnType<typeof as>> = {};
const cookies: Record<string, string> = {};
const today = businessDate(new Date());

const onboarding = () => ({
  name: 'Standard onboarding',
  stage: 'onboarding',
  appliesTo: { engagementTypes: ['permanent'] },
  tasks: [
    {
      title: 'Upload PAN card',
      owner: { kind: 'employee' },
      dueOffsetDays: -3,
      mandatory: true,
      requiresDocument: true,
    },
    {
      title: 'Laptop and email',
      owner: { kind: 'user', userId: U.it, label: 'IT' },
      dueOffsetDays: -1,
      mandatory: true,
      requiresDocument: false,
    },
    {
      title: 'Buddy introduction',
      owner: { kind: 'manager' },
      dueOffsetDays: 0,
      mandatory: true,
      requiresDocument: false,
    },
    {
      title: 'Team lunch',
      owner: { kind: 'role', role: 'hr' },
      dueOffsetDays: 7,
      mandatory: false,
      requiresDocument: false,
    },
  ],
});

const person = (
  legalName: string,
  workEmail: string | undefined,
  type = 'permanent',
  manager?: string,
) => ({
  person: { legalName },
  engagement: { legalEntityId: org.legalEntity, type, workEmail, joiningDate: '2025-01-06' },
  assignment: {
    designationId: org.softwareEngineer,
    departmentId: org.engineering,
    locationId: org.chennai,
    managerEngagementId: manager,
    bucket: 'billable',
  },
});

const myTasks = async (who: string) =>
  (await agents[who]!.get('/api/checklist-tasks/mine').expect(200)).body as MyTaskView[];

beforeAll(async () => {
  tenant = await newTenant(pool, 'Checklist tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Cl Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Cl HR', ['employee', 'hr']);
  await addUser(db, tenant, U.lead, 'Cl Lead', ['employee', 'manager']);
  await addUser(db, tenant, U.emp, 'Cl Employee', ['employee']);
  await addUser(db, tenant, U.it, 'Cl IT Admin', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  const hrAgent = as(app, await signIn(app, U.hr));
  people.lead = (
    await hrAgent.post('/api/people', person('Kiran Lead', email(U.lead))).expect(201)
  ).body;
  people.emp = (
    await hrAgent
      .post(
        '/api/people',
        person('Nila Newjoiner', email(U.emp), 'permanent', people.lead!.engagementId),
      )
      .expect(201)
  ).body;
  people.retainer = (
    await hrAgent.post('/api/people', person('Ravi Retainer', undefined, 'retainer')).expect(201)
  ).body;
  for (const [key, id] of Object.entries(U)) {
    cookies[key] = await signIn(app, id);
    agents[key] = as(app, cookies[key]!);
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('checklist templates (A3)', () => {
  it('admins save versions; owners must be real users; HR cannot edit', async () => {
    const saved = await agents
      .admin!.put('/api/checklist-templates/onboarding', onboarding())
      .expect(200);
    expect(saved.body).toMatchObject({ key: 'onboarding', version: 1 });
    const bad = onboarding();
    bad.tasks[1]!.owner = {
      kind: 'user',
      userId: '00000000-0000-4000-8000-00000000dead',
      label: 'Ghost',
    };
    await agents.admin!.put('/api/checklist-templates/onboarding', bad).expect(400);
    await agents.hr!.put('/api/checklist-templates/onboarding', onboarding()).expect(403);
    const list = (await agents.hr!.get('/api/checklist-templates').expect(200)).body;
    expect(list.map((t: { key: string; version: number }) => [t.key, t.version])).toEqual([
      ['onboarding', 1],
    ]);
  });
});

describe('an onboarding checklist run', () => {
  let run: ChecklistRunView;
  const anchor = addDays(today, 10);

  it('HR starts it: due dates from the joining date, owners resolved', async () => {
    run = (
      await agents
        .hr!.post(`/api/people/${people.emp!.personId}/checklists`, {
          templateKey: 'onboarding',
          anchorDate: anchor,
        })
        .expect(201)
    ).body;
    expect(run.tasks.map((t) => [t.title, t.owner, t.dueOn, t.status])).toEqual([
      ['Upload PAN card', 'Employee', addDays(anchor, -3), 'open'],
      ['Laptop and email', 'IT', addDays(anchor, -1), 'open'],
      ['Buddy introduction', 'Manager (Cl Lead)', anchor, 'open'],
      ['Team lunch', 'HR', addDays(anchor, 7), 'open'],
    ]);
    expect(run.progress).toEqual({ done: 0, total: 4, overdue: 0 });
  });

  it('refuses a second open copy and people the template doesn’t apply to', async () => {
    await agents
      .hr!.post(`/api/people/${people.emp!.personId}/checklists`, {
        templateKey: 'onboarding',
        anchorDate: anchor,
      })
      .expect(409);
    await agents
      .hr!.post(`/api/people/${people.retainer!.personId}/checklists`, {
        templateKey: 'onboarding',
        anchorDate: anchor,
      })
      .expect(400);
    await agents
      .lead!.post(`/api/people/${people.emp!.personId}/checklists`, {
        templateKey: 'onboarding',
        anchorDate: anchor,
      })
      .expect(403);
  });

  it('each owner sees their own tasks', async () => {
    expect((await myTasks('emp')).map((t) => t.title)).toEqual(['Upload PAN card']);
    expect((await myTasks('it')).map((t) => t.title)).toEqual(['Laptop and email']);
    expect((await myTasks('lead')).map((t) => t.title)).toEqual(['Buddy introduction']);
    expect((await myTasks('hr')).map((t) => t.title)).toContain('Team lunch');
    const notes = (await agents.it!.get('/api/notifications').expect(200))
      .body as NotificationView[];
    expect(notes.some((n) => n.title === 'New task: Laptop and email')).toBe(true);
  });

  it('a task needing a document needs this person’s document', async () => {
    const pan = run.tasks[0]!;
    await agents.emp!.post(`/api/checklist-tasks/${pan.id}/done`, {}).expect(400);
    const otherDoc = await request(app.getHttpServer())
      .post(`/api/people/${people.lead!.personId}/documents`)
      .set('Cookie', cookies.hr!)
      .field('type', 'other')
      .field('title', 'Someone else’s file')
      .attach('file', PDF, { filename: 'other.pdf', contentType: 'application/pdf' })
      .expect(201);
    await agents
      .emp!.post(`/api/checklist-tasks/${pan.id}/done`, { evidenceDocumentId: otherDoc.body.id })
      .expect(400);
    const scan = await request(app.getHttpServer())
      .post(`/api/people/${people.emp!.personId}/documents`)
      .set('Cookie', cookies.emp!)
      .field('type', 'kyc_scan')
      .field('title', 'PAN card')
      .attach('file', PDF, { filename: 'pan.pdf', contentType: 'application/pdf' })
      .expect(201);
    const after = (
      await agents
        .emp!.post(`/api/checklist-tasks/${pan.id}/done`, { evidenceDocumentId: scan.body.id })
        .expect(201)
    ).body;
    expect(after.tasks[0]).toMatchObject({
      status: 'done',
      doneBy: 'Cl Employee',
      evidenceDocumentId: scan.body.id,
    });
  });

  it('only the owner (or HR) marks a task done', async () => {
    await agents.lead!.post(`/api/checklist-tasks/${run.tasks[1]!.id}/done`, {}).expect(403);
    await agents.emp!.post(`/api/checklist-tasks/${run.tasks[1]!.id}/done`, {}).expect(403);
  });

  it('completes when every mandatory task is done; optional tasks don’t block', async () => {
    await agents
      .it!.post(`/api/checklist-tasks/${run.tasks[1]!.id}/done`, { note: 'Laptop ready' })
      .expect(201);
    const done = (
      await agents.lead!.post(`/api/checklist-tasks/${run.tasks[2]!.id}/done`, {}).expect(201)
    ).body as ChecklistRunView;
    expect(done.status).toBe('complete');
    expect(done.progress).toMatchObject({ done: 3, total: 4 });
    await agents.hr!.post(`/api/checklist-tasks/${run.tasks[3]!.id}/done`, {}).expect(409);
    expect(await myTasks('lead')).toEqual([]);
  });
});

describe('waiving, the tracker and reminders', () => {
  let run: ChecklistRunView;

  beforeAll(async () => {
    await agents
      .admin!.put('/api/checklist-templates/transfer', {
        name: 'Team transfer',
        stage: 'transfer',
        appliesTo: {},
        tasks: [
          {
            title: 'Hand over work',
            owner: { kind: 'employee' },
            dueOffsetDays: 0,
            mandatory: true,
            requiresDocument: false,
          },
          {
            title: 'Update access',
            owner: { kind: 'user', userId: U.it, label: 'IT' },
            dueOffsetDays: 1,
            mandatory: true,
            requiresDocument: false,
          },
        ],
      })
      .expect(200);
    run = (
      await agents
        .hr!.post(`/api/people/${people.emp!.personId}/checklists`, {
          templateKey: 'transfer',
          anchorDate: today,
        })
        .expect(201)
    ).body;
  });

  it('HR waives with a reason; nobody else can waive', async () => {
    await agents
      .lead!.post(`/api/checklist-tasks/${run.tasks[1]!.id}/waive`, { reason: 'No' })
      .expect(403);
    await agents
      .hr!.post(`/api/checklist-tasks/${run.tasks[1]!.id}/waive`, { reason: '  ' })
      .expect(400);
    const after = (
      await agents
        .hr!.post(`/api/checklist-tasks/${run.tasks[1]!.id}/waive`, {
          reason: 'Same access in new team',
        })
        .expect(201)
    ).body;
    expect(after.tasks[1]).toMatchObject({
      status: 'waived',
      waiveReason: 'Same access in new team',
    });
  });

  it('the tracker shows each viewer only the checklists they may see', async () => {
    const open = (await agents.hr!.get('/api/checklist-runs').expect(200))
      .body as ChecklistRunView[];
    expect(open.map((r) => r.templateName)).toContain('Team transfer');
    // The manager sees their reportee's; an unrelated colleague sees nothing.
    const leadView = (await agents.lead!.get('/api/checklist-runs').expect(200)).body;
    expect(leadView.map((r: ChecklistRunView) => r.person.name)).toEqual(['Nila Newjoiner']);
    expect((await agents.it!.get('/api/checklist-runs').expect(200)).body).toEqual([]);
  });

  it('reminds on the due date, then daily while overdue, never twice a day', async () => {
    const service = app.get(ChecklistsService);
    const sweep = (day: string) => runWithContext({ tenantId: tenant }, () => service.sweep(day));
    expect((await sweep(today)).reminded).toBeGreaterThanOrEqual(1);
    expect((await sweep(today)).reminded).toBe(0);
    await sweep(addDays(today, 1));
    const notes = (await agents.emp!.get('/api/notifications').expect(200))
      .body as NotificationView[];
    expect(notes.some((n) => n.title === 'Due today: Hand over work')).toBe(true);
    expect(notes.some((n) => n.title === 'Overdue: Hand over work')).toBe(true);
  });

  it('HR can cancel an open checklist with a reason', async () => {
    const cancelled = (
      await agents
        .hr!.post(`/api/checklist-runs/${run.id}/cancel`, { reason: 'Transfer called off' })
        .expect(201)
    ).body;
    expect(cancelled.status).toBe('cancelled');
    expect(await myTasks('emp')).toEqual([]);
  });
});
