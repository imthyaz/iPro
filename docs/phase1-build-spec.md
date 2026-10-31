# iPro Phase 1 — Build specification

31 Oct 2026 · Dr Imthyaz Sheriff C

## Scope and assumptions

Phase 1 replaces Ideassion's spreadsheets for people records, attendance, leave and hybrid planning. It also ships the journey timelines, so every later module writes into a working event store from day one. Values marked [to confirm] are Ideassion policies to be supplied before build (see the last section).

**In Phase 1:**

| Module | Delivers |
| --- | --- |
| People and engagements | Person record, engagements (payroll and retainer), KYC vault, documents, effective-dated changes |
| Org structure | Entities, business units, departments, locations, cost centres, reporting lines, org tree as of any date, positions |
| Pre-boarding | Offer and LOI letters from templates, e-sign, acceptance tracking, joining-date changes, drop-outs |
| Onboarding | Checklists by template, KYC collection, asset and access tasks, policy acknowledgements, buddy assignment |
| Probation | Due dates, reminders, review form, confirm / extend / terminate with letters |
| In-life changes | Designation, grade, department, manager, location, bucket and retainer-to-payroll conversion, each with approval and letter |
| Attendance | Web and mobile check-in, biometric import, shifts, holiday calendars, regularisation |
| Leave | Leave types, accrual, carry-forward, encashment flag, comp-off, approvals, balances |
| Hybrid planner | Policies per population, weekly booking (WFH, office with seat, client site), team grid, compliance |
| Offboarding | Resignation, notice, clearances, exit interview, relieving and experience letters, rehire flag |
| Journey timelines | Individual (full and compact) and team views as designed |
| Self-service and approvals | Mobile-first employee and manager screens, approval inbox, notifications |

**Not in Phase 1:** payroll, projects and allocation, timesheets, appraisal, L&D and CoP, points, HRA. The data model reserves their entities and event types so they plug in without migration.

**Assumptions:**

- One legal entity at launch: Ideassion India. The model supports more; they are not configured or tested in Phase 1.
- About 150 people, plus retainers [to confirm count].
- English only. Rupees are the only currency used in Phase 1, though fields carry a currency code.
- Full and final settlement amounts are entered manually at exit until payroll ships in Phase 2.

## Experience for a lean team

iPro is run by a small team: one or two HR people and part of a finance person for about 150 employees, plus managers who approve between client work. Every screen is built so that data is easy to read and the next action is one tap away.

**Design rules every screen follows:**

1. **Work comes to you.** Each person's home is an Action inbox: everything waiting on them (approvals, reviews, tasks, overdue items), sorted by due date, acted on in place, with bulk approve.
2. **Decide with context on the card.** An approval card carries what the decision needs. Leave shows the balance after, who else in the team is off that day, and whether it fits policy. Probation shows the 30- and 90-day check-ins. No click-through to decide.
3. **Exceptions first.** Dashboards lead with what is wrong or due (overdue, below policy, missing punches, unusual absence), not totals. Every number opens the list of people behind it, with the action next to each.
4. **The system does the routine.** Dates come from policy, letters from templates, checklists start themselves, reminders and escalations are automatic. People only handle exceptions.
5. **Short paths.** Check-in is 1 tap; applying leave is 3 or fewer; approving is 1 tap or a swipe on mobile.
6. **Every number explains itself.** Balances, LOP days and compliance figures have a "why" that shows the calculation.
7. **Safe to act.** Reversible actions get an undo window; irreversible ones (exit, termination, letters sent) confirm first.
8. **One pattern everywhere.** Same list → detail side panel layout, same filters, same status colours and words across modules.
9. **Ask instead of navigate.** The AI assistant is on every screen (below).
10. **Ready on day one.** India defaults pre-loaded; set-up is a guided import plus a policy workshop, not consulting.

## AI assistant — Ask iPro

A chat panel on every screen and on mobile for quick answers and quick actions. In Phase 1 it covers people, org, attendance, leave, hybrid planning, the journey and Ideassion's policies; it grows with each later phase.

| Ask | Example | How it answers |
| --- | --- | --- |
| Self | "How many earned leaves do I have?" "Who is my buddy?" | Reads the user's own records |
| Team | "Who's on leave tomorrow?" "Who missed office days this week?" | Same queries as M2 and M4, scoped to the user's team |
| HR and leadership | "Probations due this month?" "Joiners and leavers in Q2 by department?" | Same queries as H7 and H12 |
| Policy | "How many days can I carry forward?" "What is the notice period for leads?" | Retrieves from policy documents and the configured rules, with a link to the source |
| People | "Show Divya's journey" | Opens the timeline in the side panel |
| Act | "Apply casual leave on Friday" "Approve all pending leave for tomorrow" "Draft a confirmation letter for Arjun" | Prepares the action as a confirmation card; nothing changes until the user taps Confirm |

