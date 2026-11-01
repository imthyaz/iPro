# Open questions

Questions for Ideassion. Until answered, the "proposed default" in the spec's business rules table is used, as a
configurable setting.

## Policies (from the spec's business rules table — all [to confirm])
- [ ] Employee code format; probation length and extensions; notice periods by grade; buyout/waiver rules.
- [ ] Working days, shift times, grace, half-day threshold; holiday calendar per location.
- [ ] Leave types: entitlement, accrual, carry-forward, encashment, sandwich rule, leave year, probation rules.
- [ ] Regularisation window and monthly limit; check-in methods per population.
- [ ] Hybrid policies per team, anchor days, booking cut-off, seat counts per office.
- [ ] Approval chains, second-level leave threshold, escalation window.
- [ ] Buckets list and designation-to-band mapping.
- [ ] Data retention periods (confirm with legal).

## Templates
- [ ] Offer, LOI, confirmation, extension, transfer, relieving, experience letters.
- [ ] Onboarding and exit checklists with owners; exit interview questions.

## Data and devices
- [ ] Employee master (3 years), leave balances at cut-off, designation/promotion/exit history.
- [ ] Biometric device make, model and access method.
- [ ] A sample month of attendance and LOP as calculated today.

## Other
- [ ] Legal: do sponsored-certification service bonds need e-stamping? (Phase 3; Leegality if yes.)

## Permissions table (slice 1 — built as written, please confirm)
- [ ] HR head probation "R, A terminate": built as read + approve termination only. Should HR head also approve confirm/extend (HR does)?
- [ ] HR attendance and leave updates require a reason; HR head's ("R, U") do not, as the table says. Should HR head also give a reason?
- [ ] Delegation is not in the permissions table: built per decision #27 (managers for themselves, HR/HR head for anyone). Confirm.

## Engineering (for slice 2)
- [x] Local S3 stand-in: SeaweedFS (decision #37).
- [ ] Probation length is specified only for permanent staff (6 months) and retainers (none). Fixed-term, intern,
      trainee and consultant engagements currently get no probation until Ideassion sets a value.

## KYC (slice 2c — please confirm)
- [x] Aadhaar: full number stored encrypted, shown only on an audited HR unmask, for now (decision #40). Still confirm
      with legal before go-live whether an Aadhaar Data Vault is required.
- [x] Employees may open their own KYC scans (decision #39).
- [x] Probation after a conversion: decided per conversion by HR and CXO (decision #42).

## Shifts (slice 3, decision #46 — please confirm)
- [x] Holiday calendar for customer-week teams: customer’s or company’s, HR assigns, default customer’s (decision #48).
- [x] Shift definitions and times are configurable by admins (decision #47); Ideassion to enter its own.
- [x] Managers request shift changes for their team; HR approves (decision #47).

## Zoho Sign (slice 3c — needs the account owner)
- [ ] Zoho Sign OAuth client and refresh token (India data centre), stored in Secrets Manager; then a live test of
      sending, signing and the webhook. The client is built against Zoho Sign's v1 API and tested with simulated
      responses only.
- [ ] Confirm the webhook signature header and secret Zoho Sign uses for this account (configurable:
      `ZOHO_SIGN_WEBHOOK_HEADER`, `ZOHO_SIGN_WEBHOOK_SECRET`). Status is always re-fetched from Zoho either way.

## Offers and interns (slice 4, decisions #54–#56 — please confirm)
- [ ] Offer expiry: proposed default 7 days after sending, then the offer is marked declined (setting `offer_expiry_days`).
- [ ] Employee code is issued when the offer is created, so declined offers leave gaps in the sequence. Alternative:
      issue it on acceptance.
- [ ] Day-1 tasks: proposed as mandatory onboarding tasks due on or before the joining date; HR can waive any.
- [ ] Intern assessment: what the form asks (proposed: rating 1–5 on a few competencies, comments, recommendation),
      and when it is due (proposed: 14 days before the end date, reminder at 7).
- [ ] Intern "break": proposed as ending the internship with rehire eligible, and a return as a new linked engagement.
      Is a break ever paid, or time-limited?
- [ ] Usual internship lengths and whether interns get any leave or probation (proposed: no probation).

## Pre-joiner sign-in (slice 4b, decisions #55 and #57 — needs the account owner)
- [ ] An app registration for Microsoft Graph with application permissions User.Invite.All and
      GroupMember.ReadWrite.All (admin consent), its secret in Secrets Manager (`GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`).
- [ ] An Entra security group for pre-joiners (`PREJOINER_GROUP_ID`), assigned to the iPro app and mapped to the
      employee role in iPro. External collaboration settings must allow guest invitations with email one-time codes.
- [ ] Should iPro remove the guest account from Entra after joining or a no-show (needs User.ReadWrite.All), or does
      IT do it? Proposed: IT, from an exit-style checklist task.
