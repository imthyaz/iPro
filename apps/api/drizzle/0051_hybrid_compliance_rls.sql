ALTER TABLE hybrid_compliance_day ADD CONSTRAINT hybrid_compliance_day_values_check CHECK (
  required_mode IN ('office', 'client_site') AND
  required_days BETWEEN 0 AND 7 AND
  (planned_mode IS NULL OR planned_mode IN ('office', 'wfh', 'client_site')) AND
  (actual_mode IS NULL OR actual_mode IN ('office', 'wfh', 'client_site')) AND
  extract(isodow from week_start) = 1 AND
  date BETWEEN week_start AND week_start + 6);
--> statement-breakpoint
-- Derived rows: recorded again when a week is re-checked, never deleted.
GRANT SELECT, INSERT, UPDATE ON hybrid_compliance_day TO ipro_app;
--> statement-breakpoint
ALTER TABLE hybrid_compliance_day ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hybrid_compliance_day FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON hybrid_compliance_day
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
