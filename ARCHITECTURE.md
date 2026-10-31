# iPro architecture (Phase 1)

A modular monolith: one deployable API and one web app, with strict module boundaries so later phases (projects,
timesheets, payroll, appraisal, L&D, HRA) plug in as new modules without restructuring.

## Repository layout

```
ipro/
├── apps/
│   ├── api/                      NestJS
│   │   └── src/
│   │       ├── authz/            the ONLY place permissions are decided
│   │       ├── audit/            AuditLog writer, masking, field encryption (KMS)
│   │       ├── identity/         Entra ID OIDC, sessions, SCIM, roles & scopes, delegation
│   │       ├── org/              entities, BUs, departments, locations, cost centres, grades, designations, positions
│   │       ├── people/           Person, KYC, Engagement, Assignment, Compensation, Documents
│   │       ├── workflow/         state machines, Approval, checklists, escalation
│   │       ├── letters/          templates, PDF generation, esign adapter (Zoho Sign + fake)
│   │       ├── policies/         policy documents, acknowledgements, configurable HR rules
│   │       ├── attendance/       shifts, holidays, punches, AttendanceDay, regularisation, device adapter
│   │       ├── leave/            leave types, balances, requests, accrual
│   │       ├── hybrid/           work policies, bookings, seats, compliance
│   │       ├── lifecycle/        offer, onboarding, probation, in-life change, exit
│   │       ├── journey/          JournalEvent store and timeline queries
│   │       ├── inbox/            Action inbox aggregation and approval-card context
│   │       ├── notify/           notifications: Teams (Graph), email (Graph), in-app
│   │       ├── assistant/        Ask iPro: Bedrock client, tools, conversations, summaries
│   │       ├── reports/          Phase 1 reports
│   │       ├── imports/          CSV import, validation, migration back-fill
│   │       └── jobs/             pg-boss schedules (see spec: Scheduled jobs)
│   └── web/                      React + Vite PWA
│       └── src/
│           ├── design-system/    tokens, list/detail panel, approval card, status chips, "why" popover
│           ├── features/<module> one folder per API module
│           └── assistant/        Ask iPro side panel
├── packages/shared/              zod schemas, enums (event types, statuses), API types
├── infra/                        AWS CDK (ap-south-1; DR ap-south-2)
└── docs/
```

Rule: a module may call another module only through that module's exported service interface. Only `authz` decides
access; only `audit` writes AuditLog; only `journey` writes JournalEvent (other modules call `journey.record()`).

## Request path

```
Browser / Teams card / Ask iPro tool call
  → API controller (validates with zod schema from packages/shared)
  → authz.check(actor, action, resource)        — denies by default
  → module service (business rules from config)
  → Postgres transaction: domain rows + Approval/AuditLog + JournalEvent (same transaction)
  → after commit: notify (Teams/email/in-app) via pg-boss job
```

## Data conventions

- Postgres row-level security keyed on `tenant_id`, set per request with `SET LOCAL app.tenant_id`.
- Effective-dated tables use an exclusion constraint so two open rows for one engagement can't overlap.
- Sensitive columns (`*_encrypted`) hold envelope-encrypted values; plaintext never reaches logs.
- Money: `bigint` paise + `currency char(3)`. Business dates: `date`. Instants: `timestamptz`.
- Migrations are forward-only SQL committed with the code that needs them.

## Journey events

`JournalEvent(engagement_id, event_type, category, occurred_on, is_planned, title, detail_json, sensitivity,
source_table, source_id)`. Planned events (future-dated changes, due dates) are written with `is_planned = true` and
flipped when they happen. `sensitivity` drives filtering in `journey` queries via `authz`.

## Integrations (adapters with fakes for tests)

| Adapter | Real implementation | Fake |
| --- | --- | --- |
| identity | Entra ID OIDC + SCIM | local stub IdP with seeded users per role |
| esign | Zoho Sign API | in-memory signer |
| devices | biometric vendor API or on-site agent push | CSV/HTTP fake |
| notify | Microsoft Graph (Teams + mail) | in-memory outbox |
| llm | Amazon Bedrock, `in.` profile | scripted responses for tests |
| storage | S3 with KMS | MinIO |

## Ask iPro

- Tools are thin wrappers over existing API services (never direct SQL), each passing through `authz`.
- Haiku for lookups; Sonnet for policy answers, drafting and summaries (model IDs in config).
- Responses carry `sources[]` (screen links / policy clause ids) and optional `proposedAction` (a confirmation card).
- Confirming an action calls the normal API endpoint; the assistant itself never writes.

## Environments

- local (Docker), dev and staging (AWS, synthetic or anonymised data), production. Claude Code works in local and
  dev only. Production deploys are approved by a person.
