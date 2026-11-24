import { readFileSync, writeFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { roles, type Role } from '@ipro/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RouteAccess } from '../src/authz/decorators.js';
import { permissions, type Action, type DataArea } from '../src/authz/permissions.js';
import { addUser, newTenant, signIn, testDb } from './helpers.js';
import { concrete, listRoutes, type RouteInfo } from './routes.js';
import { createTestApp } from './test-app.js';

/**
 * Slice 14 done-when #1 (decision #96): every route the API serves, for every role, including the
 * denied ones. Record-level rules (own, team, entity, conditions) are tested in each module's file;
 * this suite proves the route-level gate matches the spec's permissions table for all 193+ routes,
 * and fails when a new route arrives without being reviewed here.
 */

/** Routes open without a session, and what protects each one instead. */
const PUBLIC: Record<string, string> = {
  'GET /api/health': 'Liveness and readiness; no data',
  'GET /api/health/live': 'Liveness; no data',
  'GET /api/auth/mode': 'Says which sign-in to show; no data',
  'GET /api/auth/login': 'Starts Entra sign-in (404 unless Entra is configured)',
  'GET /api/auth/callback': 'Entra sign-in return; checks state, nonce and PKCE',
  'GET /api/auth/dev/users': 'Synthetic dev users; 404 unless dev sign-in (refused in production)',
  'POST /api/auth/dev/login': 'Dev sign-in; 404 unless dev sign-in (refused in production)',
  'POST /api/biometric/punches': 'Biometric devices; each device’s own key (x-device-key)',
  'POST /api/esign/webhook':
    'Zoho Sign callbacks; HMAC-signed, and only prompt a re-read from Zoho',
  'POST /api/teams/messages': 'Teams bot; Bot Framework token in the Authorization header',
};

/**
 * Routes for any signed-in user. Each one acts only on the caller's own items (their approvals,
 * notifications, tasks, conversations) or checks the record itself with AuthzService.
 */
const SIGNED_IN = new Set([
  'GET /api/approvals',
  'POST /api/approvals/:id/approve',
  'POST /api/approvals/:id/reject',
  'POST /api/approvals/bulk-approve',
  'POST /api/assistant/actions/:id/cancel',
  'POST /api/assistant/actions/:id/confirm',
  'GET /api/assistant/archive',
  'POST /api/assistant/ask',
  'GET /api/assistant/conversations',
  'GET /api/assistant/conversations/:id',
  'GET /api/attendance/today',
  'POST /api/auth/logout',
  'GET /api/check-ins',
  'POST /api/check-ins/:id',
  'POST /api/checklist-tasks/:id/done',
  'GET /api/checklist-tasks/mine',
  'GET /api/leave-types',
  'GET /api/me',
  'GET /api/notification-preferences',
  'PUT /api/notification-preferences',
  'GET /api/notifications',
  'POST /api/notifications/:id/read',
  'POST /api/notifications/read-all',
  'GET /api/onboarding/me',
  'GET /api/policies/:id/clauses',
  'GET /api/policies/mine',
  'POST /api/policies/versions/:id/accept',
  'POST /api/policies/versions/:id/link',
  'GET /api/reviews',
  'GET /api/reviews/:id',
  'POST /api/reviews/:id/submit',
  'GET /api/workflows',
  'POST /api/workflows',
  'GET /api/workflows/:id',
  'POST /api/workflows/:id/comments',
  'POST /api/workflows/:id/resubmit',
  'POST /api/workflows/:id/withdraw',
]);

/** Writes (POST and the like) gated only by a read grant: each must change nothing. */
const READ_ONLY_WRITES: Record<string, string> = {
  'POST /api/people/:id/documents/:documentId/link': 'Issues a short-lived download link',
};

/** Users with one role, and with the role sets people really hold. */
const USERS: { label: string; roles: Role[] }[] = [
  ...roles.map((role) => ({ label: role, roles: [role] })),
  { label: 'employee+manager', roles: ['employee', 'manager'] },
  { label: 'employee+hr', roles: ['employee', 'hr'] },
  { label: 'employee+hr_head', roles: ['employee', 'hr_head'] },
  { label: 'employee+cxo', roles: ['employee', 'cxo'] },
];

const key = (r: RouteInfo) => `${r.method} ${r.path}`;
const grantsOf = (access: RouteAccess): [DataArea, Action][] =>
  access.kind === 'authorize'
    ? [[access.area, access.action]]
    : access.kind === 'authorize-any'
      ? [...access.grants]
      : [];
/** Whether some role in the set holds some grant that opens the route, at any scope. */
const opens = (held: readonly Role[], access: RouteAccess) =>
  grantsOf(access).some(([area, action]) =>
    held.some((role) =>
      permissions[role].some((g) => g.area === area && g.actions.includes(action)),
    ),
  );

const send = (app: INestApplication, route: RouteInfo, cookie?: string) => {
  const server = app.getHttpServer();
  const url = concrete(route.path);
  const verb = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  const req = request(server)[verb](url);
  if (cookie) req.set('Cookie', cookie);
  return verb === 'get' || verb === 'delete' ? req : req.send({});
};

const { pool, db } = testDb();
let app: INestApplication;
let routes: RouteInfo[];
const cookies: Record<string, string> = {};

beforeAll(async () => {
  const tenant = await newTenant(pool, 'Permissions regression tests');
  app = await createTestApp({ TENANT_ID: tenant });
  routes = listRoutes(app);
  for (const [i, user] of USERS.entries()) {
    const id = `00000000-0000-4000-8000-0000007140${String(i).padStart(2, '0')}`;
    await addUser(db, tenant, id, `Pr ${user.label}`, user.roles);
    cookies[user.label] = await signIn(app, id);
  }
}, 120_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('route inventory (decision #96)', () => {
  it('every route declares who may call it', () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(routes.filter((r) => !r.access).map(key)).toEqual([]);
  });

  it('public routes are exactly the reviewed list', () => {
    expect(
      routes
        .filter((r) => r.access?.kind === 'public')
        .map(key)
        .sort(),
    ).toEqual(Object.keys(PUBLIC).sort());
  });

  it('signed-in-only routes are exactly the reviewed list', () => {
    expect(
      routes
        .filter((r) => r.access?.kind === 'signed-in')
        .map(key)
        .sort(),
    ).toEqual([...SIGNED_IN].sort());
  });

  it('writes are not gated by a read grant alone, except the reviewed ones', () => {
    const readOnly = routes.filter(
      (r) =>
        r.method !== 'GET' &&
        r.access &&
        grantsOf(r.access).length > 0 &&
        grantsOf(r.access).every(([, action]) => action === 'read'),
    );
    expect(readOnly.map(key).sort()).toEqual(Object.keys(READ_ONLY_WRITES).sort());
  });

  it('docs/route-permissions.md is up to date', () => {
    const file = new URL('../../../docs/route-permissions.md', import.meta.url);
    const text = routeTable(routes);
    if (process.env.UPDATE_ROUTE_TABLE) writeFileSync(file, text);
    expect(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).toBe(text);
  });
});

describe('denied without a session', () => {
  it('every route except the public ones answers 401', async () => {
    const wrong: string[] = [];
    for (const route of routes.filter((r) => r.access?.kind !== 'public')) {
      const res = await send(app, route);
      if (res.status !== 401) wrong.push(`${key(route)} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('the public routes that act refuse callers without their own credential', async () => {
    const server = app.getHttpServer();
    // No device key, no bot token.
    const punch = {
      punches: [{ employeeCode: 'IDS-0001', at: '2026-11-09T09:28:00+05:30', externalId: 'p1' }],
    };
    expect((await request(server).post('/api/biometric/punches').send(punch)).status).toBe(401);
    expect((await request(server).post('/api/teams/messages').send({})).status).toBe(401);
    // A webhook only prompts iPro to re-read the request from the provider; an unknown or unsigned
    // one is ignored (the production secret is required, decision #96).
    expect((await request(server).post('/api/esign/webhook').send({ requestId: 'x' })).status).toBe(
      204,
    );
    // Entra sign-in isn't configured in tests: its routes don't exist.
    expect((await request(server).get('/api/auth/login')).status).toBe(404);
    expect((await request(server).get('/api/auth/callback')).status).toBe(404);
  });
});

describe('denied by role (slice 14 done-when #1)', () => {
  for (const user of USERS) {
    it(`${user.label}: every route outside its grants answers 403`, async () => {
      const denied = routes.filter(
        (r) =>
          (r.access?.kind === 'authorize' || r.access?.kind === 'authorize-any') &&
          !opens(user.roles, r.access),
      );
      expect(denied.length).toBeGreaterThan(0);
      const wrong: string[] = [];
      for (const route of denied) {
        const res = await send(app, route, cookies[user.label]);
        if (res.status !== 403) wrong.push(`${key(route)} → ${res.status}`);
      }
      expect(wrong).toEqual([]);
    });
  }

  it('admin reaches no people data (spec: configuration, not people data)', () => {
    const peopleAreas = new Set<DataArea>(['org_config', 'users_roles', 'audit_log']);
    const admin = routes.filter(
      (r) =>
        (r.access?.kind === 'authorize' || r.access?.kind === 'authorize-any') &&
        opens(['admin'], r.access),
    );
    for (const route of admin) {
      const via = grantsOf(route.access!).filter(([area, action]) =>
        permissions.admin.some((g) => g.area === area && g.actions.includes(action)),
      );
      expect(
        via.every(([area]) => peopleAreas.has(area)),
        key(route),
      ).toBe(true);
    }
  });
});

/** The reviewed table of every route and the roles its gate lets through. */
function routeTable(all: RouteInfo[]): string {
  const cell = (r: RouteInfo) => {
    const a = r.access!;
    if (a.kind === 'public') return `public: ${PUBLIC[key(r)]}`;
    if (a.kind === 'signed-in') return 'any signed-in user';
    return grantsOf(a)
      .map(([area, action]) => `${area} ${action}`)
      .join(' or ');
  };
  const who = (r: RouteInfo) => {
    const a = r.access!;
    if (a.kind === 'public') return 'anyone';
    if (a.kind === 'signed-in') return 'all';
    return roles.filter((role) => opens([role], a)).join(', ') || 'nobody';
  };
  const lines = [
    '# Route permissions',
    '',
    'Generated by `apps/api/test/permissions-regression.int.test.ts` (decision #96); regenerate with',
    '`UPDATE_ROUTE_TABLE=1 pnpm --filter @ipro/api exec vitest run test/permissions-regression.int.test.ts`.',
    'Every route the API serves, the grant its gate needs and the roles that hold it. Each service then',
    'checks the record itself (own, team or legal entity, and the table’s conditions).',
    '',
    `${all.length} routes.`,
    '',
    '| Route | Needs | Roles |',
    '| --- | --- | --- |',
    ...all.map((r) => `| \`${key(r)}\` | ${cell(r)} | ${who(r)} |`),
    '',
  ];
  return lines.join('\n');
}