Rules:

- **Runs as the user.** The assistant calls iPro's own API with the user's permissions, so it can never show or do what the user can't. Masked fields stay masked.
- **Numbers come from the system, not the model.** Every figure is the result of an iPro query, shown with a link to the screen or list behind it. If no query answers the question, it says so instead of guessing.
- **Drafts, never silent actions.** Any change appears as a card with the exact effect (dates, balance after, who is notified) and needs a tap. Exits, terminations and compensation changes can be drafted but must be completed on their own screens.
- **Logged.** Questions, answers and confirmed actions go to the audit log; full conversations are kept for 180 days. After that, each conversation is replaced by a summary (topics asked, records referenced, actions confirmed) that is archived and stays searchable, and the full text is deleted. Summaries follow the same permissions as the conversation, and confirmed actions stay in the audit log either way.
- **Daily brief (optional).** At 09:00 each manager and HR user gets a short summary: pending approvals, items due this week and anything unusual.

**Additional screens:** X2 Ask iPro (side panel, all roles, both devices) and X3 Action inbox (home for managers and HR; replaces M1 as the approvals entry point).

**Additional entities:** AssistantConversation (user, started_at, archived_at), AssistantSummary (conversation_id, summary, topics, linked records, created_at), AssistantMessage (role, text, tool calls, linked records, confirmed_action_id), PolicyDocument (title, version, effective_from, file, chunks for search).

## Data model

The model separates who a person is (Person), the contract they work under (Engagement) and the effective-dated facts about that contract (Assignment). Every change also writes a JournalEvent, which drives the timelines and the audit trail. All tables carry `id`, `tenant_id`, `created_at`, `created_by`, `updated_at`, `updated_by`.

**Organisation:**

| Entity | Key fields | Relationships |
| --- | --- | --- |
| Tenant | name, plan, settings | Parent of everything; Ideassion is tenant 1 |
| LegalEntity | name, country, PAN, TAN, GSTIN, registered address, default currency | Has many Locations, Engagements |
| BusinessUnit | name, code, head_person_id | Has many Departments |
| Department | name, code, parent_department_id, head_person_id | Tree; belongs to BusinessUnit |
| Location | name, type (office / client site / remote), address, state, timezone, holiday_calendar_id, seat_count | Belongs to LegalEntity |
| CostCentre | code, name, owner_person_id | Referenced by Assignment |
| Grade | code, name, band_min, band_max, level_order | Referenced by Position, Assignment |
| Designation | title, grade_id, designation_band (Associate / Senior-Lead / Manager+) | Referenced by Assignment |
| Position | code, designation_id, department_id, cost_centre_id, status (open / filled / frozen), budgeted_ctc | Optional link from Assignment |

**People:**

| Entity | Key fields | Relationships |
| --- | --- | --- |
| Person | legal_name, preferred_name, date_of_birth, gender, nationality, personal_email, phone, photo, prior_experience_months | Has many Engagements, Documents, KycRecords |
| KycRecord | type (PAN, Aadhaar, passport, bank, UAN, ESIC), value_encrypted, verified_by, verified_at | Belongs to Person; encrypted at field level |
| EmergencyContact | name, relation, phone | Belongs to Person |
| Engagement | employee_code, legal_entity_id, type (permanent / fixed-term / intern / trainee / retainer / consultant), status (offered / pre-joining / active / on notice / exited / withdrawn), offer_date, joining_date, probation_end_date, confirmation_date, notice_period_days, resignation_date, last_working_date, exit_reason, rehire_eligible | Belongs to Person; has many Assignments |
| Assignment | engagement_id, effective_from, effective_to, designation_id, grade_id, department_id, location_id, cost_centre_id, manager_engagement_id, dotted_manager_engagement_id, bucket, work_policy_id, position_id, change_reason | Effective-dated; exactly one open row per engagement at any date |
| Compensation | engagement_id, effective_from, annual_ctc or retainer_rate, rate_unit (year / month / day / hour), currency | Effective-dated; visible to HR and finance only |
| Document | owner (person or event), type, file, version, generated_from_template_id, signed_at | Letters, KYC scans, certificates |

**Lifecycle and time:**

