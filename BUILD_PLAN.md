# iPro Phase 1 — build plan

Build in this order. Each slice ends with working, tested software in the dev environment. Section names refer to
`docs/phase1-build-spec.md`. Start each slice in Claude Code with the `/next-slice` command or the prompt in
`prompts/slice.md`.

Status legend: [ ] not started · [~] in progress · [x] done

---

## [~] Slice 0 — Repository and environments

**Scope:** pnpm monorepo (`apps/api`, `apps/web`, `packages/shared`, `infra`), lint/format/typecheck, Vitest,
Playwright, Docker Compose Postgres, Drizzle set-up, pg-boss, CI (GitHub Actions: lint, typecheck, unit,
integration, e2e), CDK skeleton for dev in ap-south-1 (not deployed until the account owner provides credentials).

**Done when**
- [ ] `pnpm dev` starts api, web and Postgres; health endpoint returns OK; web shows a placeholder shell.
- [ ] CI runs on every PR and blocks merge on failure.
- [x] `.env.example` lists every variable; no secrets in the repo.

## [ ] Slice 1 — Identity, roles, permissions, audit

**Spec:** Permissions; Technical decisions (Identity, Audit); Data model (AuditLog, Approval).

**Scope:** Entra ID OIDC sign-in (with a local dev stub identity provider), sessions, roles and scopes (own, team,
entity), the central `authz` module implementing the permissions table, AuditLog writes, KMS field-encryption helper,
masking helper, delegation of approvals.

**Done when**
- [ ] Every role in the permissions table has automated tests for allowed and denied actions.
- [ ] Compensation and KYC reads write audit rows with actor and time.
- [ ] A manager on leave can delegate approvals for a date range.

## [ ] Slice 2 — Organisation and people

**Spec:** Data model (Organisation, People); Screens A1, H1, H2, H10, E7.

**Scope:** Tenant, LegalEntity, BusinessUnit, Department, Location, CostCentre, Grade, Designation, Position; Person,
KycRecord, EmergencyContact, Engagement, Assignment (effective-dated), Compensation (effective-dated), Document
storage on S3 (local: MinIO). Org tree as of a date. People directory and person record.

**Done when**
- [ ] Creating a person with an engagement and assignment takes under 3 minutes and produces a Joined event.
- [ ] The org tree for any past date matches the assignments effective on that date.
- [ ] A retainer converted to payroll keeps one person record and one continuous journey.
- [ ] KYC values are masked for everyone except HR; each unmask writes an audit row.

## [ ] Slice 3 — Workflow engine, letters, signatures

**Spec:** Workflows (shared rules); Data model (ChecklistTemplate/Run, LetterTemplate, Approval); Integrations
(Zoho Sign, policy acknowledgements); Screens A3.

**Scope:** generic state machine with Approval steps, escalation and comments; checklist templates and runs; letter
templates with merge fields and versions, PDF generation; `esign` adapter with Zoho Sign implementation and a fake for
tests; in-app policy acknowledgement (PolicyAcknowledgement with document version and content hash).

**Done when**
- [ ] A workflow defined in config runs end to end with approve, reject (comment required) and escalation.
- [ ] A letter generated from a template is versioned and stored as a Document; signing via the fake adapter
      completes the document.
- [ ] Publishing a new policy version re-opens acknowledgement for everyone it applies to.

## [ ] Slice 4 — Pre-boarding and onboarding

**Spec:** Workflow 1 (Offer to joining), Workflow 2 (Onboarding checklist); Screens H3, H4, H5, E11.

**Done when**
- [ ] An offer above the grade band cannot be sent without HR head approval.
- [ ] A signed offer creates the onboarding checklist with due dates computed from the joining date.
- [ ] A new joiner can complete KYC uploads and policy sign-offs on a phone before Day 1.

## [ ] Slice 5 — Probation and in-life changes

**Spec:** Workflow 3 (Probation), Workflow 8 (In-life change); Screens H6, H7, M5.

**Done when**
- [ ] Reminders arrive at 30, 14 and 7 days; an overdue review escalates.
- [ ] Confirm, extend and terminate each produce the right letter and journey event.
- [ ] A designation change effective next month shows as upcoming on the journey and applies automatically that day.

## [ ] Slice 6 — Attendance

