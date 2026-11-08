import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { JourneyService } from '../src/journey/journey.service.js';
import { TenantDb } from '../src/db/tenant-db.js';
import { WorkflowActions } from '../src/workflow/actions.js';
import { builtInDefinitions } from '../src/workflow/built-in-definitions.js';
import { addUser, newTenant, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Slice 10 done-when #1: every workflow's final step writes its event; none is written twice.
const ADMIN = '00000000-0000-4000-8000-000000613001';

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;

beforeAll(async () => {
  tenant = await newTenant(pool, 'Journey coverage tests');
  const org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, ADMIN, 'Jc Admin', ['admin']);
  app = await createTestApp({ TENANT_ID: tenant });
  void org;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('every workflow writes its event on the final step', () => {
  it('names the event each built-in workflow writes, by definition or by its action', () => {
    const actions = app.get(WorkflowActions);
    const missing = Object.entries(builtInDefinitions)
      .filter(([, def]) => !def.journey && !(actions.get(def.onApproved).records?.length ?? 0))
      .map(([key]) => key);
    expect(missing).toEqual([]);
  });

  it('records the same source and event once only', async () => {
    const event = {
      engagementId: '00000000-0000-4000-8000-000000613101',
      personId: '00000000-0000-4000-8000-000000613102',
      eventType: 'coverage_test',
      category: 'lifecycle',
      occurredOn: '2026-11-08',
      title: 'Coverage test',
      sensitivity: 'public' as const,
      sourceTable: 'coverage',
      sourceId: '00000000-0000-4000-8000-000000613103',
    };
    const journey = app.get(JourneyService);
    const results = await runWithContext({ tenantId: tenant }, () =>
      app
        .get(TenantDb)
        .tx(async (tx) => [await journey.record(tx, event), await journey.record(tx, event)]),
    );
    expect(results).toEqual([true, false]);
    const { rows } = await pool.query(
      `select count(*)::int as n from journal_event where tenant_id = $1 and source_id = $2`,
      [tenant, event.sourceId],
    );
    expect(rows[0].n).toBe(1);
  });
});
