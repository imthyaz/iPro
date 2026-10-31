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
