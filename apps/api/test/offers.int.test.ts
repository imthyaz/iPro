import type { INestApplication } from '@nestjs/common';
import type { ApprovalCard, ChecklistRunView, OfferView } from '@ipro/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { ESIGN_PROVIDER, type FakeEsign } from '../src/esign/esign.js';
import { OffersService } from '../src/offers/offers.service.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only.
const U = {
  admin: '00000000-0000-4000-8000-0000000f1001',
  hr: '00000000-0000-4000-8000-0000000f1002',
  hrHead: '00000000-0000-4000-8000-0000000f1003',
  mgr: '00000000-0000-4000-8000-0000000f1004',
};
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());
const joining = addDays(today, 20);

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
let fake: FakeEsign;
let managerEngagementId: string;
const agents: Record<string, ReturnType<typeof as>> = {};

const offerBody = (overrides: Record<string, unknown> = {}) => ({
  person: { legalName: 'Kavya Candidate', personalEmail: 'kavya@personal.test' },
  engagement: { legalEntityId: org.legalEntity, type: 'permanent', joiningDate: joining },
  assignment: {
    designationId: org.softwareEngineer,
    departmentId: org.engineering,
    locationId: org.chennai,
    managerEngagementId,
    bucket: 'billable',
  },
  // Software Engineer's synthetic band is ₹6–10 lakh a year.
  compensation: { amount: '90000000', rateUnit: 'year' },
  letterTemplateKey: 'offer',
  ...overrides,
});

const draft = async (overrides: Record<string, unknown> = {}) =>
  (await agents.hr!.post('/api/offers', offerBody(overrides)).expect(201)).body as OfferView;
const submit = async (id: string) =>
  (await agents.hr!.post(`/api/offers/${id}/submit`).expect(201)).body as OfferView;
const get = async (id: string) =>
  (await agents.hr!.get(`/api/offers/${id}`).expect(200)).body as OfferView;
const cards = async (who: string) =>
  (await agents[who]!.get('/api/approvals').expect(200)).body as ApprovalCard[];
const cardFor = async (who: string, offer: OfferView) =>
  (await cards(who)).find((c) => c.subject.personId === offer.person.personId);
const approve = async (who: string, offer: OfferView) => {
  const card = await cardFor(who, offer);
  expect(card, `${who} has a card`).toBeDefined();
  await agents[who]!.post(`/api/approvals/${card!.approvalId}/approve`, {}).expect(201);
};
const esignRequestOf = (offer: OfferView) =>
  [...fake.requests.entries()].find(([, e]) => e.request.reference === offer.letter?.id)?.[0];
const webhook = (requestId: string) =>
  request(app.getHttpServer())
    .post('/api/esign/webhook')
    .set('content-type', 'application/json')
    .send(JSON.stringify({ requestId }))
    .expect(204);
const journey = async (personId: string) =>
  (
    await pool.query<{ event_type: string; detail_json: Record<string, unknown> }>(
      `select event_type, detail_json from journal_event where person_id = $1 order by created_at`,
      [personId],
    )
  ).rows;
const engagementStatus = async (offer: OfferView) =>
  (await pool.query(`select status from engagement where id = $1`, [offer.engagementId])).rows[0]
    .status;

/** Draft → approved by the hiring manager → signed: an accepted offer. */
async function acceptedOffer(overrides: Record<string, unknown> = {}) {
  const offer = await submit((await draft(overrides)).id);
  await approve('mgr', offer);
  const sent = await get(offer.id);
  fake.sign(esignRequestOf(sent)!);
  await webhook(esignRequestOf(sent)!);
  return get(offer.id);
}

