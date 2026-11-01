import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { MyPolicyView, NotificationView, PolicyStatusView } from '@ipro/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only.
const U = {
  admin: '00000000-0000-4000-8000-0000000e1001',
  hr: '00000000-0000-4000-8000-0000000e1002',
  emp: '00000000-0000-4000-8000-0000000e1003',
  intern: '00000000-0000-4000-8000-0000000e1004',
};
const email = (id: string) => `${id}@test.ipro.test`;
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n`);
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const cookies: Record<string, string> = {};
const agents: Record<string, ReturnType<typeof as>> = {};
const personIds: Record<string, string> = {};

const publish = (policyId: string, file: Buffer, effectiveFrom: string, who = 'admin') =>
  request(app.getHttpServer())
    .post(`/api/policies/${policyId}/versions`)
    .set('Cookie', cookies[who]!)
    .field('effectiveFrom', effectiveFrom)
    .attach('file', file, { filename: 'Code of conduct.pdf', contentType: 'application/pdf' });
const mine = async (who: string) =>
  (await agents[who]!.get('/api/policies/mine').expect(200)).body as MyPolicyView[];

async function hire(name: string, userId: string, type: string) {
  const created = await agents
    .hr!.post('/api/people', {
      person: { legalName: name },
      engagement: {
        legalEntityId: org.legalEntity,
        type,
        workEmail: email(userId),
        joiningDate: '2025-01-06',
      },
      assignment: {
        designationId: org.softwareEngineer,
        departmentId: org.engineering,
        locationId: org.chennai,
        bucket: 'billable',
      },
      compensation: { amount: '60000000', rateUnit: 'year' },
    })
    .expect(201);
  return created.body.personId as string;
}

beforeAll(async () => {
  tenant = await newTenant(pool, 'Policy tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Po Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Po HR', ['employee', 'hr']);
  await addUser(db, tenant, U.emp, 'Po Employee', ['employee']);
  await addUser(db, tenant, U.intern, 'Po Intern', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) {
    cookies[key] = await signIn(app, id);
    agents[key] = as(app, cookies[key]);
  }
  personIds.emp = await hire('Anil Synthetic', U.emp, 'permanent');
  personIds.intern = await hire('Divya Synthetic', U.intern, 'intern');
  // Sign in again so the sessions pick up the new person links.
  for (const key of ['emp', 'intern']) {
    cookies[key] = await signIn(app, U[key as keyof typeof U]);
    agents[key] = as(app, cookies[key]);
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('policy acknowledgements (slice 3 done-when #3)', () => {
  let conduct: PolicyStatusView;
  let interns: PolicyStatusView;
  const v1 = pdf('code of conduct v1');
  const v2 = pdf('code of conduct v2');

  it('admins create policies and publish PDF versions; HR may not', async () => {
    conduct = (
      await agents
        .admin!.post('/api/policies', {
          code: 'CONDUCT',
          title: 'Code of conduct',
          appliesTo: {},
          requiresAcknowledgement: true,
        })
        .expect(201)
    ).body;
    interns = (
      await agents
        .admin!.post('/api/policies', {
          code: 'INTERNSHIP',
          title: 'Internship guidelines',
          appliesTo: { engagementTypes: ['intern'] },
          requiresAcknowledgement: true,
        })
        .expect(201)
    ).body;
    await agents
      .hr!.post('/api/policies', {
        code: 'X',
        title: 'X',
        appliesTo: {},
        requiresAcknowledgement: false,
      })
      .expect(403);
    await agents
      .admin!.post('/api/policies', {
        code: 'CONDUCT',
        title: 'Again',
        appliesTo: {},
        requiresAcknowledgement: true,
      })
      .expect(409);

    await publish(conduct.policyId, Buffer.from('MZ not a pdf'), '2026-01-01').expect(400);
    await publish(conduct.policyId, v1, '2026-01-01', 'hr').expect(403);
    const published = (await publish(conduct.policyId, v1, '2026-01-01').expect(201))
      .body as PolicyStatusView;
    expect(published.current).toMatchObject({ version: 1, contentHash: sha256(v1) });
    await publish(interns.policyId, pdf('interns v1'), '2026-01-01').expect(201);
  });

  it('asks only the people a policy applies to', async () => {
    expect((await mine('emp')).map((p) => p.code)).toEqual(['CONDUCT']);
    expect((await mine('intern')).map((p) => p.code).sort()).toEqual(['CONDUCT', 'INTERNSHIP']);
    const notes = (await agents.emp!.get('/api/notifications').expect(200))
      .body as NotificationView[];
    expect(notes.some((n) => n.title === 'Please read and accept: Code of conduct (v1)')).toBe(
      true,
    );
    const internPolicy = (await mine('intern')).find((p) => p.code === 'INTERNSHIP')!;
    await agents.emp!.post(`/api/policies/versions/${internPolicy.current.id}/link`).expect(404);
    await agents
      .emp!.post(`/api/policies/versions/${internPolicy.current.id}/accept`, {
        contentHash: internPolicy.current.contentHash,
      })
      .expect(404);
  });

  it('an employee reads and accepts; the session and device are recorded', async () => {
    const [policy] = await mine('emp');
    expect(policy).toMatchObject({ pending: true, acceptedAt: null });
    const link = await agents.emp!.post(`/api/policies/versions/${policy!.current.id}/link`);
    expect(link.status).toBe(201);
    expect(link.body.url).toBeTruthy();

    await agents
      .emp!.post(`/api/policies/versions/${policy!.current.id}/accept`, {
        contentHash: sha256(pdf('something else')),
      })
      .expect(409);
    const accepted = (
      await agents
        .emp!.post(`/api/policies/versions/${policy!.current.id}/accept`, {
          contentHash: policy!.current.contentHash,
        })
        .set('User-Agent', 'synthetic-browser/1.0')
        .expect(201)
    ).body as MyPolicyView[];
    expect(accepted[0]).toMatchObject({ pending: false });
    expect(accepted[0]!.acceptedAt).toBeTruthy();
    // Accepting twice is harmless.
    await agents
      .emp!.post(`/api/policies/versions/${policy!.current.id}/accept`, {
        contentHash: policy!.current.contentHash,
      })
      .expect(201);

    const { rows } = await pool.query(
      `select a.session_id, a.user_agent, a.user_id, s.id as live_session
         from policy_acknowledgement a left join session s on s.id = a.session_id
        where a.person_id = $1`,
      [personIds.emp],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_agent: 'synthetic-browser/1.0', user_id: U.emp });
    expect(rows[0].live_session).toBe(rows[0].session_id);
    const audit = await pool.query(
      `select count(*)::int as n from audit_log
        where table_name = 'policy_acknowledgement' and subject_person_id = $1`,
      [personIds.emp],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('HR sees who has accepted and who is pending; admins see no names', async () => {
    const status = (await agents.hr!.get(`/api/policies/${conduct.policyId}`).expect(200))
      .body as PolicyStatusView;
    expect(status.accepted.map((p) => p.personId)).toEqual([personIds.emp]);
    expect(status.pending.map((p) => p.personId)).toContain(personIds.intern);
    expect(status.pending.map((p) => p.personId)).not.toContain(personIds.emp);
    const adminView = (await agents.admin!.get(`/api/policies/${conduct.policyId}`).expect(200))
      .body as PolicyStatusView;
    expect(adminView.accepted).toEqual([]);
    expect(adminView.pending).toEqual([]);
    await agents.emp!.get(`/api/policies/${conduct.policyId}`).expect(403);
  });

  it('publishing a new version re-opens acknowledgement for everyone it applies to', async () => {
    const before = (await mine('emp'))[0]!;
    await publish(conduct.policyId, v2, '2026-04-01').expect(201);
    const after = (await mine('emp'))[0]!;
    expect(after).toMatchObject({ pending: true, acceptedAt: null });
    expect(after.current).toMatchObject({ version: 2, contentHash: sha256(v2) });

    // Accepting the version read before the change is refused.
    await agents
      .emp!.post(`/api/policies/versions/${before.current.id}/accept`, {
        contentHash: before.current.contentHash,
      })
      .expect(409);

    const status = (await agents.hr!.get(`/api/policies/${conduct.policyId}`).expect(200))
      .body as PolicyStatusView;
    expect(status.accepted).toEqual([]);
    expect(status.pending.map((p) => p.personId)).toEqual(
      expect.arrayContaining([personIds.emp, personIds.intern]),
    );
    expect(status.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('the database refuses an acceptance of content that was not published', async () => {
    const version = (await mine('emp'))[0]!.current;
    await expect(
      withTenant(db, tenant, (tx) =>
        tx.execute(
          `insert into policy_acknowledgement (tenant_id, policy_version_id, person_id, user_id, content_hash)
           values ('${tenant}', '${version.id}', '${personIds.emp}', '${U.emp}', '${sha256(pdf('forged'))}')` as never,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(db, tenant, (tx) => tx.execute(`delete from policy_version` as never)),
    ).rejects.toThrow();
  });
});
