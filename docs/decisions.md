# Decisions

Decisions already made. Add new ones at the bottom with a date; do not edit past ones (supersede them instead).

| # | Date | Decision |
| --- | --- | --- |
| 1 | 2026-10 | Product name: iPro. First customer: Ideassion. |
| 2 | 2026-10 | Built from scratch (not on Odoo/Frappe). Built with Claude Code; a person reviews and merges every PR. |
| 3 | 2026-10 | Phase 1 = Foundation: people, org, onboarding, probation, attendance, leave, hybrid planner, exit, journey timelines, Action inbox, Ask iPro. |
| 4 | 2026-10 | TypeScript end to end (NestJS API, React web, shared zod schemas). Default chosen so one language covers the whole codebase; the engineering reviewer may change this before slice 0. |
| 5 | 2026-10 | Hosting: AWS Mumbai (ap-south-1), DR Hyderabad (ap-south-2). Data stays in India (DPDP). |
| 6 | 2026-10 | Sign-in: Microsoft Entra ID (OIDC + SCIM). |
| 7 | 2026-10 | Notifications: Microsoft Teams by default (actionable approval cards) + email via Microsoft Graph. Ask iPro in Teams comes after Phase 1. |
| 8 | 2026-10 | AI: Amazon Bedrock, Claude models, India geographic inference profile only (`in.` model IDs). Haiku for lookups, Sonnet for drafting/policy/summaries. |
| 9 | 2026-10 | Assistant conversations kept 180 days, then replaced by an archived summary. |
| 10 | 2026-10 | E-signature: Zoho Sign for offer letters and HR-signed letters; in-app acceptance for policy acknowledgements. |
| 11 | 2026-10 | Payroll (Phase 2): in-house, India only for now. HRA built in (Phase 4). |
| 12 | 2026-10 | Points may carry money (catalogue vouchers, capped at ₹15,000/year less other gifts) and/or appraisal weight. Bell curve allowed per appraisal model. Project-exit feedback visible after project-owner approval; peer input anonymous. (Later phases.) |
| 13 | 2026-10-31 | Backend language confirmed: TypeScript (NestJS). Settles decision #4 and the spec's "TypeScript or Python" row. |
| 14 | 2026-10-31 | Compensation is readable by HR, HR head and CXO (per the permissions table), plus each employee for their own CTC. No Finance role in Phase 1; the data model's "HR and finance only" is superseded. |
| 15 | 2026-10-31 | Leadership, hiring manager, buddy, IT and department owners are task assignees / notification recipients, not roles. "Leadership" access to the org tree (H10) means the CXO role. |
| 16 | 2026-10-31 | Audit log records every KYC view, every KYC unmask and every compensation read, including an employee viewing their own CTC. |
| 17 | 2026-10-31 | HR and HR head may unmask KYC; everyone else, including the employee, sees the last 4 characters only. |
| 18 | 2026-10-31 | "Team" scope is direct and indirect solid-line reportees only. Dotted-line manager is informational and grants no access. |
| 19 | 2026-10-31 | Timelines are per person, across all of that person's engagements. Retainer-to-payroll conversion opens a new engagement that keeps the employee code; a rehire after exit gets a new code (codes are never reused). |
| 20 | 2026-10-31 | HR may create an active person directly, without the offer flow (for migration and back-dated joiners). The Joined event records that the offer flow was skipped. |
| 21 | 2026-10-31 | Org units (BusinessUnit, Department, Location) are effective-dated, so the org tree as of a past date shows the structure and names in force then. |
| 22 | 2026-10-31 | All money fields, including Grade band_min/band_max and Position budgeted_ctc, are integer paise (`bigint`) plus a currency code. |
| 23 | 2026-10-31 | Approval delegations (delegator, delegate, date range) are stored from slice 1 and applied by the workflow engine when approvals arrive in slice 3. |
