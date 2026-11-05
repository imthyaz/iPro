ALTER TABLE attendance_regularisation ADD CONSTRAINT attendance_regularisation_values_check CHECK (
  source IN ('employee', 'hr') AND
  status IN ('present', 'wfh', 'client_site', 'half_day') AND
  state IN ('pending', 'returned', 'approved', 'withdrawn') AND
  (reason_code IS NULL OR reason_code IN ('forgot_to_punch', 'on_duty', 'client_site', 'system_issue')) AND
  -- An employee's request carries a reason code; HR's carries a reason note.
  (source = 'hr' OR reason_code IS NOT NULL) AND
  (source = 'employee' OR note IS NOT NULL) AND
  (first_in IS NULL OR last_out IS NULL OR first_in < last_out));
--> statement-breakpoint
-- Requests are kept with their outcome: no deletes.
GRANT SELECT, INSERT, UPDATE ON attendance_regularisation TO ipro_app;
--> statement-breakpoint
ALTER TABLE attendance_regularisation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE attendance_regularisation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON attendance_regularisation USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
