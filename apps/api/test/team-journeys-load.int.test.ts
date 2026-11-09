import type { INestApplication } from '@nestjs/common';
import type { TeamJourneysView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Slice 10 done-when #3: the team view loads 150 people over 3 years in under 3 seconds.
// Synthetic people only: 150 hires through the API, then three years of journal events each.
const HR = '00000000-0000-4000-8000-000000616001';
const PEOPLE = 150;
const today = businessDate(new Date());
const from = addDays(today, -3 * 365);
const to = addDays(today, 183);

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let hr: ReturnType<typeof as>;

beforeAll(async () => {
  tenant = await newTenant(pool, 'Team journey load test');
  const org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, HR, 'Load HR', ['employee', 'hr']);
  app = await createTestApp({ TENANT_ID: tenant });
  hr = as(app, await signIn(app, HR));
  const hires: { personId: string; engagementId: string }[] = [];
  for (let start = 0; start < PEOPLE; start += 10) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(10, PEOPLE - start) }, (_, k) => {
        const i = start + k;
        // Joined across the last three years, managers among the first ten.
        const joined = addDays(from, Math.max(0, (i * 7) % (3 * 365 - 30)));
        return hr
          .post('/api/people', {
            person: { legalName: `Load Person ${i}` },
            engagement: {
              legalEntityId: org.legalEntity,
              type: 'permanent',
              workEmail: `load-${i}@test.ipro.test`,
              joiningDate: joined < '2023-04-01' ? '2023-04-01' : joined,
            },
            assignment: {
              designationId: org.softwareEngineer,
              departmentId: i % 2 ? org.engineering : org.peopleOps,
              locationId: org.chennai,
              bucket: 'billable',
            },
          })
          .expect(201)
          .then((r) => r.body as { personId: string; engagementId: string });
      }),
    );
    hires.push(...batch);
  }
  // About 18 more events a person, spread across three years (leave, attendance, career).
  await pool.query(
    `insert into journal_event (tenant_id, engagement_id, person_id, event_type, category,
       occurred_on, title, sensitivity, source_table, source_id)
     select $1, h.engagement_id, h.person_id,
       (array['leave_approved','attendance_regularised','assignment_changed'])[1 + (n % 3)],
       (array['leave','attendance','role'])[1 + (n % 3)],
       ($2::date + (n * 60 + (h.k % 30)))::date,
       'Load event ' || n, 'manager', 'load_test', gen_random_uuid()
     from (select unnest($3::uuid[]) as engagement_id, unnest($4::uuid[]) as person_id,
             generate_subscripts($3::uuid[], 1) as k) h
     cross join generate_series(0, 17) as n`,
    [tenant, from, hires.map((h) => h.engagementId), hires.map((h) => h.personId)],
  );
}, 300_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('team journeys at Ideassion size (slice 10 done-when #3)', () => {
  it('loads 150 people over 3 years in under 3 seconds', async () => {
    const timings: number[] = [];
    let view: TeamJourneysView | null = null;
    for (let run = 0; run < 2; run++) {
      const started = performance.now();
      const res = await hr.get(`/api/journeys/team?scope=all&from=${from}&to=${to}`).expect(200);
      timings.push(performance.now() - started);
      view = res.body as TeamJourneysView;
    }
    expect(view!.people.length).toBeGreaterThanOrEqual(PEOPLE);
    const events = view!.people.reduce((n, x) => n + x.events.length, 0);
    expect(events).toBeGreaterThanOrEqual(PEOPLE * 18);
    // The first (cold) load counts too.
    expect(Math.max(...timings)).toBeLessThan(3000);
  });
});
