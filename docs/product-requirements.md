# iPro — Workforce Intelligence Product Requirements

Oct 31, 2026 · @Imthyaz Sheriff

## Purpose and scope

iPro is one system of record for a person's working life, from offer letter to exit, that also produces the cost data finance needs. Every attendance mark, timesheet hour, project allocation, appraisal, certification and exit becomes a dated event on that person's journey and a cost line in Human Resource Accounting (HRA).

Product name: iPro. First customer: Ideassion, for its own people across India, the GCC and the USA.

**In scope:** pre-boarding, onboarding, attendance and leave, WFH / hybrid scheduling, project allocation and project accounting, timesheets, performance management with multiple appraisal models, L&D, mentors and buddies, Communities of Practice (CoP), offboarding, org structure, journey timelines, payroll and HRA, all built into one application.

**Out of scope for v1:** recruitment / ATS before the offer stage, and benefits administration.

Product principles:

- **One person record, many engagement types.** Payroll employees, retainers, consultants and interns share one structure; only the contract and cost fields differ.
- **Configure, don't hard-code.** Appraisal models, cycles, timesheet templates, WFH policies and checklists are configured per population, not set once for the whole org.
- **Everything is an event.** Each module writes dated events to the journey, so the timeline views and audit trail come for free.
- **Every event has a cost.** Where an event carries money (hire, training, overtime, bench time, exit), the cost is captured at source, not reconstructed later.
- **Role-scoped visibility.** Compensation and feedback are visible only to the roles that need them.

* **Built for a lean team.** iPro assumes one or two HR people and busy managers. Work comes to each person in an Action inbox, approval cards carry the context needed to decide, dashboards lead with exceptions, routine steps are automated, and an AI assistant answers questions and drafts actions from any screen. The design rules are in the Phase 1 build spec.

## Users, roles and access

Access is role-based and scoped by reporting line, project and entity. One person can hold several roles; for example, a delivery manager is also an employee and a mentor.

| Role | Sees | Does |
| --- | --- | --- |
| Employee / retainer | Own journey, attendance, timesheets, goals, feedback released to them, own documents | Marks attendance, books WFH / office days, fills timesheets, self-appraisal, nominates for sessions, uploads certificates |
| Reporting manager | Direct and indirect reportees, team calendar, team timeline | Approves leave, WFH and timesheets; manager appraisal; probation confirmation; nominations |
| Project / account lead | People allocated to their projects, project timesheets | Requests and releases allocations, approves project timesheets, gives project-exit feedback |
| Mentor / buddy | Mentee profile summary and goals only | Logs check-ins, recommends learning |
| CoP lead | CoP members, contributions and points | Runs sessions, records attendance and contributions |
| HR (HRBP, HR ops) | All people in their entity or business unit, including compensation | Letters, onboarding and exit checklists, cycle setup, appraisal calibration, policy configuration |
| L&D admin | Learning catalogue, nominations, spend | Sessions, certifications, budgets, points rules |
| Finance / HR accounting | Cost data, CTC, project cost rates, budgets; no feedback text | Cost rates, budgets, HRA reports, period close |
| CXO / leadership | Org-wide dashboards and team views; drill-down per policy | Approvals above thresholds, workforce budget sign-off |
| System admin | Configuration only, no personal data by default | Roles, templates, integrations, audit logs |

Access rules:

- **Compensation fields** (CTC, increments, cost rate) are hidden from mentors, CoP leads and project leads unless explicitly granted.
- **Feedback text** is visible to the subject only after release. 360 / 720 rater identities are anonymous below a minimum rater count (default 3).
- **Retainers** see the same self-service screens, minus payroll-only items like payslips and statutory deductions.
- **Every view of compensation or feedback is written to the audit log.**

## Core people record

Every person has one Person record and one or more Engagements. The engagement holds the contract type and cost basis, so payroll employees and retainers sit on the same structure, and a retainer converting to payroll keeps one continuous journey.

**Person** (stable identity): legal name, preferred name, photo, date of birth, nationality, contact, emergency contacts, KYC documents, skills, certifications, languages, total prior experience.

**Engagement** (one per contract; history kept):

