-- Exactly one assignment and one compensation row in force per engagement on any date (inclusive ends).
ALTER TABLE assignment ADD CONSTRAINT assignment_no_overlap
  EXCLUDE USING gist (engagement_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&);
--> statement-breakpoint
ALTER TABLE compensation ADD CONSTRAINT compensation_no_overlap
  EXCLUDE USING gist (engagement_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&);
--> statement-breakpoint
ALTER TABLE assignment ADD CONSTRAINT assignment_dates_check
  CHECK (effective_to IS NULL OR effective_to >= effective_from);
--> statement-breakpoint
ALTER TABLE compensation ADD CONSTRAINT compensation_dates_check
  CHECK (effective_to IS NULL OR effective_to >= effective_from);
--> statement-breakpoint
ALTER TABLE assignment ADD CONSTRAINT assignment_not_own_manager_check
  CHECK (manager_engagement_id IS NULL OR manager_engagement_id <> engagement_id);
--> statement-breakpoint
ALTER TABLE engagement ADD CONSTRAINT engagement_previous_fk
  FOREIGN KEY (previous_engagement_id) REFERENCES engagement (id);
--> statement-breakpoint
ALTER TABLE engagement ADD CONSTRAINT engagement_type_check
  CHECK (type IN ('permanent', 'fixed_term', 'intern', 'trainee', 'retainer', 'consultant'));
--> statement-breakpoint
ALTER TABLE engagement ADD CONSTRAINT engagement_status_check
  CHECK (status IN ('offered', 'pre_joining', 'active', 'on_notice', 'exited', 'withdrawn'));
--> statement-breakpoint
ALTER TABLE compensation ADD CONSTRAINT compensation_rate_unit_check
  CHECK (rate_unit IN ('year', 'month', 'day', 'hour'));
--> statement-breakpoint
ALTER TABLE journal_event ADD CONSTRAINT journal_event_sensitivity_check
  CHECK (sensitivity IN ('public', 'manager', 'hr', 'restricted'));
--> statement-breakpoint
-- Nothing is hard-deleted by the app.
GRANT SELECT, INSERT, UPDATE ON person, emergency_contact, engagement, assignment, compensation,
  employee_code_counter, tenant_setting TO ipro_app;
--> statement-breakpoint
-- The journey is append-only; only the planned flag (and its audit columns) may change.
GRANT SELECT, INSERT ON journal_event TO ipro_app;
--> statement-breakpoint
GRANT UPDATE (is_planned, updated_at, updated_by) ON journal_event TO ipro_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['person', 'emergency_contact', 'engagement', 'assignment', 'compensation',
    'employee_code_counter', 'tenant_setting', 'journal_event']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
