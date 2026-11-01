import type { INestApplication } from '@nestjs/common';
import type { ApprovalCard, DocumentView, LetterView } from '@ipro/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { ESIGN_PROVIDER, type FakeEsign } from '../src/esign/esign.js';
import { LettersService } from '../src/letters/letters.service.js';
import { OBJECT_STORAGE, type MemoryStorage } from '../src/storage/object-storage.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only.
const U = {
  admin: '00000000-0000-4000-8000-0000000d1001',
  hr: '00000000-0000-4000-8000-0000000d1002',
  hr2: '00000000-0000-4000-8000-0000000d1003',
  hrHead: '00000000-0000-4000-8000-0000000d1004',
  emp: '00000000-0000-4000-8000-0000000d1005',
};
const email = (id: string) => `${id}@test.ipro.test`;

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
let fake: FakeEsign;
let personId: string;
const agents: Record<string, ReturnType<typeof as>> = {};

const confirmation = {
  name: 'Confirmation letter',
  type: 'confirmation',
  body: `# Confirmation of employment

Dear {{person.preferredName}},

We are pleased to confirm your employment as {{assignment.designation}} in {{assignment.department}} with effect from {{extra.confirmationDate}}.

Your employee code is {{engagement.employeeCode}} and your pay is {{compensation.amount}}.

For {{company.name}}`,
  approverRole: null,
  signature: 'employee',
};

const letters = async () =>
  (await agents.hr!.get(`/api/people/${personId}/letters`).expect(200)).body as LetterView[];
const cards = async (who: string) =>
  (await agents[who]!.get('/api/approvals').expect(200)).body as ApprovalCard[];

beforeAll(async () => {
  tenant = await newTenant(pool, 'Letter tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Lt Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Lt HR', ['employee', 'hr']);
  await addUser(db, tenant, U.hr2, 'Lt HR Two', ['employee', 'hr']);
  await addUser(db, tenant, U.hrHead, 'Lt HR Head', ['employee', 'hr_head']);
  await addUser(db, tenant, U.emp, 'Lt Employee', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  fake = app.get<FakeEsign>(ESIGN_PROVIDER);
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  const created = await agents
    .hr!.post('/api/people', {
      person: { legalName: 'Meera Synthetic' },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: email(U.emp),
        joiningDate: '2025-01-06',
      },
      assignment: {
        designationId: org.softwareEngineer,
        departmentId: org.engineering,
        locationId: org.chennai,
        bucket: 'billable',
      },
      compensation: { amount: '120000000', rateUnit: 'year' },
    })
    .expect(201);
  personId = created.body.personId;
  agents.emp = as(app, await signIn(app, U.emp));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('letter templates (A3)', () => {
  it('refuses unknown fields; saves versions listing the fields used', async () => {
    const bad = await agents
      .admin!.put('/api/letter-templates/confirmation', {
        ...confirmation,
        body: 'Salary: {{person.salary}}',
      })
      .expect(400);
    expect(bad.body.problems).toEqual(['Unknown field {{person.salary}}']);
    const saved = (
      await agents.admin!.put('/api/letter-templates/confirmation', confirmation).expect(200)
    ).body;
    expect(saved).toMatchObject({ version: 1 });
    expect(saved.fields).toContain('compensation.amount');
    await agents.hr!.put('/api/letter-templates/confirmation', confirmation).expect(403);
  });
});

describe('generating and signing (done-when #2)', () => {
  let letter: LetterView;

  it('lists every missing value instead of printing blanks', async () => {
    const res = await agents
      .hr!.post(`/api/people/${personId}/letters`, { templateKey: 'confirmation' })
      .expect(400);
    expect(res.body.problems).toEqual(['extra.confirmationDate']);
  });

  it('generates a PDF stored as a versioned document; reading pay for it is audited', async () => {
    letter = (
      await agents
        .hr!.post(`/api/people/${personId}/letters`, {
          templateKey: 'confirmation',
          extra: { confirmationDate: '1 July 2025' },
        })
        .expect(201)
    ).body;
    expect(letter).toMatchObject({
      status: 'ready',
      documentVersion: 1,
      needsSignature: true,
      templateVersion: 1,
    });
    const storage = app.get<MemoryStorage>(OBJECT_STORAGE);
    const stored = [...storage.objects.values()].at(-1)!;
    expect(stored.body.subarray(0, 5).toString()).toBe('%PDF-');
    const docs = (await agents.hr!.get(`/api/people/${personId}/documents`).expect(200))
      .body as DocumentView[];
    expect(docs.find((d) => d.id === letter.documentId)).toMatchObject({
      type: 'letter',
      version: 1,
      confidential: true,
    });
    const { rows } = await pool.query(
      `select count(*)::int as n from audit_log where table_name = 'compensation' and action = 'view' and subject_person_id = $1`,
      [personId],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('regenerating creates the next document version', async () => {
    const again = (
      await agents
        .hr!.post(`/api/people/${personId}/letters`, {
          templateKey: 'confirmation',
          extra: { confirmationDate: '1 July 2025' },
        })
        .expect(201)
    ).body as LetterView;
    expect(again.documentVersion).toBe(2);
    const { rows } = await pool.query(`select previous_version_id from document where id = $1`, [
      again.documentId,
    ]);
    expect(rows[0].previous_version_id).toBe(letter.documentId);
    letter = again;
  });

  it('sends for signature; the webhook leads to a signed copy as the next version', async () => {
    const sent = (await agents.hr!.post(`/api/letters/${letter.id}/send`).expect(201))
      .body as LetterView;
    expect(sent.status).toBe('sent');
    const [requestId, entry] = [...fake.requests.entries()].at(-1)!;
    expect(entry.request.signer).toEqual({ name: 'Meera Synthetic', email: email(U.emp) });
    await agents.hr!.post(`/api/letters/${letter.id}/send`).expect(409);

    fake.sign(requestId);
    await request(app.getHttpServer())
      .post('/api/esign/webhook')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ requestId }))
      .expect(204);
    const [signed] = (await letters()).filter((l) => l.id === letter.id);
    expect(signed).toMatchObject({ status: 'signed' });
    expect(signed!.signedDocumentId).not.toBeNull();
    const { rows } = await pool.query(
      `select version, previous_version_id, signed_at is not null as signed from document where id = $1`,
      [signed!.signedDocumentId],
    );
    expect(rows[0]).toEqual({ version: 3, previous_version_id: letter.documentId, signed: true });
  });

  it('a webhook about an unknown request changes nothing', async () => {
    await request(app.getHttpServer())
      .post('/api/esign/webhook')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ requestId: 'fake-unknown' }))
      .expect(204);
  });

  it('polling catches signatures and declines whose webhook never came', async () => {
    const one = (
      await agents
        .hr!.post(`/api/people/${personId}/letters`, {
          templateKey: 'confirmation',
          extra: { confirmationDate: '2 July 2025' },
        })
        .expect(201)
    ).body;
    const two = (
      await agents
        .hr!.post(`/api/people/${personId}/letters`, {
          templateKey: 'confirmation',
          extra: { confirmationDate: '3 July 2025' },
        })
        .expect(201)
    ).body;
    await agents.hr!.post(`/api/letters/${one.id}/send`).expect(201);
    const signId = [...fake.requests.keys()].at(-1)!;
    await agents.hr!.post(`/api/letters/${two.id}/send`).expect(201);
    const declineId = [...fake.requests.keys()].at(-1)!;
    fake.sign(signId);
    fake.decline(declineId);
    await runWithContext({ tenantId: tenant }, () => app.get(LettersService).poll());
    const byId = new Map((await letters()).map((l) => [l.id, l.status]));
    expect([byId.get(one.id), byId.get(two.id)]).toEqual(['signed', 'declined']);
  });
});