| Field | Payroll employee | Retainer / consultant |
| --- | --- | --- |
| Engagement type | Permanent, fixed-term, intern, trainee | Retainer (monthly fee), hourly / daily consultant, vendor-supplied contractor |
| Legal entity / country | Employing entity, for example India Pvt Ltd, Oman LLC, US Inc | Contracting entity |
| Start / end dates | Date of joining; probation end; last working day | Contract start, end, renewal date, notice clause |
| Pay basis | Annual CTC with component breakup | Monthly retainer, day rate or hourly rate; currency |
| Cost to company | CTC + employer statutory costs + benefits + allocated overheads | Fee + GST / VAT treatment + agency margin if any |
| Statutory | PF, ESI, gratuity, PT, TDS (India); GOSI / social insurance, WPS (GCC) | TDS on professional fees (India); none or invoice-based elsewhere |
| Leave | Leave policy | Billable-days policy; leave unpaid by default (configurable) |
| Timesheet | Template per bucket | Mandatory; drives invoice amount |
| Appraisal | Model per population | Optional lightweight review or contract-renewal review |

**Employee bucket** (how a person's time and cost are classified; one primary bucket per period, changes logged as events):

- **Billable** — client-chargeable delivery roles.
- **Investment / bench (talent pool)** — billable-capable but unallocated.
- **Management / leadership** — delivery, practice and business leadership.
- **Administration / support** — HR, finance, IT, facilities.
- **Pre-sales / practice building** — solutioning, CoE, internal products.
- **Learning / trainee** — freshers in training before deployment.

**Org structure:** each engagement links to a legal entity, business unit, department, location, cost centre, reporting manager and, optionally, a dotted-line manager. The org tree is drawn from these links and can be viewed as of any past date.

**Positions (optional):** budgeted positions with a grade and cost band, which people fill. They feed workforce budgeting and the open-position view.

## Lifecycle: pre-boarding to exit

Each stage runs on a configurable checklist with owners, due dates and documents. Each completed step writes an event to the journey.

1. **Pre-boarding.** Issue Letter of Intent and offer letter from templates with merge fields. Track acceptance, e-signature, joining date and drop-outs. Capture cost per hire at this stage (agency fee, referral bonus, job-board and assessment costs, interviewer hours).
2. **Onboarding.** KYC (ID, address, bank, tax and statutory numbers held in an encrypted vault), document collection, background verification, asset and access provisioning, policy acknowledgements, orientation checklist, buddy assignment and induction plan.
3. **Probation.** Length set per policy, for example 3 or 6 months. Reminders go to the manager 30, 14 and 7 days before the due date. Outcomes are Confirm, Extend (with a new date) or Terminate, each producing a letter.
4. **In-life changes.** Designation, grade, CTC, bucket, department, manager, location, entity transfer, retainer-to-payroll conversion, and long leave or sabbatical. Each is an effective-dated change with approval and a generated letter.
5. **Offboarding.** Resignation or termination, notice period with buyout or waiver, retention discussion, knowledge transfer, release from projects (which triggers project-exit feedback), asset return, access revocation, department clearances, exit interview, full and final settlement, and relieving and experience letters. Rehire eligibility and exit reason are recorded for turnover analysis.

Every letter is generated from a versioned template and stored against the event that produced it.

## Attendance, leave and hybrid scheduling

Attendance records where and whether someone worked each day. Hybrid scheduling plans where they will work. Comparing the two gives compliance and cost.

**Attendance capture:** biometric or access-card import, web or mobile check-in with optional geofence, client-site check-in, and manager regularisation with reason codes. Shifts and holiday calendars are set per location and per client account. GCC clients, for example, have different weekends.

**Leave:** leave types, accrual, carry-forward and encashment rules per policy and entity. Comp-off is linked to approved overtime. Absenteeism tracking separates unplanned absence (same-day or retro-applied leave, absent without leave) from planned leave.

**Overtime:** derived from attendance or timesheets beyond the shift norm, with approval. It is either paid (sent to payroll) or banked as comp-off, and costed in HRA.

**WFH / hybrid planning:**

- **Policies per population**, for example 3 office days a week for Engineering, fully on-site for client-deployed staff, remote-first for retainers. Includes anchor days when a whole team comes in.
- **Weekly planner:** employees book WFH, office (with desk or seat booking per location) or client site. Managers see a team grid and seat occupancy.
- **Approvals** apply only to exceptions beyond policy.
- **Compliance:** planned vs actual office days per person and team.
- **Cost inputs** for HRA: seat cost per location per month, WFH allowance, internet reimbursement, transport and meal costs per office day.

## Projects and allocation

A project allocation is a dated record of who worked on what, in which role, at what percentage and at what rate. It is the bridge between people data and project accounting.

**Project master:** client, account, project code, finance cost code or WBS, billing model (T&M, fixed price, retainer, internal), currency, start and end dates, project lead, timesheet template, and planned rate card by role.

**Allocation record:** person, project, role on the project, allocation % (allows split allocation), start date, planned end date, actual release date, billable or non-billable flag, bill rate and cost rate effective-dated, location (offshore, onsite, client site), and requesting and approving lead.

**Flows:**

1. A resource request comes from the project lead with skill, grade, start date and duration.
2. A match is suggested from bench and roll-offs within 30 days, using the skills matrix.
3. On allocation, the journey gets a Project entry event and the person's bucket moves to Billable if applicable.
4. On release, the journey gets a Project exit event. Project-exit feedback opens automatically for the project lead, plus optional peer and self input.
5. Unallocated time is classified as bench (talent pool) and costed.

**Project-exit feedback:** a short configurable form (default 5 to 8 questions). It covers delivery quality, ownership, collaboration, client feedback, skills demonstrated (tagged to the skills matrix), and a would-staff-again rating. It is due within 14 days of release and escalates to the lead's manager if missed. Responses roll into the next appraisal as evidence. Each appraisal model decides how much they count. The employee sees the feedback only after the project owner approves it; before that it is visible to the author, the project owner, HR and the reporting manager. Peer input is anonymous to the employee: peer names are hidden, and peer comments are shown only when at least 3 peers have responded (otherwise they are merged into the project owner's summary).

