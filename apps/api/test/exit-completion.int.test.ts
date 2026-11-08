import type { INestApplication } from '@nestjs/common';
import type { ChecklistRunView, ExitCaseView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { DIRECTORY_ACCOUNTS, type FakeDirectoryAccounts } from '../src/exit/directory-accounts.js';
import { ExitService } from '../src/exit/exit.service.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. Three people are let go by HR head, two on their last day today.
const U = {
  admin: '00000000-0000-4000-8000-000000612001',
  hr: '00000000-0000-4000-8000-000000612002',
  hrHead: '00000000-0000-4000-8000-000000612003',
  mgr: '00000000-0000-4000-8000-000000612004',
  arun: '00000000-0000-4000-8000-000000612005',
  bina: '00000000-0000-4000-8000-000000612006',
  chitra: '00000000-0000-4000-8000-000000612007',
};
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());
const endOfToday = new Date(`${today}T23:55:00+05:30`);

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const agents: Record<string, ReturnType<typeof as>> = {};
type Hire = { personId: string; engagementId: string; employeeCode: string };
const p = {} as Record<'mgr' | 'arun' | 'bina' | 'chitra', Hire>;
const exitOf = {} as Record<'arun' | 'bina' | 'chitra', string>;

async function hire(name: string, userId: string, managerEngagementId?: string) {
  const res = await agents
    .hr!.post('/api/people', {
      person: { legalName: name },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: email(userId),
        joiningDate: '2024-01-08',
      },
      assignment: {
        designationId: org.softwareEngineer,
        departmentId: org.engineering,
        locationId: org.chennai,
        bucket: 'billable',
        ...(managerEngagementId ? { managerEngagementId } : {}),
      },
    })
    .expect(201);
  return res.body as Hire;
}

const view = async (who: string, id: string) =>
  (await agents[who]!.get(`/api/exits/${id}`).expect(200)).body as ExitCaseView;
const letter = (who: string, h: Hire, templateKey: string) =>
  agents[who]!.post(`/api/people/${h.personId}/letters`, { templateKey, extra: {} });
const disableDue = (now: Date) =>
  runWithContext({ tenantId: tenant }, () => app.get(ExitService).disableDueAccounts(now));

async function finishChecklist(h: Hire) {
  const runs = (await agents.hr!.get(`/api/people/${h.personId}/checklists`).expect(200))
    .body as ChecklistRunView[];
  const run = runs.find((r) => r.stage === 'exit' && r.status === 'open')!;
  for (const task of run.tasks.filter((t) => t.status === 'open')) {
    await agents.hr!.post(`/api/checklist-tasks/${task.id}/done`, {}).expect(201);
  }
}