| Entity | Key fields | Relationships |
| --- | --- | --- |
| ChecklistTemplate | name, stage (onboarding / exit / transfer), applies_to rule | Has many TemplateTasks (title, owner role, due offset days, requires document) |
| ChecklistRun | engagement_id, template_id, status, started_at, completed_at | Has many TaskInstances (assignee, due date, status, evidence) |
| LetterTemplate | type, version, body with merge fields, approver role | Generates Documents |
| Shift | name, start, end, break minutes, grace minutes, weekly offs | Assigned via WorkPolicy |
| HolidayCalendar | name, year | Has many Holidays (date, name, optional) |
| AttendanceDay | engagement_id, date, status (present / absent / half-day / leave / holiday / weekly-off / WFH / client-site), first_in, last_out, source, regularised | One row per person per day |
| Punch | engagement_id, timestamp, source (biometric / web / mobile), geo | Raw input to AttendanceDay |
| LeaveType | code, name, accrual rule, max balance, carry-forward cap, encashable, requires document after N days, applies_to rule | |
| LeaveBalance | engagement_id, leave_type_id, year, opening, accrued, taken, lapsed, encashed | |
| LeaveRequest | engagement_id, leave_type_id, from, to, half-day flags, days, reason, status | |
| WorkPolicy | name, office_days_per_week, anchor_days, allowed modes, exception approval rule | Assigned via Assignment |
| WorkBooking | engagement_id, date, mode (WFH / office / client site), location_id, seat_id, status | Planned; compared with AttendanceDay |
| Seat | location_id, label, zone | Bookable |

**Journey and audit:**

| Entity | Key fields | Relationships |
| --- | --- | --- |
| JournalEvent | engagement_id, event_type, category, occurred_on, is_planned, title, detail_json, sensitivity (public / manager / HR / restricted), source_table, source_id | Read model for all timelines; append-only |
| AuditLog | actor, action (view / create / update / delete / export), table, record_id, field changes, ip, at | Every compensation and KYC view is logged |
| Approval | subject_table, subject_id, step, approver, decision, comment, decided_at | Shared by every workflow |

Reserved for later phases (tables created, no screens): Project, Allocation, TimesheetEntry, PayrollRun, AppraisalCycle, LearningRecord, PointsLedger.

## Workflows

Every workflow uses the shared Approval table and writes a JournalEvent on its final transition. Rejections always return the item to its submitter with a mandatory comment. An approval not acted on within the escalation window [to confirm, default 3 working days] goes to the approver's manager.

**1. Offer to joining** — states: Draft → Pending approval → Offered → Accepted → Pre-joining → Joined; side exits Declined, Withdrawn, No-show.

| From | Action | By | To | Side effects |
| --- | --- | --- | --- | --- |
| Draft | Submit offer | HR | Pending approval | Offer letter generated from template |
| Pending approval | Approve | Hiring manager, then HR head if CTC above band | Offered | Letter sent for e-sign |
| Offered | Sign | Candidate | Accepted | Onboarding checklist created; pre-joining portal opened |
| Offered | Decline or expire after N days | Candidate / system | Declined | Drop-out reason recorded |
| Accepted | Joining date reached and Day-1 tasks done | HR | Joined | Engagement active; first Assignment opens; event Joined |
| Accepted | Did not join | HR | No-show | Engagement closed |

**2. Onboarding checklist** — each task is Open → Done or Waived (HR only, with reason). The run is Complete when all mandatory tasks are Done or Waived. KYC tasks need a document and HR verification.

**3. Probation** — states: On probation → Review due → Review submitted → Confirmed / Extended / Terminated.

| From | Action | By | To | Side effects |
| --- | --- | --- | --- | --- |
| On probation | 30 days before end date | System | Review due | Manager notified; reminders at 14 and 7 days |
| Review due | Submit review with recommendation | Manager | Review submitted | |
| Review submitted | Approve Confirm | HR | Confirmed | Confirmation letter; event Probation confirmed |
| Review submitted | Approve Extend with new date | HR | On probation | Extension letter; end date moved |
| Review submitted | Approve Terminate | HR head | Terminated | Starts exit workflow |
| Review due | End date passes, no review | System | Review due (overdue) | Escalation to manager's manager and HR; employee status unchanged |

**4. Leave** — states: Draft → Applied → Approved / Rejected → Cancelled (before start) or Revoked (after start, HR only).

- Balance is checked on apply; negative balance is allowed only for leave types configured to allow it.
- Approval goes to the reporting manager, with optional second step for leave over N days [to confirm].
- Approved leave writes AttendanceDay rows as Leave; cancellation restores the balance.
- Retro-applied leave counts as unplanned for absenteeism.

**5. Attendance regularisation** — a day marked Absent or with a missing punch can be regularised by the employee within N days [to confirm] with a reason code (forgot to punch, on duty, client site, system issue). The manager approves; the AttendanceDay is updated and marked regularised.

**6. Hybrid planning** — bookings within the person's WorkPolicy are confirmed instantly. A week below the policy's office days, or an office day on a full location, needs manager approval. A booking can be changed until a cut-off [to confirm, default 18:00 the day before]. A nightly job compares bookings with attendance and records planned vs actual.