beforeAll(async () => {
  tenant = await newTenant(pool, 'Offer tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Of Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Of HR', ['employee', 'hr']);
  await addUser(db, tenant, U.hrHead, 'Of HR Head', ['employee', 'hr_head']);
  await addUser(db, tenant, U.mgr, 'Of Manager', ['employee', 'manager']);
  app = await createTestApp({ TENANT_ID: tenant });
  fake = app.get<FakeEsign>(ESIGN_PROVIDER);
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  const manager = await agents
    .hr!.post('/api/people', {
      person: { legalName: 'Mohan Manager' },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: email(U.mgr),
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
  agents.mgr = as(app, await signIn(app, U.mgr));

  await agents
    .admin!.put('/api/letter-templates/offer', {
      name: 'Offer letter',
      type: 'offer',
      body: `# Offer of employment

Dear {{person.legalName}},

We are pleased to offer you the role of {{assignment.designation}} in {{assignment.department}}, joining on {{engagement.joiningDate}}, at {{compensation.amount}}.`,
      approverRole: null,
      signature: 'employee',
    })
    .expect(200);
  await agents
    .admin!.put('/api/letter-templates/note', {
      name: 'Note',
      type: 'other',
      body: 'Dear {{person.legalName}}',
      approverRole: null,
      signature: 'none',
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
          requiresDocument: false,
        },
        {
          title: 'Laptop ready',
          owner: { kind: 'role', role: 'hr' },
          dueOffsetDays: 0,
          mandatory: true,
          requiresDocument: false,
        },
        {
          title: 'First week check-in',
          owner: { kind: 'manager' },
          dueOffsetDays: 7,
          mandatory: true,
          requiresDocument: false,
        },
      ],
    })
    .expect(200);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('drafting offers (H3)', () => {
  it('saves a draft: an offered engagement with a code, and no Joined event yet', async () => {
    const offer = await draft();
    expect(offer).toMatchObject({
      status: 'draft',
      bandCheck: 'within',
      needsHrHead: false,
      paid: true,
      designation: 'Software Engineer',
      hiringManager: 'Mohan Manager',
      joiningDate: joining,
    });
    expect(offer.employeeCode).toMatch(/^IDS-\d{4}$/);
    expect(await engagementStatus(offer)).toBe('offered');
    expect(await journey(offer.person.personId)).toEqual([]);
  });

  it('refuses a letter the candidate does not sign, interns without an end date and unpaid non-interns', async () => {
    await agents.hr!.post('/api/offers', offerBody({ letterTemplateKey: 'note' })).expect(400);
    await agents
      .hr!.post(
        '/api/offers',
        offerBody({
          engagement: { legalEntityId: org.legalEntity, type: 'intern', joiningDate: joining },
        }),
      )
      .expect(400);
    const unpaid = offerBody();
    delete (unpaid as Record<string, unknown>).compensation;
    await agents.hr!.post('/api/offers', unpaid).expect(400);
  });

  it('an unpaid internship has an end date and no band check (decision #56)', async () => {
    const intern = offerBody({
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'intern',
        joiningDate: joining,
        endDate: addDays(joining, 60),
      },
    });
    delete (intern as Record<string, unknown>).compensation;
    const offer = (await agents.hr!.post('/api/offers', intern).expect(201)).body as OfferView;
    expect(offer).toMatchObject({
      paid: false,
      bandCheck: 'no_band',
      needsHrHead: false,
      endDate: addDays(joining, 60),
    });
  });

  it('follows the permissions table', async () => {
    await agents.mgr!.post('/api/offers', offerBody()).expect(403);
    await agents.admin!.get('/api/offers').expect(403);
  });
});

describe('approval (spec workflow 1)', () => {
  it('within band: the hiring manager decides on the card; the letter goes out for signature', async () => {
    const offer = await submit((await draft()).id);
    expect(offer.status).toBe('pending_approval');
    expect(offer.letter?.status).toBe('ready');
    const card = await cardFor('mgr', offer);
    expect(card?.stepLabel).toBe('Hiring manager approval');
    expect(card?.changes).toEqual(
      expect.arrayContaining([
        { label: 'Role', from: null, to: 'Software Engineer' },
        { label: 'Pay', from: null, to: 'Within the grade band' },
      ]),
    );
    expect(await cardFor('hr', offer)).toBeUndefined();

    await approve('mgr', offer);
    const sent = await get(offer.id);
    expect(sent).toMatchObject({ status: 'offered', expiresOn: addDays(today, 7) });
    expect(sent.letter?.status).toBe('sent');
    expect(fake.requests.get(esignRequestOf(sent)!)!.request.signer.email).toBe(
      'kavya@personal.test',
    );
  });

  it('an offer above the grade band cannot be sent without HR head approval (done-when #1)', async () => {
    const offer = await submit(
      (await draft({ compensation: { amount: '120000000', rateUnit: 'year' } })).id,
    );
    expect(offer).toMatchObject({ bandCheck: 'above', needsHrHead: true });
    await approve('mgr', offer);
    const afterManager = await get(offer.id);
    expect(afterManager.status).toBe('pending_approval');
    expect(esignRequestOf(afterManager)).toBeUndefined();
    expect(await cardFor('hr', offer)).toBeUndefined();

    await approve('hrHead', offer);
    const sent = await get(offer.id);
    expect(sent.status).toBe('offered');
    expect(esignRequestOf(sent)).toBeDefined();
  });

  it('a day rate cannot be compared with the band, so HR head approves it too', async () => {
    const offer = await draft({ compensation: { amount: '800000', rateUnit: 'day' } });
    expect(offer).toMatchObject({ bandCheck: 'not_comparable', needsHrHead: true });
  });

  it('a returned offer goes back to draft and can be sent again', async () => {
    const offer = await submit((await draft()).id);
    const card = await cardFor('mgr', offer);
    await agents
      .mgr!.post(`/api/approvals/${card!.approvalId}/reject`, { comment: 'Joining date too late' })
      .expect(201);
    expect((await get(offer.id)).status).toBe('draft');
    const again = await submit(offer.id);
    expect(again.status).toBe('pending_approval');
    expect(again.approvalRequestId).not.toBe(offer.approvalRequestId);
    expect(again.letter?.id).toBe(offer.letter?.id);
  });
});

describe('acceptance and joining', () => {
  let accepted: OfferView;

  it('a signed offer creates the onboarding checklist from the joining date (done-when #2)', async () => {
    accepted = await acceptedOffer();
    expect(accepted.status).toBe('accepted');
    expect(await engagementStatus(accepted)).toBe('pre_joining');
    const runs = (
      await agents.hr!.get(`/api/people/${accepted.person.personId}/checklists`).expect(200)
    ).body as ChecklistRunView[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      templateName: 'Onboarding',
      anchorDate: joining,
      status: 'open',
    });
    expect(runs[0]!.tasks.map((t) => [t.title, t.dueOn])).toEqual([
      ['Upload PAN', addDays(joining, -3)],
      ['Laptop ready', joining],
      ['First week check-in', addDays(joining, 7)],
    ]);
    // The hiring manager owns their task before the joiner starts.
    const mine = (await agents.mgr!.get('/api/checklist-tasks/mine').expect(200)).body as {
      title: string;
    }[];
    expect(mine.map((t) => t.title)).toContain('First week check-in');
    expect((await journey(accepted.person.personId)).map((e) => e.event_type)).toEqual([
      'offer_accepted',
    ]);
  });

  it('joining waits for the joining date', async () => {
    await agents
      .hr!.post(`/api/offers/${accepted.id}/join`, { workEmail: 'kavya@test.ipro.test' })
      .expect(409);
  });

  it('on the day, Day-1 tasks come first; then the engagement is active with one Joined event', async () => {
    const offer = await acceptedOffer({
      engagement: { legalEntityId: org.legalEntity, type: 'permanent', joiningDate: today },
    });
    const blocked = await agents
      .hr!.post(`/api/offers/${offer.id}/join`, { workEmail: 'kavya.c@test.ipro.test' })
      .expect(409);
    expect(blocked.body.problems).toEqual(['Upload PAN', 'Laptop ready']);

    const [run] = (
      await agents.hr!.get(`/api/people/${offer.person.personId}/checklists`).expect(200)
    ).body as ChecklistRunView[];
    const task = (title: string) => run!.tasks.find((t) => t.title === title)!;
    await agents.hr!.post(`/api/checklist-tasks/${task('Upload PAN').id}/done`, {}).expect(201);
    await agents
      .hr!.post(`/api/checklist-tasks/${task('Laptop ready').id}/waive`, { reason: 'Brings own' })
      .expect(201);
    await agents.hr!.post(`/api/offers/${offer.id}/join`, { workEmail: email(U.mgr) }).expect(409);

    const joined = (
      await agents
        .hr!.post(`/api/offers/${offer.id}/join`, { workEmail: 'kavya.c@test.ipro.test' })
        .expect(201)
    ).body as OfferView;
    expect(joined.status).toBe('joined');
    expect(await engagementStatus(offer)).toBe('active');
    const events = await journey(offer.person.personId);
    expect(events.map((e) => e.event_type)).toEqual(['offer_accepted', 'joined']);
    expect(events[1]!.detail_json).toMatchObject({ viaOfferFlow: true });
  });

  it('a no-show closes the engagement and cancels onboarding', async () => {
    const noShow = (
      await agents
        .hr!.post(`/api/offers/${accepted.id}/no-show`, { reason: 'Took another offer' })
        .expect(201)
    ).body as OfferView;
    expect(noShow).toMatchObject({ status: 'no_show', closeReason: 'Took another offer' });
    expect(await engagementStatus(accepted)).toBe('withdrawn');
    const [run] = (
      await agents.hr!.get(`/api/people/${accepted.person.personId}/checklists`).expect(200)
    ).body as ChecklistRunView[];
    expect(run!.status).toBe('cancelled');
  });
});