**Project accounting outputs:** cost per project per period (hours × cost rate, plus allocated overheads), billable utilisation per person and team, revenue leakage (billable hours not invoiced), and bench cost.

## Timesheets

Timesheets are built from templates. A template defines the fields, granularity and approval route, and is attached to a project, an account or an employee bucket. This lets one client's needs differ from another's without code changes.

**Template settings:**

| Setting | Options |
| --- | --- |
| Granularity | Hourly, half-day, daily; weekly or monthly submission |
| Standard fields | Date, project code, task / activity, hours, billable flag, location (offshore / onsite) |
| Custom fields | Text, number, dropdown, date, lookup (e.g. client ticket ID, sprint, work order, phase); required or optional; visible to client approver or internal only |
| Activity lists | Per project or account, for example Development, Testing, Meetings, Support |
| Rules | Minimum / maximum hours per day, no future entries, lock after N days, match attendance, holiday auto-fill |
| Approval route | Project lead → account manager; auto-approve for leadership. No client approval in v1 |
| Output | Export in the client's format (CSV / XLSX layout per template) for invoicing |

**Leadership and management timesheets:** a lighter template with time by category (client accounts, practice, pre-sales, internal initiatives, people management) rather than tasks. Weekly or fortnightly. This allocates leadership cost to accounts and practices in HRA.

**Retainers:** approved timesheets drive the monthly invoice amount (days or hours × rate, capped by contract), so a timesheet missing at cut-off blocks that invoice.

**Compliance:** reminders before cut-off, defaulter list per manager, and a missing-timesheet flag on the journey only if repeated (threshold configurable).

## Payroll

iPro runs payroll in-house for payroll employees and pays retainers from approved timesheets. Pay, cost and journey data share one source, and every run posts cost by person and component straight into HRA. Scope for now: India payroll only, for Ideassion's India entity. GCC and US payroll are out of scope until India is live.