**7. Exit** — states: Resignation submitted → Accepted → Serving notice → Clearance → Exited; side branch Withdrawn.

| From | Action | By | To | Side effects |
| --- | --- | --- | --- | --- |
| Active | Submit resignation with reason and proposed last day | Employee | Resignation submitted | Manager and HR notified; event Resignation submitted |
| Resignation submitted | Record retention discussion; accept with last working day (notice buyout or waiver if any) | Manager, then HR | Serving notice | Exit checklist created |
| Resignation submitted / Serving notice | Withdraw | Employee, approved by manager and HR | Active | Exit checklist cancelled |
| Serving notice | All clearance tasks done | Department owners | Clearance | Access revocation scheduled for last day |
| Clearance | Last working day reached and exit interview recorded | HR | Exited | Relieving and experience letters; rehire flag; event Exit |
| Active | Initiate termination | HR head | Serving notice | Termination letter; same checklist |

**8. In-life change** (designation, grade, department, manager, location, bucket, conversion) — Draft → Pending approval → Approved, effective on a chosen date. On the effective date the current Assignment closes and a new one opens; a letter is generated where the template requires it; an event is written.

## Business rules and configuration

Every rule below is an admin setting, not code. The proposed default is what ships if Ideassion supplies nothing; the last column is filled in during the policy workshop.

| Area | Setting | Proposed default | Ideassion value |
| --- | --- | --- | --- |
| Employee code | Format and sequence | IDS-0001, never reused | [to confirm] |
| Probation | Length by engagement type | 6 months permanent; none for retainers | [to confirm] |
| Probation | Maximum extensions | 1 extension of up to 3 months | [to confirm] |
| Notice | Notice period by grade and status | 30 days on probation; 60 days confirmed; 90 days Manager and above | [to confirm] |
| Notice | Buyout and waiver | Allowed with HR head approval | [to confirm] |
| Week | Working days and weekly offs | Monday–Friday; Saturday and Sunday off | [to confirm] |
| Shift | Hours, grace, half-day threshold | 09:30–18:30, 15 min grace, under 4 h = half-day | [to confirm] |
| Holidays | Calendar per location | Chennai calendar, 10 fixed + 2 optional | [to confirm list] |
| Leave | Casual leave | 12 a year, credited monthly, no carry-forward | [to confirm] |
| Leave | Sick leave | 12 a year, medical certificate after 2 consecutive days | [to confirm] |
| Leave | Earned / privilege leave | 15 a year, accrues monthly after confirmation, carry-forward cap 30, encashable at exit | [to confirm] |
| Leave | Statutory and special | Maternity 26 weeks, paternity, bereavement, comp-off (expires in 60 days) | [to confirm] |
| Leave | Probation rules | Earned leave not available on probation | [to confirm] |
| Leave | Sandwich rule | Off: weekends between leave days are not counted | [to confirm] |
| Leave | Leave year | January–December | [to confirm] |
| Attendance | Regularisation window | 5 days after the date, maximum 3 a month | [to confirm] |
| Attendance | Check-in methods by population | Biometric at office; mobile with geofence for client site; web for WFH | [to confirm] |
| Hybrid | Policies | Engineering 3 office days; client-deployed full on-site; retainers remote-first; one anchor day per team | [to confirm] |
| Hybrid | Booking cut-off | 18:00 the day before | [to confirm] |
| Approvals | Escalation window | 3 working days | [to confirm] |
| Approvals | Second-level leave approval | Leave over 5 consecutive days | [to confirm] |
| Buckets | List | Billable, bench, management, administration, pre-sales, trainee | [to confirm] |
| Designation bands | Mapping of designations to bands | Associate / Senior-Lead / Manager+ | [to confirm list] |
| Retention | Data after exit | Keep 8 years, then anonymise; KYC images deleted after 3 years | [to confirm with legal] |

The statutory leave values (maternity and similar) follow law, not policy, and are validated by Ideassion's HR and legal advisors before go-live. For Tamil Nadu, the state Shops and Establishments rules set minimum leave entitlements.

## Screens

38 screens across six roles, plus X2 and X3 from the AI assistant section. Employee and manager screens are mobile-first; HR and admin screens are desktop-first but usable on a tablet. A person with several roles sees one combined navigation.