describe('closing an offer', () => {
  it('declined at signing', async () => {
    const offer = await submit((await draft()).id);
    await approve('mgr', offer);
    const requestId = esignRequestOf(await get(offer.id))!;
    fake.decline(requestId);
    await webhook(requestId);
    expect(await get(offer.id)).toMatchObject({
      status: 'declined',
      closeReason: 'Declined at signing',
    });
    expect(await engagementStatus(offer)).toBe('withdrawn');
    expect((await journey(offer.person.personId)).map((e) => e.event_type)).toEqual([
      'offer_declined',
    ]);
  });

  it('withdrawn while waiting for approval: the request closes too', async () => {
    const offer = await submit((await draft()).id);
    const withdrawn = (
      await agents
        .hr!.post(`/api/offers/${offer.id}/withdraw`, { reason: 'Position frozen' })
        .expect(201)
    ).body as OfferView;
    expect(withdrawn.status).toBe('withdrawn');
    expect(await cardFor('mgr', offer)).toBeUndefined();
    await agents.hr!.post(`/api/offers/${offer.id}/withdraw`, { reason: 'Again' }).expect(409);
  });

  it('expires after the configured days, withdrawing the signing request', async () => {
    const offer = await submit((await draft()).id);
    await approve('mgr', offer);
    const requestId = esignRequestOf(await get(offer.id))!;
    const result = await runWithContext({ tenantId: tenant }, () =>
      app.get(OffersService).expireDue(new Date(`${addDays(today, 8)}T06:15:00+05:30`)),
    );
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const expired = await get(offer.id);
    expect(expired).toMatchObject({ status: 'declined', closeReason: 'Offer expired' });
    expect(expired.letter?.status).toBe('cancelled');
    expect(fake.requests.get(requestId)!.status.state).toBe('cancelled');
  });

  it('the database refuses a closed offer without a reason', async () => {
    const offer = await draft();
    await expect(
      withTenant(db, tenant, (tx) =>
        tx.execute(`update offer set status = 'declined' where id = '${offer.id}'` as never),
      ),
    ).rejects.toThrow();
  });
});

describe('the pipeline (H4)', () => {
  it('HR lists offers by status; a manager sees only their own hires', async () => {
    const all = (await agents.hr!.get('/api/offers').expect(200)).body as OfferView[];
    const declined = (await agents.hr!.get('/api/offers?status=declined').expect(200))
      .body as OfferView[];
    expect(declined.length).toBeGreaterThan(0);
    expect(declined.every((o) => o.status === 'declined')).toBe(true);
    expect(all.length).toBeGreaterThan(declined.length);

    const managerView = (await agents.mgr!.get('/api/offers').expect(200)).body as OfferView[];
    const live = managerView.filter((o) =>
      ['draft', 'pending_approval', 'offered', 'accepted'].includes(o.status),
    );
    expect(live.length).toBeGreaterThan(0);
    expect(managerView.every((o) => o.hiringManager === 'Mohan Manager')).toBe(true);
  });
});