- **Salary structures:** components (basic, HRA, special allowance, LTA and others), templates per grade, CTC-to-gross derivation, and effective-dated revisions with automatic arrears.
- **Inputs per run:** attendance and LOP, leave encashment, overtime, shift allowance, variable pay, points payouts, reimbursements, loan and advance recovery, one-time earnings and deductions.
- **India statutory:** PF, ESI, professional tax by state, LWF, TDS under old or new regime, investment declarations and proofs, Form 16 and quarterly 24Q. Employer gifts and vouchers, including points redemptions, are totalled per person per financial year; any amount above the ₹15,000 tax-free limit (Income-tax Rules 2026, Rule 15) is added as a taxable perquisite in that month's run. The limit is to be confirmed by the CA.
- **GCC statutory:** deferred. Statutory rules are versioned by effective date, so other countries can be added later without changing the payroll engine.
- **Retainers:** monthly payout from approved timesheet days or hours × rate, capped by contract, with TDS on professional fees and vendor-invoice GST tracked.
- **Run workflow:** open period → lock inputs → compute → variance check against last month (flags above a threshold) → HR and finance approval → payslips, bank file, statutory files and GL journal → close. Off-cycle runs for F&F, bonuses and corrections.
- **Full and final settlement:** triggered by the exit event; covers notice shortfall or buyout, leave encashment, gratuity, recoveries, final payslip and letters.
- **Self-service:** payslips, tax declarations and proofs, Form 16, reimbursement claims and loan requests.
- **Controls:** a separate payroll admin role, maker-checker approval, full audit log, and a parallel run alongside Ideassion's current payroll before cutover.

## Performance management

The organisation keeps a library of appraisal models and assigns them to populations through rules, each with its own cycle. A sales team can run quarterly MBO while engineers run half-yearly BARS plus 360, and leaders run a yearly 720 with an assessment centre, all in one system.

**Skills:** a skills taxonomy (skill, category, proficiency scale 1–5), self-declared skills, manager-validated levels, and evidence from certifications and project-exit feedback. The skills matrix shows people × skills per team, with gaps against role profiles.

**Appraisal model library (from the brief):**

| Model | What it measures | Typical population |
| --- | --- | --- |
| MBO (Management by Objectives) | Weighted objectives with targets and actuals | Sales, delivery managers, leadership |
| BARS (Behaviourally Anchored Rating Scales) | Competencies rated against written behaviour anchors | Engineers, analysts, support |
| 360-degree feedback | Self, manager, peers, reportees | Managers and leads |
| 720-degree feedback | 360 plus external raters (clients, partners), repeated after a development period | Senior leaders, client-facing heads |
| Assessment centre | Exercises scored by assessors (case, role-play, presentation) | Promotion to manager or leadership pipeline |
| Project-key feedback | Feedback collected at each project exit | Everyone allocated to projects |
| Standalone assessments | Ad hoc tests or surveys outside a cycle | Skill certification, role readiness |
| Self + manager appraisal | Simple two-step form | Small teams, retainers, support staff |

**Model configuration:** components and their weights (for example 50% objectives, 30% competencies, 20% project feedback), rating scale, form questions, who rates whom, calibration on or off, bell-curve distribution on or off (target % per rating band, with a calibration screen showing actual vs target and every forced move logged), and how the final score maps to a rating band.

**Cycle configuration (per model assignment):**

- **Frequency:** quarterly, half-yearly, yearly or custom dates, with a mid-cycle check-in.
- **Phases with dates:** goal setting, self-appraisal, peer / 360 collection, manager review, calibration, release, sign-off.
- **Eligibility:** joined before a cut-off date, pro-rating for partial periods, and exclusion of people on notice or long leave.
- **Outcome hooks:** increment matrix (rating × position in pay band), promotion nomination, variable pay, and performance improvement plan.

**Assignment rules** decide which model and cycle each person gets. They match on any combination of engagement type, bucket, department, grade, designation band, location and entity. When a person matches several rules, the most specific wins. A person who moves mid-cycle keeps their scores from the old model and finishes the cycle under the new one, pro-rated.

**Potential vs performance 9-box:** performance comes from the latest cycle score, and potential from a manager or talent-review rating (optionally the assessment-centre score). Shown per team with movement since the last review. It feeds succession and high-potential lists.