| # | Screen | Role | Key content and actions | Device |
| --- | --- | --- | --- | --- |
| E1 | Home | Employee | Today's mode and check-in, pending tasks, upcoming journey events, leave balance | Mobile |
| E2 | Check-in / check-out | Employee | One tap; geofence result; WFH or client-site choice | Mobile |
| E3 | My attendance | Employee | Month calendar by status; regularise a day | Mobile |
| E4 | Apply leave | Employee | Type, dates, half-day, balance after, reason, attachment | Mobile |
| E5 | My leave | Employee | Balances, requests and status, cancel | Mobile |
| E6 | Plan my week | Employee | Weekly grid: WFH / office (seat picker) / client site; policy meter | Mobile |
| E7 | My profile | Employee | Personal details, contacts, KYC status, documents; request a change | Both |
| E8 | My journey | Employee | Full timeline, current-employee version | Both |
| E9 | My documents | Employee | Letters and uploads; download | Both |
| E10 | Resign | Employee | Reason, proposed last day, notice shown; withdraw | Both |
| E11 | Onboarding portal | New joiner | Pre-joining tasks, KYC uploads, policy sign-offs, Day-1 info | Both |
| M1 | Approvals inbox | Manager | Leave, regularisation, hybrid exceptions, probation, resignations; bulk approve | Mobile |
| M2 | Team today | Manager | Who is in office, WFH, on leave, client site, absent | Mobile |
| M3 | Team calendar | Manager | Month view of leave and bookings | Both |
| M4 | Team hybrid compliance | Manager | Planned vs actual office days per person per week | Desktop |
| M5 | Probation review | Manager | Form, recommendation, due date | Both |
| M6 | Team journeys | Manager | Parallel timeline view, scoped to reportees | Desktop |
| M7 | Team member profile | Manager | Profile summary, journey, attendance; no KYC | Both |
| H1 | People directory | HR | Search, filters, export | Desktop |
| H2 | Person record | HR | Tabs: profile, engagement, assignment history, compensation, KYC, documents, journey, audit | Desktop |
| H3 | Create offer | HR | Candidate, role, CTC, joining date; generate and send letter | Desktop |
| H4 | Offers pipeline | HR | Offered, accepted, joining this month, drop-outs | Desktop |
| H5 | Onboarding tracker | HR | Checklist runs with task progress and overdue items | Desktop |
| H6 | Change wizard | HR | Designation, department, manager, location, bucket, conversion; effective date; letter | Desktop |
| H7 | Probation dashboard | HR | Due in 30 days, overdue, extended | Desktop |
| H8 | Exit tracker | HR | Serving notice, clearance status, exit interviews, letters | Desktop |
| H9 | Attendance and leave admin | HR | Exceptions, bulk regularise, balance adjustments with reason | Desktop |
| H10 | Org tree | HR, leadership | Tree as of a date; filter by department and location | Desktop |
| H11 | Team journeys (org-wide) | HR, CXO | Parallel timelines; group by reportees, department, band, experience | Desktop |
| H12 | Phase 1 reports | HR, CXO | Headcount, joiners and leavers, attrition, absenteeism, leave liability, hybrid compliance, seat occupancy | Desktop |
| A1 | Organisation setup | Admin | Entities, business units, departments, locations, cost centres, grades, designations, positions | Desktop |
| A2 | Policies | Admin | Shifts, holiday calendars, leave types, work policies, notice rules | Desktop |
| A3 | Templates | Admin | Checklists and letters with merge fields and versions | Desktop |
| A4 | Users and roles | Admin | Role assignment, scopes | Desktop |
| A5 | Integrations | Admin | Biometric devices, SSO, email, e-sign | Desktop |
| A6 | Import | Admin | CSV import with validation report | Desktop |
| A7 | Audit log | Admin, HR head | Filter by person, actor, table, action | Desktop |
| X1 | Notifications | All | In-app list; preferences | Both |

## Permissions

Access is checked on the server for every request, by role and scope. "Own" means the person's own record; "Team" means direct and indirect reportees. Codes: R read, C create, U update, A approve, D delete, — no access.

| Data | Employee (own) | Manager (team) | HR | HR head | CXO | Admin |
| --- | --- | --- | --- | --- | --- | --- |
| Profile and contacts | R, U via request | R | R, U | R, U | R | — |
| KYC values | R masked; C uploads | — | R, U, verify | R, U | — | — |
| Compensation | R own CTC | — | R, C, U | R, C, U, A above band | R | — |
| Assignment history | R | R | R, C, U | R, C, U, A | R | — |
| Attendance | R; C punches; regularise | R; A regularisation | R, U with reason | R, U | R aggregates | — |
| Leave | C, R, cancel | R; A | R, U balances with reason | R, U | R aggregates | — |
| Hybrid bookings | C, R, U before cut-off | R; A exceptions | R | R | R aggregates | — |
| Documents and letters | R own | R non-confidential | C, R, U | C, R, U | — | — |
| Journey: public events | R | R | R | R | R | — |
| Journey: compensation and exit-reason events | R own | — | R | R | R | — |
| Probation review | R after decision | C, R | R, A | R, A terminate | — | — |
| Resignation and exit | C own, withdraw | R; A | R, U, A | R, A, terminate | R | — |
| Org setup, policies, templates | — | — | R | R, U | — | C, R, U, D |
| Users and roles | — | — | R | R | — | C, R, U, D |
| Audit log | — | — | R own actions | R | — | R |

