-- Decision #83: an internship ending as agreed is an exit too (end_of_term).
ALTER TABLE exit_case DROP CONSTRAINT exit_case_values_check;
--> statement-breakpoint
ALTER TABLE exit_case ADD CONSTRAINT exit_case_values_check CHECK (
  kind IN ('resignation', 'termination', 'end_of_term') AND
  status IN ('submitted', 'serving_notice', 'clearance', 'exited', 'withdrawn') AND
  (reason IS NULL OR reason IN ('better_opportunity', 'higher_studies', 'relocation',
    'compensation', 'role_or_growth', 'manager_or_team', 'health', 'personal', 'other')) AND
  notice_days >= 0 AND
  (early_release IS NULL OR early_release IN ('buyout', 'waiver')) AND
  (buyout_days IS NULL OR (early_release = 'buyout' AND buyout_days > 0)) AND
  (last_working_date IS NULL OR last_working_date >= resignation_date) AND
  (status IN ('submitted', 'withdrawn') OR last_working_date IS NOT NULL));
--> statement-breakpoint
-- Full and final: an encrypted amount always comes with its currency and when it was recorded.
ALTER TABLE exit_case ADD CONSTRAINT exit_case_settlement_check CHECK (
  (settlement_amount_encrypted IS NULL) = (settlement_recorded_at IS NULL) AND
  (settlement_amount_encrypted IS NULL OR settlement_currency = 'INR'));
