ALTER TABLE leave_request ADD CONSTRAINT leave_request_values_check CHECK (
  status IN ('applied', 'returned', 'approved', 'cancelled', 'revoked', 'withdrawn') AND
  start_half IN ('full', 'second') AND
  end_half IN ('full', 'first') AND
  from_date <= to_date AND
  days > 0 AND
  lop_days >= 0 AND lop_days <= days AND
  (revoked_from IS NULL OR revoked_from BETWEEN from_date AND to_date) AND
  (revoked_from IS NULL OR revoke_reason IS NOT NULL));
--> statement-breakpoint
ALTER TABLE leave_request_day ADD CONSTRAINT leave_request_day_values_check CHECK (
  half IN ('full', 'first', 'second') AND
  ((half = 'full' AND amount = 100) OR (half <> 'full' AND amount = 50)));
--> statement-breakpoint
-- Decision #74: maternity leave counts calendar days (26 weeks). Only the type created from the
-- earlier defaults is updated.
UPDATE leave_type SET counts_calendar_days = true
  WHERE code = 'ML' AND kind = 'per_request' AND max_per_request = 18200;
--> statement-breakpoint
-- Requests are kept with their outcome; their days are marked cancelled, never deleted.
GRANT SELECT, INSERT, UPDATE ON leave_request, leave_request_day TO ipro_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leave_request', 'leave_request_day']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