Rules that apply across the table:

- **Nothing is hard-deleted** except by retention jobs; deletes are soft and audited.
- **Admin sees configuration, not people data,** unless also granted an HR role.
- **Masked KYC** shows the last 4 characters only; unmasking writes an audit row.
- **Delegation:** a manager on leave can delegate approvals to another manager for a date range.

## Notifications and scheduled jobs

Notifications go in-app, to Microsoft Teams and by email. Teams is the default channel: approval requests arrive as Teams cards that can be approved or rejected in place, and email is the fallback for people not on Teams and for letters. Each notification type can be switched off by the recipient, except approvals and compliance items.

| Trigger | Recipients | Timing |
| --- | --- | --- |
| Approval requested | Approver | Immediately; reminder after 2 working days; escalation at the escalation window |
| Approval decided | Requester | Immediately |
| Offer sent / accepted / declined | HR, hiring manager | Immediately |
| Joining in 7 days and tomorrow | HR, manager, buddy, IT | 7 days and 1 day before |
| Onboarding task due or overdue | Task owner | On due date; daily while overdue |
| Probation review due | Manager, HR | 30, 14 and 7 days before; daily when overdue |
| Missing check-in | Employee | At shift start + grace, on working days with no leave or booking |
| Hybrid week below policy | Employee | Friday 12:00 for the next week |
| Resignation submitted | Manager, HR | Immediately |
| Last working day in 7 days | Employee, manager, HR, IT | 7 days before |
| Work anniversary | Employee, manager | On the day |

**Scheduled jobs:**

| Job | Runs | Does |
| --- | --- | --- |
| Attendance build | Every 15 minutes during working hours; full rebuild at 02:00 | Turns punches, leave, holidays and bookings into AttendanceDay rows |
| Biometric import | Every 15 minutes | Pulls punches from devices or the vendor API |
| Leave accrual | 1st of each month, 01:00 | Credits accruals; applies carry-forward and lapse at year end |
| Effective-dated changes | Daily, 00:05 | Opens and closes Assignments due today; writes events |
| Hybrid compliance | Daily, 03:00 | Compares bookings with attendance; weekly roll-up on Monday |
| Probation and exit due dates | Daily, 06:00 | Moves states and raises reminders |
| Access revocation | At last working day, 23:59 | Disables SSO account and app access |
| Retention | Weekly | Anonymises and deletes per retention rules; summarises and archives assistant conversations older than 180 days |
| Backup | Nightly, plus point-in-time recovery | See technical decisions |

## Integrations and data migration

**Integrations in Phase 1:**

| System | Direction | Purpose | Notes |
| --- | --- | --- | --- |
| SSO (Microsoft Entra ID) | Both | Login; create account on joining, disable on exit | SCIM provisioning if available |
| Biometric devices [to confirm make and model] | In | Punches | Vendor cloud API preferred; otherwise a small on-site agent pushing over HTTPS |
| Email (Microsoft Graph, Exchange Online) | Out | Notifications, letters | Sender domain with SPF and DKIM |
| E-signature (Zoho Sign) | Both | Offer, confirmation and relieving letters | OTP or Aadhaar eSign; signed PDF stored as a Document; called through iPro's own e-sign layer so the provider can be switched by configuration |
| Calendar | Out | Holidays and approved leave as calendar entries | Optional in Phase 1 |
| Existing payroll (current vendor or spreadsheets) | Out | Monthly CSV of attendance, LOP days and joiners / leavers | Bridge until iPro payroll ships in Phase 2 |

**Microsoft Teams (default notification channel):** an iPro app in Teams, registered in Ideassion's Entra tenant. It sends notifications and actionable approval cards (approve, reject with comment) for leave, regularisation, hybrid exceptions and probation reviews; a decision made in Teams is recorded exactly as one made in iPro, with the same permission check and audit row. The Ask iPro assistant will also run as a chat inside Teams after Phase 1, once the in-app assistant has passed its acceptance tests; it is not part of Phase 1.

**Policy acknowledgements (in-app, no provider):** policies, the handbook and similar sign-offs are accepted inside iPro. The employee is signed in through Entra ID SSO, reads the document, and taps Accept. iPro records a PolicyAcknowledgement (person, document id and version, content hash, accepted_at, session and device details) and writes an audit row. A new version of a policy re-opens acknowledgement for everyone it applies to, and HR sees who is still pending. Offer letters and HR-signed letters (confirmation, extension, transfer, relieving, experience) go through Zoho Sign.

**Data migration:**

