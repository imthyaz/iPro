ALTER TABLE exit_case ADD CONSTRAINT exit_case_values_check CHECK (
  kind IN ('resignation', 'termination') AND
  status IN ('submitted', 'serving_notice', 'clearance', 'exited', 'withdrawn') AND
  (reason IS NULL OR reason IN ('better_opportunity', 'higher_studies', 'relocation',
    'compensation', 'role_or_growth', 'manager_or_team', 'health', 'personal', 'other')) AND
  notice_days >= 0 AND
  (early_release IS NULL OR early_release IN ('buyout', 'waiver')) AND
  (buyout_days IS NULL OR (early_release = 'buyout' AND buyout_days > 0)) AND
  (last_working_date IS NULL OR last_working_date >= resignation_date) AND
  (status IN ('submitted', 'withdrawn') OR last_working_date IS NOT NULL));
--> statement-breakpoint
-- Exits are kept with their outcome, never deleted.
GRANT SELECT, INSERT, UPDATE ON exit_case TO ipro_app;
--> statement-breakpoint
ALTER TABLE exit_case ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE exit_case FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON exit_case USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