**Strategic competency data:** organisation-level heatmap of competency scores and skill gaps by department, grade and practice. Leadership uses it for hiring and L&D investment decisions.

## Learning, mentoring and Communities of Practice

L&D tracks what people learn, what it costs and what it changes. Cost and outcome data are needed for L&D RoI.

**Certifications track:** certification catalogue (issuer, level, validity), status per person (planned, exam booked, earned, expired), credential ID and certificate upload, sponsorship (fee, approval, service-bond terms) and renewal reminders 60 days before expiry. Earned certifications update the skills matrix.

**Internal sessions:** session catalogue (trainer, CoP, topic, skills tagged), nominations by self or manager, attendance status (nominated, attended, missed, cancelled), post-session assessment and feedback, and cost (trainer fee or internal trainer hours, venue, platform).

**Points:** participation points (attending, presenting, contributing to a CoP) and outcome points (assessment passed, certification earned, skill level up), set per rule. Points show on the profile and can carry money, appraisal weight, or both. Money: points are redeemed as vouchers or items from a catalogue at a rate per point set by HR, capped per person per financial year at ₹15,000 minus other employer gifts already given that year, so redemptions stay within the tax-free gift limit. The catalogue shows each employee their remaining tax-free room. Points above the cap still count for recognition and appraisal. Any cash payout goes through payroll as taxable salary. Appraisal: a weighted component in models that include points. Payouts are costed in HRA.

**Mentor / buddy mapping (optional):** buddies are assigned during onboarding for a defined period (default 90 days). Mentors are assigned on request or by programme, for example a high-potential programme. Each mapping has a start, end, goals and check-in log. The mentor sees only the mentee's summary and goals.

**Communities of Practice:** CoP groups (for example Data Engineering, Cloud, Business Analysis) with leads, members, join and leave dates, sessions, contributions (talks, articles, reusable assets) and points. Membership and contributions appear on the journey and are available as evidence in appraisals.

## Journey timeline views