1. **Extract** from current sources [to confirm: spreadsheets, existing HR tool, payroll vendor]: active and exited people for the last 3 years, current assignments, managers, CTC, KYC, leave balances, holiday calendar.
2. **Map** to iPro templates (one CSV per entity), cleaning names, codes and manager links.
3. **Validate** with the import tool (A6): duplicates, missing managers, invalid dates, balances that don't add up. Nothing loads until the error count is zero.
4. **Load into staging,** then HR spot-checks 20 records and every manager checks their own team list.
5. **Back-fill the journey:** joining, confirmation, designation changes and exits from history become JournalEvents marked migrated, so timelines aren't empty on day one.
6. **Cut over** on a month boundary: leave balances frozen at the old system's month-end, iPro live on the 1st, old system read-only for 3 months.

History that can't be sourced reliably is left out rather than guessed; the journey shows a "history before [date] not recorded" marker.

## Technical decisions

Decided: iPro is built from scratch, not on an HR platform. The stack below is the proposed starting point; items marked "Choose" are settled by the engineering lead before sprint 1.

| Decision | Proposed | Why | Status |
| --- | --- | --- | --- |
| Database | PostgreSQL | Relational data, effective dating, row-level security for tenants | Proposed |
| Backend | TypeScript (NestJS) or Python (Django), modular monolith | One deployable with clear module boundaries; split later only if needed | Choose by team skill |
| Web front end | React | Reuses the timeline designs already built | Proposed |
| Mobile | Progressive web app in Phase 1; native app later if needed | Check-in, leave and approvals work in a PWA, including geolocation | Proposed |
| Hosting | AWS Mumbai (ap-south-1), with Hyderabad (ap-south-2) for disaster recovery | Keeps personal data in India for DPDP compliance; same account as the AI provider (Bedrock) | Proposed |
| Files | Encrypted object storage; signed, short-lived download links | Letters and KYC scans | Proposed |
| Secrets and keys | Cloud key management; field-level encryption for KYC and compensation | | Proposed |
| Identity | OIDC SSO with Microsoft Entra ID, SCIM provisioning and Entra groups mapped to iPro roles; app-level scopes | | Proposed |
| Background jobs | Queue with scheduled workers | Attendance build, accrual, reminders | Proposed |
| Audit | Append-only AuditLog table; compensation and KYC views logged | | Proposed |
| Environments | Dev, staging (with anonymised data), production | | Proposed |
| Backup | Nightly full backup plus point-in-time recovery; restore tested quarterly | Target: lose no more than 15 minutes of data, back up within 4 hours | Proposed |
| Observability | Error tracking, uptime checks, structured logs without personal data | | Proposed |

