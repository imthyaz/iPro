import type { INestApplication } from '@nestjs/common';
import type { MyTaskView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. Decision #81: the exit checklist's IT and finance tasks go to the people
// the admin names on the template.
const U = {
  admin: '00000000-0000-4000-8000-000000611001',
  hr: '00000000-0000-4000-8000-000000611002',
  hrHead: '00000000-0000-4000-8000-000000611003',
  it: '00000000-0000-4000-8000-000000611004',
  finance: '00000000-0000-4000-8000-000000611005',
  emp: '00000000-0000-4000-8000-000000611006',
};
const today = businessDate(new Date());

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const agents: Record<string, ReturnType<typeof as>> = {};

beforeAll(async () => {
  tenant = await newTenant(pool, 'Designated owner tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Do Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Do HR', ['employee', 'hr']);
  await addUser(db, tenant, U.hrHead, 'Do HR Head', ['employee', 'hr_head']);
  await addUser(db, tenant, U.it, 'Iniyan IT Desk', ['employee']);
  await addUser(db, tenant, U.finance, 'Fathima Finance', ['employee']);
  await addUser(db, tenant, U.emp, 'Do Employee', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('named task owners (decisions #15, #81)', () => {
  it('lets an admin find people by name or email; nobody else', async () => {
    const found = (await agents.admin!.get('/api/checklist-owners?q=iniyan').expect(200)).body;
    expect(found).toEqual([
      { userId: U.it, label: 'Iniyan IT Desk', email: `${U.it}@test.ipro.test` },
    ]);
    await agents.emp!.get('/api/checklist-owners?q=iniyan').expect(403);
    await agents.admin!.get('/api/checklist-owners?q=i').expect(400);
  });

  it('sends the exit checklist’s IT and finance tasks to the people named', async () => {
    const owner = (userId: string, label: string) => ({ kind: 'user', userId, label });
    await agents
      .admin!.put('/api/checklist-templates/exit_clearance', {
        name: 'Exit clearance',
        stage: 'exit',
        appliesTo: {},
        tasks: [
          {
            title: 'Hand over work',
            owner: { kind: 'manager' },
            dueOffsetDays: -5,
            mandatory: true,
            requiresDocument: false,
          },
          {
            title: 'Return the laptop',
            owner: owner(U.it, 'IT desk'),
            dueOffsetDays: 0,
            mandatory: true,
            requiresDocument: false,
          },
          {
            title: 'Clear advances',
            owner: owner(U.finance, 'Finance'),
            dueOffsetDays: -2,
            mandatory: true,
            requiresDocument: false,
          },
        ],
      })
      .expect(200);
    await agents
      .admin!.put('/api/letter-templates/termination', {
        name: 'Termination letter',
        type: 'termination',
        body: 'Dear {{person.legalName}},\n\nYour employment ends on {{extra.lastWorkingDate}}.',
        approverRole: null,
        signature: 'none',
      })
      .expect(200);
    const person = await agents
      .hr!.post('/api/people', {
        person: { legalName: 'Leaving Person' },
        engagement: {
          legalEntityId: org.legalEntity,
          type: 'permanent',
          workEmail: 'leaving-611@test.ipro.test',
          joiningDate: '2024-01-08',
        },
        assignment: {
          designationId: org.softwareEngineer,
          departmentId: org.engineering,
          locationId: org.chennai,
          bucket: 'billable',
        },
      })
      .expect(201);
    await agents
      .hrHead!.post(`/api/people/${person.body.personId}/terminate`, {
        lastWorkingDate: addDays(today, 20),
        reason: 'Role closed',
      })
      .expect(201);
    const itTasks = (await agents.it!.get('/api/checklist-tasks/mine').expect(200))
      .body as MyTaskView[];
    expect(itTasks.map((t) => t.title)).toEqual(['Return the laptop']);
    const financeTasks = (await agents.finance!.get('/api/checklist-tasks/mine').expect(200))
      .body as MyTaskView[];
    expect(financeTasks.map((t) => t.title)).toEqual(['Clear advances']);
  });
});