beforeAll(async () => {
  tenant = await newTenant(pool, 'Exit completion tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Ec Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Ec HR', ['employee', 'hr']);
  await addUser(db, tenant, U.hrHead, 'Ec HR Head', ['employee', 'hr_head']);
  await addUser(db, tenant, U.mgr, 'Ec Manager', ['employee', 'manager']);
  for (const key of ['arun', 'bina', 'chitra'] as const) {
    await addUser(db, tenant, U[key], `Ec ${key}`, ['employee']);
  }
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  p.mgr = await hire('Mano Manager', U.mgr);
  p.arun = await hire('Arun Aravind', U.arun, p.mgr.engagementId);
  p.bina = await hire('Bina Bose', U.bina, p.mgr.engagementId);
  p.chitra = await hire('Chitra Chari', U.chitra, p.mgr.engagementId);
  // Arun signs in with Entra; Bina's account has no Entra link (IT handles it).
  await pool.query(`update app_user set entra_object_id = 'entra-arun-1' where id = $1`, [U.arun]);
  for (const [key, type] of [
    ['termination', 'termination'],
    ['relieving', 'relieving'],
    ['experience', 'experience'],
  ] as const) {
    await agents
      .admin!.put(`/api/letter-templates/${key}`, {
        name: `${key} letter`,
        type,
        body: `Dear {{person.legalName}},\n\nYour last working day is {{engagement.lastWorkingDate}}.`,
        approverRole: null,
        signature: 'none',
      })
      .expect(200);
  }
  for (const [key, lwd] of [
    ['arun', today],
    ['bina', today],
    ['chitra', addDays(today, 20)],
  ] as const) {
    const res = await agents
      .hrHead!.post(`/api/people/${p[key].personId}/terminate`, {
        lastWorkingDate: lwd,
        reason: 'Role closed',
      })
      .expect(201);
    exitOf[key] = (res.body as ExitCaseView).id;
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('letters only after clearance (slice 9 done-when #3)', () => {
  it('refuses relieving and experience letters while clearance tasks are open', async () => {
    const res = await letter('hr', p.arun, 'relieving').expect(400);
    expect(res.body.message).toBe(
      'Relieving and experience letters come only after every clearance task is done',
    );
    await letter('hr', p.arun, 'experience').expect(400);
    const before = await view('hr', exitOf.arun);
    expect(before.blockers).toEqual([
      expect.stringMatching(/^The exit checklist isn’t finished \(0 of \d+ done\)$/),
      'Record the exit interview first',
    ]);
    await agents.hr!.post(`/api/exits/${exitOf.arun}/complete`).expect(400);
  });

  it('moves to clearance when every checklist task is done', async () => {
    await finishChecklist(p.arun);
    const after = await view('hr', exitOf.arun);
    expect(after.status).toBe('clearance');
    expect(after.clearanceDoneAt).not.toBeNull();
    expect(after.blockers).toEqual(['Record the exit interview first']);
    // Now the letters can be made by hand too.
    await letter('hr', p.arun, 'experience').expect(201);
  });
});

describe('the exit interview and completing the exit (spec: Clearance → Exited)', () => {
  it('HR records the interview and the rehire flag; the manager sees neither the answers nor can record', async () => {
    const answers = {
      reason: 'A role closer to home',
      improve: 'Clearer growth paths',
      wouldReturn: 'maybe',
    };
    await agents
      .mgr!.post(`/api/exits/${exitOf.arun}/interview`, { answers, rehireEligible: true })
      .expect(403);
    await agents
      .hr!.post(`/api/exits/${exitOf.arun}/interview`, { rehireEligible: true })
      .expect(400);
    const recorded = (
      await agents
        .hr!.post(`/api/exits/${exitOf.arun}/interview`, { answers, rehireEligible: true })
        .expect(200)
    ).body as ExitCaseView;
    expect(recorded.interview).toMatchObject({ declined: false, rehireEligible: true, answers });
    expect(recorded.blockers).toEqual([]);
    expect(recorded.can.completeExit).toBe(true);
    expect((await view('mgr', exitOf.arun)).interview).toMatchObject({ answers: null });
  });

  it('completes the exit: exited, rehire flag kept, relieving and experience letters made', async () => {
    const done = (await agents.hr!.post(`/api/exits/${exitOf.arun}/complete`).expect(200))
      .body as ExitCaseView;
    expect(done).toMatchObject({ status: 'exited' });
    expect(done.exitedAt).not.toBeNull();
    const { rows } = await pool.query(
      `select status, rehire_eligible from engagement where id = $1`,
      [p.arun.engagementId],
    );
    expect(rows[0]).toEqual({ status: 'exited', rehire_eligible: true });
    const letters = (await agents.hr!.get(`/api/people/${p.arun.personId}/letters`).expect(200))
      .body as { type: string }[];
    expect(letters.map((l) => l.type).sort()).toEqual([
      'experience',
      'experience',
      'relieving',
      'termination',
    ]);
    const journey = JSON.stringify(
      (await agents.hr!.get(`/api/people/${p.arun.personId}/journey`).expect(200)).body,
    );
    expect(journey).toContain('Exited');
  });

  it('can’t complete before the last working day', async () => {
    await finishChecklist(p.chitra);
    await agents
      .hr!.post(`/api/exits/${exitOf.chitra}/interview`, { declined: true, rehireEligible: false })
      .expect(200);
    const res = await agents.hr!.post(`/api/exits/${exitOf.chitra}/complete`).expect(400);
    expect(res.body.message).toMatch(/^The last working day is /);
  });
});

describe('access ends with the last working day (slice 9 done-when #2)', () => {
  it('does nothing before the end of the day', async () => {
    expect(await disableDue(new Date(`${today}T10:00:00+05:30`))).toEqual({ disabled: 0 });
  });

  it('disables Entra and iPro at the end of the last day; without Entra, an IT task', async () => {
    const directory = app.get<FakeDirectoryAccounts>(DIRECTORY_ACCOUNTS);
    expect(await disableDue(endOfToday)).toEqual({ disabled: 2 });
    expect(directory.disabled).toEqual(['entra-arun-1']);
    // Running again changes nothing; Chitra's last day is still ahead.
    expect(await disableDue(endOfToday)).toEqual({ disabled: 0 });

    expect((await view('hr', exitOf.arun)).access).toMatchObject({ method: 'entra' });
    expect((await view('hr', exitOf.bina)).access).toMatchObject({ method: 'it_task' });
    expect((await view('hr', exitOf.chitra)).access).toBeNull();
    const users = await pool.query(
      `select id, status from app_user where id = any($1::uuid[]) order by id`,
      [[U.arun, U.bina, U.chitra]],
    );
    expect(users.rows.map((r) => r.status)).toEqual(['disabled', 'disabled', 'active']);
    // Their sessions end with the account.
    await agents.arun!.get('/api/me').expect(401);
    await agents.chitra!.get('/api/me').expect(200);
    const runs = (await agents.hr!.get(`/api/people/${p.bina.personId}/checklists`).expect(200))
      .body as ChecklistRunView[];
    expect(runs.find((r) => r.stage === 'access')?.tasks.map((t) => t.title)).toEqual([
      'Disable the Microsoft Entra account and mailbox',
    ]);
  });
});