(Starter-pack note: `docs/decisions.md` #4 sets TypeScript end to end as the default for the Backend row.)

**AI assistant stack:** Amazon Bedrock in AWS Mumbai, using the India geographic inference profile, with Claude as the default model family. Requests are processed only in Mumbai and Hyderabad, and Bedrock retains no prompt or output data. The model is called from the backend only, with tool definitions mapped to iPro API endpoints and a search index over policy documents. Personal identifiers are resolved on the server, so prompts carry only what the answer needs, and each tool call is checked against the user's permissions before it runs.

| Use | Model | Why |
| --- | --- | --- |
| Lookups: balances, who is off, due items, journey and org questions | Claude Haiku | Fastest and cheapest; most assistant traffic |
| Policy answers, drafting actions and letters, the 180-day conversation summaries | Claude Sonnet | Better reasoning and writing |
| HRA what-if analysis (Phase 4) | Claude Opus, if needed | Deferred; not used in Phase 1 |

Guardrails for the AI set-up:

- **India-only routing is enforced in code.** Only model IDs with the India profile prefix (`in.`) are allowed; a startup check and a CI test reject any global profile ID, which would route data outside India.
- **The model is swappable.** Models are set in configuration, so another model on Bedrock (OpenAI models are also offered there with India-only routing) can replace or be compared with Claude without code changes.
- **Selection test before go-live:** two weeks running the 50-question acceptance set against Haiku and Sonnet, and optionally one alternative model, measuring accuracy, response time and cost per 1,000 questions. Alternatives to compare if the cloud choice changes: Azure OpenAI (India region) or Google Vertex AI (Mumbai), after confirming in-India processing for the chosen model.

**Non-functional targets for Phase 1:** pages load in under 2 seconds on 4G; check-in completes in under 3 seconds; 99.5% monthly availability during working hours; supports 2,000 people without redesign; WCAG 2.1 AA for employee and manager screens.

## Acceptance criteria

Each feature is done when every line under it passes in staging with migrated Ideassion data.

**People and org**

- [ ] Creating a person with an engagement and assignment takes under 3 minutes and produces a Joined event.
- [ ] The org tree for any past date matches the assignments effective on that date.
- [ ] A designation change effective next month shows as upcoming on the journey, and applies automatically on that date.
- [ ] A retainer converted to payroll keeps one person record and one continuous journey.
- [ ] KYC values are masked for everyone except HR; each unmask writes an audit row.

**Pre-boarding and onboarding**

- [ ] An offer above the grade band cannot be sent without HR head approval.
- [ ] A signed offer creates the onboarding checklist with due dates computed from the joining date.
- [ ] A new joiner can complete KYC uploads and policy sign-offs on a phone before Day 1.

**Probation**

- [ ] Reminders arrive at 30, 14 and 7 days; an overdue review escalates.
- [ ] Confirm, extend and terminate each produce the right letter and journey event.

**Attendance and leave**

- [ ] Biometric punches appear within 15 minutes.
- [ ] Check-in from a phone records location and mode; outside the geofence it is flagged.
- [ ] Leave balances after migration match the old system for every person.
- [ ] A full month of accruals for all leave types matches a hand-calculated sample of 10 people.
- [ ] Approved leave, holidays and weekly offs show correctly on the attendance calendar.
- [ ] The monthly attendance and LOP export matches HR's manual count for the same month.

**Hybrid planner**

- [ ] Booking within policy confirms instantly; below policy asks for approval.
- [ ] Seat booking blocks double-booking of a seat.
- [ ] The compliance report shows planned vs actual office days per person per week.

**Offboarding**

- [ ] Accepting a resignation creates the exit checklist and sets the last working day from the notice rules.
- [ ] Access is disabled at the end of the last working day.
- [ ] Relieving and experience letters generate only after all clearance tasks are done.

**Journey timelines**

- [ ] Every workflow's final step writes the correct event; no event is written twice.
- [ ] A manager cannot see compensation or exit-reason events for their team.
- [ ] The team view loads 150 people over 3 years in under 3 seconds.

**Security and audit**

- [ ] Every role is tested against the permissions table, including denied actions.
- [ ] Compensation and KYC views appear in the audit log with actor and time.
- [ ] A backup restore to staging is completed and verified before go-live.

**Experience and AI assistant**

- [ ] A manager can clear 10 pending leave requests from the Action inbox in under 1 minute on a phone.
- [ ] Each approval card shows the context listed in the design rules without opening another screen.
- [ ] 5 pilot users each complete check-in, leave application and week planning without help on first use.
- [ ] The assistant answers a test set of 50 Phase 1 questions; every figure matches the matching report.
- [ ] Asked about someone outside their scope, a manager gets a refusal, not data.
- [ ] No assistant action changes data without a confirmation tap; every confirmed action is in the audit log.
- [ ] Policy answers link to the clause they came from; questions with no source get "I don't know" and a link to HR.

## Inputs needed from Ideassion

Build can start now on the data model, permissions, audit and screens; these inputs are needed before the matching features can be finished and tested. A half-day policy workshop with HR covers most of them.

**Decisions:**

- [ ] Decided: build from scratch. Remaining: backend language (TypeScript or Python), chosen by the engineering lead.
- [ ] Decided: AWS Mumbai for hosting and AI (Bedrock); Microsoft Entra ID for SSO.
- [ ] Decided: Zoho Sign for offer letters and HR-signed letters; in-app acceptance for policy acknowledgements. Still to confirm with legal: whether sponsored-certification service bonds need e-stamping (if so, revisit Leegality for those).

**Policies (fill the business rules table):**

- [ ] Employee code format, probation length and extensions, notice periods by grade.
- [ ] Working days, shifts, grace, half-day rule, holiday calendar per location.
- [ ] Leave types with entitlement, accrual, carry-forward, encashment and sandwich rule.
- [ ] Hybrid policies per team, anchor days, booking cut-off, seat counts per office.
- [ ] Approval chains and escalation window.
- [ ] Buckets and the designation-to-band mapping.
- [ ] Data retention periods, confirmed with legal.

**Templates:**

- [ ] Current offer, LOI, confirmation, extension, transfer, relieving and experience letters.
- [ ] Current onboarding and exit checklists, with an owner per task.
- [ ] Exit interview questions.

**Data:**

- [ ] Employee master (active and exited, last 3 years) with managers, designations, departments and joining dates.
- [ ] Current leave balances at a chosen cut-off date.
- [ ] Designation, promotion and exit history, for back-filling journeys.
- [ ] Biometric device make, model and access method.
- [ ] A sample month of attendance and LOP as calculated today, to test against.

**People:**

- [ ] A product owner from HR who can decide policy questions within 2 days.
- [ ] 5–10 pilot users (employees and managers) for user testing before go-live.