describe('approval before release', () => {
  beforeAll(async () => {
    await agents
      .admin!.put('/api/letter-templates/extension', {
        name: 'Probation extension',
        type: 'extension',
        body: 'Dear {{person.preferredName}}, your probation is extended to {{extra.newEndDate}}.',
        approverRole: 'hr_head',
        signature: 'none',
      })
      .expect(200);
    await agents
      .admin!.put('/api/letter-templates/transfer', {
        name: 'Transfer letter',
        type: 'transfer',
        body: 'Dear {{person.preferredName}}, you move to {{extra.newTeam}}.',
        approverRole: 'hr',
        signature: 'none',
      })
      .expect(200);
  });

  it('waits for the approver role, then is released', async () => {
    const letter = (
      await agents
        .hr!.post(`/api/people/${personId}/letters`, {
          templateKey: 'extension',
          extra: { newEndDate: '31 March 2026' },
        })
        .expect(201)
    ).body as LetterView;
    expect(letter.status).toBe('pending_approval');
    const card = (await cards('hrHead')).find((c) => c.instanceId === letter.approvalRequestId);
    expect(card!.changes).toEqual([
      { label: 'Letter', from: null, to: 'Probation extension (template v1)' },
    ]);
    await agents.hrHead!.post(`/api/approvals/${card!.approvalId}/approve`, {}).expect(201);
    expect((await letters()).find((l) => l.id === letter.id)!.status).toBe('ready');
  });

  it('whoever generated it cannot approve it; a return marks the letter returned', async () => {
    const letter = (
      await agents
        .hr!.post(`/api/people/${personId}/letters`, {
          templateKey: 'transfer',
          extra: { newTeam: 'Quality' },
        })
        .expect(201)
    ).body as LetterView;
    expect((await cards('hr')).some((c) => c.instanceId === letter.approvalRequestId)).toBe(false);
    const card = (await cards('hr2')).find((c) => c.instanceId === letter.approvalRequestId);
    await agents
      .hr2!.post(`/api/approvals/${card!.approvalId}/reject`, { comment: 'Wrong team name' })
      .expect(201);
    expect((await letters()).find((l) => l.id === letter.id)!.status).toBe('returned');
  });
});

describe('who sees letters', () => {
  it('the person sees their own; employees cannot generate', async () => {
    const own = (await agents.emp!.get(`/api/people/${personId}/letters`).expect(200))
      .body as LetterView[];
    expect(own.length).toBeGreaterThan(0);
    await agents
      .emp!.post(`/api/people/${personId}/letters`, { templateKey: 'confirmation', extra: {} })
      .expect(403);
  });
});
