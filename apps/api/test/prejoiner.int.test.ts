import type { INestApplication } from '@nestjs/common';
import type {
  MyPolicyView,
  MyTaskView,
  NotificationView,
  OfferView,
  OnboardingView,
} from '@ipro/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import * as schema from '../src/db/schema.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { OIDC_PROVIDER, type OidcChecks } from '../src/identity/entra/oidc-provider.js';
import { SessionsService } from '../src/identity/sessions.service.js';
import { GUEST_INVITES, type FakeGuestInvites } from '../src/invites/guest-invites.js';
import { OffersService } from '../src/offers/offers.service.js';
import { addUser, as, newTenant, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only.
const U = {
  admin: '00000000-0000-4000-8000-000000101001',
  hr: '00000000-0000-4000-8000-000000101002',
  mgr: '00000000-0000-4000-8000-000000101003',
};
const ENTRA_TENANT = 'entra-tenant-synthetic';
const PREJOINERS_GROUP = 'group-prejoiners-synthetic';
const today = businessDate(new Date());
const joining = addDays(today, 14);
const PDF = Buffer.from('%PDF-1.4\n% synthetic scan\n');

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
let invites: FakeGuestInvites;
let managerEngagementId: string;
const agents: Record<string, ReturnType<typeof as>> = {};
const cookies: Record<string, string> = {};

/** Entra stand-in: remembers the sign-in checks and returns whatever claims the test sets. */
const oidc = {
  checks: null as OidcChecks | null,
  claims: {} as Record<string, unknown>,
  async authorizationUrl(checks: OidcChecks) {
    oidc.checks = checks;
    return new URL(`https://login.example.test/authorize?state=${checks.state}`);
  },
  async exchange() {
    return oidc.claims;
  },
};

const sessionFor = async (userId: string) => {
  const header = await runWithContext({ tenantId: tenant }, () =>
    app.get(SessionsService).start(userId),
  );
  return header.split(';')[0]!;
};

async function acceptedOffer(name: string, personalEmail: string): Promise<OfferView> {
  const draft = await agents
    .hr!.post('/api/offers', {
      person: { legalName: name, personalEmail },
      engagement: { legalEntityId: org.legalEntity, type: 'permanent', joiningDate: joining },
      assignment: {
        designationId: org.softwareEngineer,
        departmentId: org.engineering,
        locationId: org.chennai,
        managerEngagementId,
        bucket: 'billable',
      },
      compensation: { amount: '80000000', rateUnit: 'year' },
      letterTemplateKey: 'offer',
    })
    .expect(201);
  const offer = (await agents.hr!.post(`/api/offers/${draft.body.id}/submit`).expect(201))
    .body as OfferView;
  const cards = (await agents.mgr!.get('/api/approvals').expect(200)).body as {
    approvalId: string;
    subject: { personId: string };
  }[];
  const card = cards.find((c) => c.subject.personId === offer.person.personId)!;
  await agents.mgr!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(201);
  // The development stand-in for the candidate signing in Zoho Sign.
  await agents
    .hr!.post(`/api/letters/${offer.letter!.id}/fake-signer`, { action: 'sign' })
    .expect(204);
  return (await agents.hr!.get(`/api/offers/${offer.id}`).expect(200)).body as OfferView;
}

/** Signs in through the Entra callback with the given claims; returns the session cookie. */
async function entraSignIn(claims: Record<string, unknown>): Promise<string> {
  await request(app.getHttpServer()).get('/api/auth/login').expect(302);
  oidc.claims = { tid: ENTRA_TENANT, ...claims };
  const response = await request(app.getHttpServer())
    .get(`/api/auth/callback?state=${oidc.checks!.state}&code=synthetic`)
    .expect(302);
  expect(response.headers.location).not.toContain('signin=failed');
  return response.headers['set-cookie']![0]!.split(';')[0]!;
}

beforeAll(async () => {
  tenant = await newTenant(pool, 'Pre-joiner tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, async (tx) => {
    await seedOrg(tx, tenant, tenant.slice(0, 8));
    await tx
      .insert(schema.entraGroupRoles)
      .values({ tenantId: tenant, entraGroupId: PREJOINERS_GROUP, role: 'employee' });
  });
  await addUser(db, tenant, U.admin, 'Pj Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Pj HR', ['employee', 'hr']);
  await addUser(db, tenant, U.mgr, 'Pj Manager', ['employee', 'manager']);
  app = await createTestApp(
    {
      TENANT_ID: tenant,
      ENTRA_TENANT_ID: ENTRA_TENANT,
      ENTRA_CLIENT_ID: 'synthetic-client',
      ENTRA_CLIENT_SECRET: 'synthetic-secret',
      OIDC_REDIRECT_URI: 'http://localhost:5173/api/auth/callback',
    },
    [{ provide: OIDC_PROVIDER, useValue: oidc }],
  );
  invites = app.get<FakeGuestInvites>(GUEST_INVITES);
  for (const [key, id] of Object.entries(U)) {
    cookies[key] = await sessionFor(id);
    agents[key] = as(app, cookies[key]);
  }
  const manager = await agents
    .hr!.post('/api/people', {
      person: { legalName: 'Meena Manager' },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: `${U.mgr}@test.ipro.test`,
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
  managerEngagementId = manager.body.engagementId;
  agents.mgr = as(app, await sessionFor(U.mgr));

  await agents
    .admin!.put('/api/letter-templates/offer', {
      name: 'Offer letter',
      type: 'offer',
      body: 'Dear {{person.legalName}}, welcome as {{assignment.designation}}.',
      approverRole: null,
      signature: 'employee',
    })
    .expect(200);
  await agents
    .admin!.put('/api/checklist-templates/onboarding', {
      name: 'Onboarding',
      stage: 'onboarding',
      appliesTo: {},
      tasks: [
        {
          title: 'Upload PAN',
          owner: { kind: 'employee' },
          dueOffsetDays: -3,
          mandatory: true,
          requiresDocument: true,
        },
      ],
    })
    .expect(200);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('pre-joiner access (decision #55)', () => {
  let offer: OfferView;
  let guest: ReturnType<typeof as>;

  it('accepting the offer invites the joiner’s personal email as a guest', async () => {
    offer = await acceptedOffer('Priya Joiner', 'priya@personal.test');
    expect(offer.status).toBe('accepted');
    expect(offer.guest?.status).toBe('invited');
    expect(invites.sent.at(-1)).toMatchObject({
      email: 'priya@personal.test',
      displayName: 'Priya Joiner',
    });
  });

  it('the guest signs in through Entra and is linked to the person by object id', async () => {
    const cookie = await entraSignIn({
      oid: invites.sent.at(-1)!.objectId,
      email: 'priya@personal.test',
      name: 'Priya Joiner',
      groups: [PREJOINERS_GROUP],
    });
    cookies.guest = cookie;
    guest = as(app, cookie);
    const me = (await guest.get('/api/me').expect(200)).body as { personId: string };
    expect(me.personId).toBe(offer.person.personId);
  });

  it('someone else signing in with the same email is not linked', async () => {
    const cookie = await entraSignIn({
      oid: 'another-object-id',
      email: 'priya@personal.test',
      groups: [PREJOINERS_GROUP],
    });
    const me = (await as(app, cookie).get('/api/me').expect(200)).body as {
      personId: string | null;
    };
    expect(me.personId).toBeNull();
  });

  it('the portal shows Day 1: date, role, manager and start time', async () => {
    const { onboarding } = (await guest.get('/api/onboarding/me').expect(200)).body as {
      onboarding: OnboardingView;
    };
    expect(onboarding).toMatchObject({
      name: 'Priya Joiner',
      status: 'pre_joining',
      joiningDate: joining,
      daysToGo: 14,
      designation: 'Software Engineer',
      location: 'Chennai office',
      manager: 'Meena Manager',
      dayOne: { startTime: '09:30', endTime: '18:30' },
    });
    expect(onboarding.checklists).toEqual([
      expect.objectContaining({ name: 'Onboarding', done: 0, total: 1 }),
    ]);
    const hr = (await agents.hr!.get('/api/onboarding/me').expect(200)).body;
    expect(hr.onboarding).toBeNull();
  });

  it('before Day 1 the joiner completes KYC, a task with its document, and a policy (done-when #3)', async () => {
    const personId = offer.person.personId;
    await guest
      .post(`/api/people/${personId}/kyc`, { type: 'pan', value: 'ABCPV1234K' })
      .expect(201);
    const scan = await request(app.getHttpServer())
      .post(`/api/people/${personId}/documents`)
      .set('Cookie', cookies.guest!)
      .field('type', 'kyc_scan')
      .field('title', 'PAN card')
      .attach('file', PDF, { filename: 'pan.pdf', contentType: 'application/pdf' })
      .expect(201);

    const tasks = (await guest.get('/api/checklist-tasks/mine').expect(200)).body as MyTaskView[];
    const task = tasks.find((t) => t.title === 'Upload PAN')!;
    await guest
      .post(`/api/checklist-tasks/${task.id}/done`, { evidenceDocumentId: scan.body.id })
      .expect(201);

    const created = await agents
      .admin!.post('/api/policies', {
        code: 'CONDUCT',
        title: 'Code of conduct',
        appliesTo: {},
        requiresAcknowledgement: true,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/policies/${created.body.policyId}/versions`)
      .set('Cookie', cookies.admin!)
      .field('effectiveFrom', today)
      .attach('file', Buffer.from('%PDF-1.4\n% synthetic conduct\n'), {
        filename: 'Conduct.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    const [policy] = (await guest.get('/api/policies/mine').expect(200)).body as MyPolicyView[];
    expect(policy).toMatchObject({ code: 'CONDUCT', pending: true });
    await guest
      .post(`/api/policies/versions/${policy!.current.id}/accept`, {
        contentHash: policy!.current.contentHash,
      })
      .expect(201);

    const { onboarding } = (await guest.get('/api/onboarding/me').expect(200)).body as {
      onboarding: OnboardingView;
    };
    expect(onboarding.checklists[0]).toMatchObject({ done: 1, total: 1 });
  });

  it('the joiner sees only their own records', async () => {
    const people = (await agents.hr!.get('/api/people?q=Meena').expect(200)).body as {
      personId: string;
    }[];
    const status = (await guest.get(`/api/people/${people[0]!.personId}`)).status;
    expect([403, 404]).toContain(status);
    // Their own offer is HR's record, not theirs to read.
    expect((await guest.get('/api/offers').expect(200)).body).toEqual([]);
    await guest.get(`/api/offers/${offer.id}`).expect(404);
    const directory = (await guest.get('/api/people').expect(200)).body as { personId: string }[];
    expect(directory.map((p) => p.personId)).toEqual([offer.person.personId]);
  });

  it('a failed invitation is retried, and HR is told', async () => {
    invites.failNext = true;
    const failed = await acceptedOffer('Ravi Joiner', 'ravi@personal.test');
    expect(failed.guest?.status).toBe('failed');
    const notes = (await agents.hr!.get('/api/notifications').expect(200))
      .body as NotificationView[];
    expect(notes.some((n) => n.kind === 'prejoiner_invite_failed')).toBe(true);

    const result = await runWithContext({ tenantId: tenant }, () =>
      app.get(OffersService).retryInvites(),
    );
    expect(result.retried).toBe(1);
    const retried = (await agents.hr!.get(`/api/offers/${failed.id}`).expect(200)).body;
    expect(retried.guest.status).toBe('invited');
    // HR can also send it again.
    await agents.hr!.post(`/api/offers/${failed.id}/invite`).expect(201);
  });

  it('closing the offer ends the guest’s access', async () => {
    await agents
      .hr!.post(`/api/offers/${offer.id}/no-show`, { reason: 'Did not report' })
      .expect(201);
    await guest.get('/api/me').expect(401);
    const closed = (await agents.hr!.get(`/api/offers/${offer.id}`).expect(200)).body;
    expect(closed.guest.status).toBe('retired');
  });

  it('IT (admins until a named IT user is set) gets a task to remove the guest account (decision #58)', async () => {
    const tasks = (await agents.admin!.get('/api/checklist-tasks/mine').expect(200))
      .body as MyTaskView[];
    const task = tasks.find(
      (t) =>
        t.title === 'Remove the Entra guest account' && t.person.personId === offer.person.personId,
    );
    expect(task).toMatchObject({ checklist: 'Guest account removal', owner: 'Admins' });
    await agents.admin!.post(`/api/checklist-tasks/${task!.id}/done`, {}).expect(201);
  });
});
