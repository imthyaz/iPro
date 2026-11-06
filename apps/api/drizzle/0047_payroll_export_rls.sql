ALTER TABLE payroll_export ADD CONSTRAINT payroll_export_values_check CHECK (
  month ~ '^\d{4}-(0[1-9]|1[0-2])$' AND row_count >= 0);
--> statement-breakpoint
-- An export is a record of what was sent: added, never changed or deleted.
GRANT SELECT, INSERT ON payroll_export TO ipro_app;
--> statement-breakpoint
ALTER TABLE payroll_export ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payroll_export FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON payroll_export USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
