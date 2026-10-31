// Synthetic seed data only. Never put real Ideassion people data here.
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Role } from '@ipro/shared';
import { loadConfig } from '../config.js';
import * as schema from './schema.js';
import { seedOrg } from './seed-org.js';
import { seedPeople } from './seed-people.js';
import { withTenant } from './tenant-context.js';

export const DEV_TENANT_ID = '00000000-0000-4000-8000-000000000001';

/** One dev sign-in user per role, plus a manager who is also an employee. Fixed ids keep links stable. */
const devUsers: { id: string; displayName: string; email: string; roles: Role[] }[] = [
  {
    id: '00000000-0000-4000-8000-000000000101',
    displayName: 'Dev Employee',
    email: 'employee@dev.ipro.test',
    roles: ['employee'],
  },
  {
    id: '00000000-0000-4000-8000-000000000102',
    displayName: 'Dev Manager',
    email: 'manager@dev.ipro.test',
    roles: ['employee', 'manager'],
  },
  {
    id: '00000000-0000-4000-8000-000000000103',
    displayName: 'Dev Manager Two',
    email: 'manager2@dev.ipro.test',
    roles: ['employee', 'manager'],
  },
  {
    id: '00000000-0000-4000-8000-000000000104',
    displayName: 'Dev HR',
    email: 'hr@dev.ipro.test',
    roles: ['employee', 'hr'],
  },
  {
    id: '00000000-0000-4000-8000-000000000105',
    displayName: 'Dev HR Head',
    email: 'hrhead@dev.ipro.test',
    roles: ['employee', 'hr_head'],
  },
  {
    id: '00000000-0000-4000-8000-000000000106',
    displayName: 'Dev CXO',
    email: 'cxo@dev.ipro.test',
    roles: ['employee', 'cxo'],
  },
  {
    id: '00000000-0000-4000-8000-000000000107',
    displayName: 'Dev Admin',
    email: 'admin@dev.ipro.test',
    roles: ['admin'],
  },
];

const config = loadConfig();
const tenantId = config.TENANT_ID;
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const db = drizzle({ client: pool, schema });

// The tenant row itself is created as the owner; everything under it goes through row-level security.
await db
  .insert(schema.tenants)
  .values({ id: tenantId, name: 'Ideassion (dev)' })
  .onConflictDoNothing();

await withTenant(db, tenantId, async (tx) => {
  await seedOrg(tx, tenantId);
  for (const user of devUsers) {
    const [existing] = await tx
      .select({ id: schema.appUsers.id })
      .from(schema.appUsers)
      .where(eq(schema.appUsers.id, user.id));
    if (existing) continue;
    await tx.insert(schema.appUsers).values({
      id: user.id,
      tenantId,
      email: user.email,
      displayName: user.displayName,
    });
    await tx
      .insert(schema.roleAssignments)
      .values(
        user.roles.map((role) => ({ tenantId, userId: user.id, role, source: 'manual' as const })),
      );
  }
  await seedPeople(tx, tenantId);
});

await pool.end();
process.stdout.write(`Seeded tenant ${tenantId} with ${devUsers.length} dev users\n`);
