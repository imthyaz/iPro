ALTER TABLE leave_type ADD CONSTRAINT leave_type_values_check CHECK (
  kind IN ('accrued', 'granted', 'per_request', 'unlimited') AND
  -- Accrued types say how much a year; per-request types how much a request.
  ((kind = 'accrued') = (per_year IS NOT NULL)) AND
  (kind <> 'per_request' OR max_per_request IS NOT NULL) AND
  -- Unlimited leave is loss of pay.
  (kind <> 'unlimited' OR NOT paid) AND
  (per_year IS NULL OR per_year BETWEEN 0 AND 36600) AND
  (max_balance IS NULL OR max_balance >= 0) AND
  (carry_forward_cap IS NULL OR carry_forward_cap >= 0) AND
  (max_per_request IS NULL OR max_per_request > 0) AND
  (document_after_days IS NULL OR document_after_days >= 0) AND
  (expires_after_days IS NULL OR expires_after_days > 0));
--> statement-breakpoint
ALTER TABLE leave_ledger_entry ADD CONSTRAINT leave_ledger_entry_values_check CHECK (
  kind IN ('opening', 'accrual', 'carry_forward', 'lapse', 'grant', 'expiry', 'taken', 'restored',
           'encashed', 'adjustment') AND
  amount <> 0 AND
  -- Credits are positive and debits negative; opening, adjustments and carry-forward (a negative
  -- balance carries as it is) go either way.
  (kind NOT IN ('accrual', 'grant', 'restored') OR amount > 0) AND
  (kind NOT IN ('lapse', 'expiry', 'taken', 'encashed') OR amount < 0) AND
  (kind NOT IN ('accrual', 'carry_forward', 'lapse') OR period IS NOT NULL) AND
  -- HR's adjustments and imports say why.
  (kind NOT IN ('adjustment', 'opening') OR note IS NOT NULL) AND
  year BETWEEN 2000 AND 2100);
--> statement-breakpoint
-- Leave types are configuration (made inactive, never deleted); the ledger is add-only.
GRANT SELECT, INSERT, UPDATE ON leave_type TO ipro_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON leave_ledger_entry TO ipro_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leave_type', 'leave_ledger_entry']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