**Spec:** Data model (Shift, HolidayCalendar, AttendanceDay, Punch); Workflow 5 (Regularisation); Business rules;
Scheduled jobs (Attendance build, Biometric import); Screens E1, E2, E3, H9.

**Done when**
- [ ] Biometric punches (via the device adapter; fake in tests) appear within 15 minutes.
- [ ] Check-in from a phone records location and mode; outside the geofence it is flagged.
- [ ] Approved leave, holidays and weekly offs show correctly on the attendance calendar.

## [ ] Slice 7 — Leave

**Spec:** Data model (LeaveType, LeaveBalance, LeaveRequest); Workflow 4; Business rules (leave rows); Scheduled jobs
(Leave accrual); Screens E4, E5.

**Done when**
- [ ] A full month of accruals for all leave types matches a hand-calculated sample of 10 synthetic people.
- [ ] Leave balances imported from a CSV match the source for every person.
- [ ] The monthly attendance and LOP export matches a hand count for the same synthetic month.

## [ ] Slice 8 — Hybrid planner

**Spec:** Data model (WorkPolicy, WorkBooking, Seat); Workflow 6; Screens E6, M2, M3, M4.

**Done when**
- [ ] Booking within policy confirms instantly; below policy asks for approval.
- [ ] Seat booking blocks double-booking of a seat.
- [ ] The compliance report shows planned vs actual office days per person per week.

## [ ] Slice 9 — Exit

**Spec:** Workflow 7 (Exit); Screens E10, H8.

**Done when**
- [ ] Accepting a resignation creates the exit checklist and sets the last working day from the notice rules.
- [ ] Access is disabled at the end of the last working day (Entra via SCIM; fake in tests).
- [ ] Relieving and experience letters generate only after all clearance tasks are done.

## [ ] Slice 10 — Journey timelines

**Spec:** Data model (JournalEvent); Screens E8, M6, H11. Visual reference: the timeline designs (exited, current,
compact, team) in the design canvas linked from the product requirements.

**Done when**
- [ ] Every workflow's final step writes the correct event; no event is written twice.
- [ ] A manager cannot see compensation or exit-reason events for their team.
- [ ] The team view loads 150 people over 3 years in under 3 seconds.

## [ ] Slice 11 — Action inbox, notifications, Teams

**Spec:** Experience for a lean team; Notifications and scheduled jobs; Integrations (Microsoft Teams); Screens X1, X3.

**Done when**
- [ ] A manager can clear 10 pending leave requests from the Action inbox in under 1 minute on a phone.
- [ ] Each approval card shows the context listed in the design rules without opening another screen.
- [ ] Approving from a Teams card is recorded exactly like approving in iPro (same authz check, same audit row).

## [ ] Slice 12 — Ask iPro

**Spec:** AI assistant — Ask iPro; Technical decisions (AI assistant stack); Screen X2.

**Done when**
- [ ] The assistant answers a test set of 50 Phase 1 questions; every figure matches the matching report.
- [ ] Asked about someone outside their scope, a manager gets a refusal, not data.
- [ ] No assistant action changes data without a confirmation tap; every confirmed action is in the audit log.
- [ ] Policy answers link to the clause they came from; questions with no source get "I don't know" and a link to HR.
- [ ] Only `in.` model IDs can be configured (startup check + CI test).
- [ ] Conversations older than 180 days are summarised and archived by the retention job.

## [ ] Slice 13 — Reports, import and migration

**Spec:** Screen H12, A6; Integrations and data migration.

**Done when**
- [ ] Phase 1 reports (headcount, joiners/leavers, attrition, absenteeism, leave liability, hybrid compliance, seat
      occupancy) match hand-calculated values on the synthetic data set.
- [ ] The import tool rejects files with duplicates, missing managers, invalid dates or inconsistent balances, and
      loads nothing until the error count is zero.
- [ ] History back-fill creates journey events marked `migrated`.

## [ ] Slice 14 — Hardening and go-live readiness

**Done when**
- [ ] Every role is tested against the permissions table, including denied actions (regression suite green).
- [ ] 5 pilot users each complete check-in, leave application and week planning without help on first use.
- [ ] Non-functional targets met: pages < 2 s on 4G, check-in < 3 s, WCAG 2.1 AA on employee and manager screens.
- [ ] A backup restore to staging is completed and verified.
- [ ] An independent security review (penetration test) is done and its findings fixed.