The journey is a read model over the event store: every module above writes typed, dated events, and the timeline views render them. Designs so far are in the [Employee Journey Timeline canvas](https://claude.ai/artifact/Gvm9zDGzp8S1SFEwibdEtW).

| View | Audience | What it shows |
| --- | --- | --- |
| Full journey (exited employee) | HR, manager | Join to exit; event cards; designation, team and CTC lanes; detail panel with linked documents |
| Full journey (current employee) | Employee, manager, HR | Adds a Today line, upcoming events with countdowns (probation, exams, appraisal phases, anniversaries) and actions on due items |
| Compact journey | Anyone with profile access | One-line strip on the profile page; links to the full view |
| Team journeys | Manager, HR, CXO | Parallel rows per person; group by reportees, department, designation band, experience; hover for details; summary tiles |

**Event types to add beyond the current designs:** project entry and exit, bucket change, WFH policy change, CoP join and leave, mentor or buddy mapping, session attended, points milestones, leave over N days, PIP start and end, and retainer contract renewal.

**Lanes to add:** project allocation (bars per project with % and billable flag) and bucket (billable, bench, management).

**Visibility:** each event type has a sensitivity level. Compensation, PIP and exit-reason events are hidden from roles without access, so the same view is safe to show to a mentor or a project lead.

## AI assistant — Ask iPro

A chat panel on every screen and on mobile. It answers questions from iPro's own data and policies and drafts actions for the user to confirm. It runs with the user's permissions, takes every figure from an iPro query (with a link to the source screen), never changes data without a confirmation tap, and logs every exchange.

| Phase | What it can answer and do |
| --- | --- |
| 1 · Foundation | Leave balances, who is off or in office, probations and exits due, org and journey lookups, policy questions; drafts leave, approvals and letters |
| 2 · Work | Allocations and bench, timesheet gaps, payslip explanations ("why is my net pay lower this month?"), payroll variance; drafts timesheets and resource requests |
| 3 · Talent | Appraisal progress, rating distribution vs bell curve, skill gaps, certifications expiring, points; drafts goals and nominations |
| 4 · Intelligence | Cost and RoI questions, budget variance, what-if comparisons ("what if overhead is allocated per billable hour?") |

Payroll runs, compensation changes, exits and terminations can be drafted from chat but only completed on their own screens, with their normal approvals.

## Human Resource Accounting

HRA turns workforce events into cost and return figures per person, team, project and period. It is built into iPro and reads payroll, attendance, timesheet, allocation and L&D data directly, so there is no reconciliation between systems.

**Cost data captured at source:**

| Cost pool | Captured from | Examples |
| --- | --- | --- |
| Acquisition | Pre-boarding | Agency fees, referral bonus, job boards, assessments, interviewer hours, joining bonus, relocation |
| Onboarding | Onboarding checklist | Background verification, assets, induction hours, buddy hours, ramp-up period at partial productivity |
| Compensation | Payroll / retainer invoices | CTC components, employer statutory costs (PF, ESI, gratuity provision, GOSI), variable pay, retainer fees |
| Workplace | Hybrid planner + facilities | Seat cost per location, WFH allowance, internet, transport and meals per office day |
| Learning | L&D module | Course and exam fees, trainer cost, learner hours away from billable work, sponsorship bonds |
| Time | Attendance + timesheets | Overtime, leave encashment, unplanned absence, bench hours |
| Separation | Offboarding | Notice-period shortfall, buyout, F&F, backfill cost, knowledge-transfer hours, lost billing during vacancy |
| HR operations | Finance / vendors | HR software licences, payroll vendor, compliance and audit fees, HR staff cost |

**Metrics:**

| Metric | Formula | Main sources |
| --- | --- | --- |
| Cost per hire | (Acquisition + onboarding costs) ÷ hires in period | Pre-boarding, onboarding |
| L&D cost per employee | Total L&D cost ÷ average headcount | L&D |
| L&D RoI | (Measured benefit − L&D cost) ÷ L&D cost × 100. Benefit = utilisation or bill-rate uplift, certification-linked billing, avoided external hiring | L&D, projects, timesheets |
| Employee RoI | (Revenue or value attributed to the person − fully loaded cost) ÷ fully loaded cost | Projects, timesheets, payroll |
| Fully loaded cost | CTC + employer statutory + benefits + workplace + L&D + share of overheads | All pools |
| Human capital RoI | (Revenue − (operating cost − people cost)) ÷ people cost | Finance + payroll |
| Revenue per employee | Revenue ÷ average FTE | Finance |
| Turnover rate | Separations ÷ average headcount × 100, split voluntary / involuntary / regretted | Offboarding |
| Employee turnover cost | Separation + vacancy (lost billing or productivity) + replacement hire + ramp-up cost | Offboarding, projects, pre-boarding |
| Absenteeism rate | Unplanned absence days ÷ scheduled working days × 100 | Attendance, leave |
| Overtime cost and % | Overtime pay ÷ total pay; overtime hours ÷ standard hours | Attendance, timesheets |
| Billable utilisation | Billable hours ÷ available hours (excluding leave and holidays) | Timesheets |
| Talent pool (bench) cost | Σ (bench days × daily fully loaded cost) | Allocation, payroll |
| WFH / hybrid cost impact | (Office days × per-day office cost) + WFH allowances vs a fully on-site baseline; seat utilisation | Hybrid planner, facilities |
| HR cost per employee | (HR staff cost + HR software + HR vendors) ÷ headcount | Finance |
| HR-to-employee ratio | HR FTE ÷ total FTE | Org structure |
| Workforce budget variance | Actual people cost − budgeted people cost by cost centre, position and month | Positions, payroll |
| Workforce forecast | Projected headcount and cost from open positions, known exits, contract end dates, pipeline demand and attrition rate | Positions, projects, offboarding |

**Workforce budgeting:** an annual budget per cost centre with headcount by grade, planned increments, planned hires by month, and retainer spend. Actuals flow in monthly; variance and forecast are recomputed after each payroll close.

**Overhead allocation (choose and compare):** overheads such as rent, utilities, IT, leadership, admin and HR operations are pooled per period and allocated to people, projects and accounts. Finance picks a method per pool.

| Method | Basis | Suits |
| --- | --- | --- |
| Per head | Equal share per FTE | Simple, stable allocations |
| Per seat / office day | Office days from the hybrid planner | Rent, facilities, meals |
| Per billable hour | Approved billable hours | Pricing and project margin |
| Per cost (CTC ratio) | Share of total CTC | HR operations, insurance |
| Activity-based | Timesheet categories, including leadership timesheets | Leadership and practice cost |

A simulator shows each method side by side: fully loaded cost per person, project, account and cost centre, and the resulting change in project margin. Finance chooses a method per pool, locks it for the period, and the choice is versioned so past periods stay reproducible.

**Employee RoI on fixed-price projects:** calculated in two steps — the project's profit and loss first, then the project's value shared among the people who worked on it.

1. **Project revenue** is recognised by percentage of completion: contract value × (cost incurred to date ÷ estimated total cost at completion). Raising the estimate reduces recognised revenue immediately, so overruns show early. Policy to be confirmed with auditors (Ind AS 115).
2. **Project cost** = timesheet hours × fully loaded cost rate, plus software and AI licences, plus other direct expenses (travel, subcontractors, cloud, client-site costs), plus allocated overheads. A licence bought only for the project is charged in full; a shared licence, or one still used after the project, is spread over the months used and only the project's months are charged; pay-as-you-go AI and cloud usage is charged at the actual monthly bill.
3. **Timeline:** estimated total cost is tracked against the original budget every month. Revenue is fixed, so delay shows up as lower margin and RoI.
4. **Value per person:** the pot is revenue minus licences and other direct expenses, shared in proportion to hours × the role's standard (notional) bill rate.

```latex
\text{Value}_i = \frac{h_i \times r_i}{\sum_j h_j \times r_j} \times (\text{Revenue} - \text{Licences} - \text{Direct expenses})
```

```latex
\text{Employee RoI}_i = \frac{\text{Value}_i - \text{Fully loaded cost}_i}{\text{Fully loaded cost}_i}
```

Worked example: ₹50 L contract over 6 months, ₹3 L licences and ₹2 L other expenses, so ₹45 L to share. Overheads are inside the loaded costs.

| Person | Hours | Standard rate | Notional billing | Share | Value | Loaded cost | RoI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Tech lead | 800 | ₹3,000 | ₹24.0 L | 45.3% | ₹20.4 L | ₹12.0 L | 70% |
| Developer | 1,000 | ₹2,000 | ₹20.0 L | 37.7% | ₹17.0 L | ₹9.0 L | 89% |
| QA engineer | 600 | ₹1,500 | ₹9.0 L | 17.0% | ₹7.6 L | ₹5.0 L | 53% |

Project RoI: (₹50 L − ₹31 L) ÷ ₹31 L = 61%.

Guardrails: employee RoI stays a financial measure — project-exit feedback is not mixed into the weights — and is reported over several projects or a rolling 12 months, since one fixed-price deal can be won or lost by pricing the person did not set. Internal projects use the same method with an assigned internal value (cost avoided or the sponsor-approved budget) in place of contract revenue.

**Valuation view (optional, for formal HRA reporting):** human-asset value per person using the historical-cost approach (acquisition + development costs, amortised over expected tenure) or the replacement-cost approach. The model choice is a finance decision; the data captured above supports either.

## Dashboards, reports and alerts

Each role gets one home dashboard. Reports and exceptions are shared across roles but filtered by access.

| Dashboard | Key content |
| --- | --- |
| Employee | Today's work mode, pending timesheets, upcoming journey events, learning points, open feedback |
| Manager | Team attendance and hybrid compliance, approvals queue, probation and appraisal due dates, roll-offs in 30 days, team timeline |
| Project / account lead | Allocations, utilisation, timesheet status, roll-offs, pending project-exit feedback |
| HR | Headcount and movement, lifecycle checklists in progress, cycle progress by model, attrition, 9-box |
| L&D | Nominations vs attendance, certifications earned and expiring, spend vs budget, points leaderboard |
| Finance / HRA | Fully loaded cost by cost centre and project, bench cost, budget variance, HRA metrics |
| CXO | Headcount and cost trend, revenue per employee, utilisation, attrition and turnover cost, strategic competency heatmap |

**Exception alerts** (in-app, email, and optionally Teams or Slack):

- Probation due within 14 days with no review submitted.
- Timesheet missing at cut-off.
- Allocation ended with no new allocation (bench start).
- Project-exit feedback overdue.
- Retainer contract ending within 30 days.
- Certification expiring within 60 days.
- Hybrid compliance below policy for 2 consecutive weeks.
- Unplanned absence above threshold.
- Overtime above cap.
- People cost over budget by more than a set %.

**Reports:** standard report pack plus a report builder over the event store and HRA facts, with saved views, scheduled email and export to XLSX and PDF.

## Integrations, compliance and non-functional requirements

**Integrations:**

- **Banks and statutory portals:** salary transfer files, PF / ESI ECR files and TDS returns generated by iPro payroll.
- **Accounting / ERP** (for example Odoo, Tally, Zoho Books): project codes, cost centres, retainer invoices, payroll and HRA journals.
- **Biometric / access control:** daily punch import.
- **Identity:** SSO with Microsoft Entra ID and automatic account provisioning on joining and revocation on exit.
- **Calendar and messaging:** Outlook / Google Calendar for sessions and reviews; Teams or Slack for approvals and alerts.
- **E-signature** for letters.
- **Certification issuers'** verification links where available.
- **Open REST API and webhooks** for every event type.

**Statutory and compliance (to validate with local advisors before build):**

- **India:** PF, ESI, gratuity, professional tax and TDS data fields; Shops and Establishments leave rules by state; DPDP Act 2023 consent and data-principal rights.
- **GCC:** social insurance (for example GOSI in Saudi Arabia, SPF in Oman), WPS salary file data, end-of-service benefit accrual, and Omanisation / Saudisation tracking where applicable.
- **USA:** I-9 / E-Verify document status, state leave rules, and contractor vs employee classification flags for retainers.
- **Data residency:** per-entity choice of hosting region.

**Non-functional:**

- Multi-entity, multi-currency (cost reported in entity and group currency), multi-timezone and multi-calendar (weekends and holidays per location).
- Field-level encryption for KYC, bank and compensation data; full audit log of views and changes; configurable retention and deletion after exit.
- Effective-dated records throughout, so any report or org tree can be run "as of" a past date.
- Mobile-first self-service for attendance, WFH booking, timesheets and approvals.
- Configuration through admin screens (templates, models, cycles, rules, checklists), with versioning so past cycles keep the rules they ran under.
- Target scale for v1: 2,000 people across 5 entities, with no redesign needed to reach 20,000.

## Phasing

Build in four phases so each one produces the data the next depends on. HRA comes last because its metrics are only as good as the attendance, timesheet, allocation and L&D data beneath it.

&#91;embedded content: release plan · 4 phases, 3 gates\]

Phase 1 is the MVP for Ideassion and replaces spreadsheets for people records, attendance and hybrid planning. Payroll goes live in phase 2, after a parallel run against the current payroll. Each gate (diamond) is the condition for starting the next phase; durations depend on team size and are not set yet.

Phase 1 build specification: Phase 1 build spec

## Decisions

| Topic | Decision |
| --- | --- |
| Product name | iPro |
| Payroll | Built in-house in iPro; India only for now |
| HRA | Built into iPro |
| Overhead allocation | Configurable; finance compares methods in a simulator and picks one per pool per period |
| Project-exit feedback | Visible to the employee once the project owner approves it |
| Bell curve | Allowed, switched on per appraisal model |
| Points | May carry monetary value, appraisal weight, or both; money paid as catalogue vouchers, capped at ₹15,000 a year per person less other employer gifts |
| Client timesheet approval | Not in v1 |
| First customer | Ideassion |

Still open:

- [ ] Decided: employee RoI on fixed-price and internal projects uses percentage-of-completion revenue and hours × standard-rate attribution (see HRA).
- [ ] Order of payroll countries after India (deferred): Oman, Saudi Arabia, USA.
- [ ] Decided: points redeem as vouchers, capped at ₹15,000 a year per person less other employer gifts; cash payouts are taxed through payroll. CA to confirm the notified limit.
- [ ] Decided: peer input in project-exit feedback is anonymous to the employee.
