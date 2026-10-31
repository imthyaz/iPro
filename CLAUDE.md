# iPro — instructions for Claude Code

iPro is a workforce management application: one record of each person's working life from offer to exit, with
attendance, leave, hybrid (WFH/office) planning, journey timelines and an AI assistant. Later phases add projects,
timesheets, India payroll, appraisals, L&D and HR accounting. First customer: Ideassion (India, ~150 people).

We are building **Phase 1** (Foundation). Everything outside Phase 1 is out of scope unless a task says otherwise.

## Sources of truth (read before any task)

1. `docs/phase1-build-spec.md` — what to build: data model, workflows, rules, screens, permissions, jobs,
   integrations, acceptance criteria.
2. `docs/product-requirements.md` (optional, if present) — the whole product, for context on later phases.
3. `docs/decisions.md` — decisions already made. Do not reopen them.
4. `BUILD_PLAN.md` — the order of work, slice by slice.
5. `ARCHITECTURE.md` — how the code is organised.

If the spec is silent or ambiguous: do not invent HR policy. Use the "proposed default" from the business rules
table, make it a configurable setting, and add the question to `docs/open-questions.md`.

## Stack (fixed)

- TypeScript everywhere. pnpm monorepo: `apps/api` (NestJS), `apps/web` (React + Vite, installable PWA),
  `packages/shared` (zod schemas and types shared by api and web), `infra/` (AWS CDK).
- PostgreSQL 16 with Drizzle ORM and SQL migrations. Background jobs with pg-boss (Postgres-backed; no extra infra).
- Tests: Vitest (unit, integration against a real Postgres in Docker), Playwright (end-to-end).
- AWS ap-south-1 (Mumbai), DR in ap-south-2 (Hyderabad): ECS Fargate, RDS PostgreSQL, S3, KMS, Secrets Manager.
- Sign-in: Microsoft Entra ID via OIDC; SCIM provisioning; Entra groups map to iPro roles.
- Notifications: Microsoft Teams (default, actionable approval cards) + email via Microsoft Graph.
- E-signature: Zoho Sign behind our own `esign` adapter interface. Policy acknowledgements are in-app (no provider).
- AI: Amazon Bedrock, Claude models, India geographic inference profile only (model IDs start with `in.`).

## Non-negotiable rules

**Data**
- Effective dating: Assignment and Compensation rows have `effective_from`/`effective_to`; exactly one open row per
  engagement at any date. Never update history in place — close the row and open a new one. Org units
  (BusinessUnit, Department, Location) are effective-dated too (decision #21).
- Every workflow's final transition writes one `JournalEvent` (append-only). Timelines read only from JournalEvent.
- Nothing is hard-deleted except by the retention job. Deletes are soft and audited.
- Money is stored as integer paise (`bigint`) with a currency code. Never floats.
- Timestamps stored in UTC; business dates (leave days, attendance days) stored as `date` in the location's timezone
  (Asia/Kolkata for Phase 1).
- All tables carry `id, tenant_id, created_at, created_by, updated_at, updated_by`.
- HR policies (leave, shifts, probation, notice, hybrid, approvals) are configuration rows, never constants in code.

**Security and privacy**
- Every API request goes through the single permissions module (`apps/api/src/authz`). It implements the
  permissions table in the spec. No permission checks scattered in controllers.
- KYC values and compensation are encrypted at field level (KMS data keys). KYC is masked (last 4) unless the role may
  unmask; every unmask and every compensation read writes an AuditLog row.
- Never log personal data (names, emails, KYC, salary). Log ids only.
- Never commit secrets. Use `.env` locally (see `.env.example`) and Secrets Manager in AWS.
- Seed and test data are synthetic. Never put real employee data in fixtures, tests, prompts or commits.
- Never run anything against production. You work in local and dev only.

**AI assistant (Ask iPro)**
- The assistant calls iPro's own API as the signed-in user, through the same permissions module.
- Every figure comes from an API/tool result, never from model knowledge. If no tool answers, say so.
- Any change is returned as a confirmation card; nothing changes until the user confirms. Exits, terminations and
  compensation changes can be drafted but not completed from chat.
- Model IDs come from config and must start with `in.`; a startup check and a CI test enforce this.
- Conversations kept 180 days, then replaced by an archived summary; confirmed actions stay in the audit log.

**UI (built for a lean team)**
- Home is the Action inbox. Approval cards carry the context needed to decide (balance after, who else is off,
  policy fit) — no click-through to decide.
- Dashboards lead with exceptions; every number opens the list behind it with the action next to each row.
- Check-in 1 tap; apply leave ≤ 3 taps; approve 1 tap/swipe on mobile.
- Every computed number has a "why" showing the calculation.
- Reversible actions get an undo window; irreversible ones confirm first.
- One layout pattern everywhere: list → detail side panel. Same filters, status colours and words in every module.
- Mobile-first for employee and manager screens; WCAG 2.1 AA.

## How to work

- Work one slice from `BUILD_PLAN.md` at a time. Start by restating the slice's scope and its "done when" list.
- Write tests from the acceptance criteria first, then the code.
- Before saying a task is done: `pnpm lint && pnpm typecheck && pnpm test` must pass, and e2e for touched flows.
- Keep pull requests small and focused on one slice or sub-slice. Write a clear PR description listing what changed,
  how it was tested and any open questions.
- Record any new decision in `docs/decisions.md`; record unanswered questions in `docs/open-questions.md`.
- Prefer boring, well-known libraries. Ask before adding a new dependency that isn't listed above.

## Commands (created in slice 0)

- `pnpm dev` — api + web + local Postgres (Docker)
- `pnpm test` / `pnpm test:e2e` / `pnpm lint` / `pnpm typecheck`
- `pnpm db:migrate` / `pnpm db:seed` (synthetic data only)
