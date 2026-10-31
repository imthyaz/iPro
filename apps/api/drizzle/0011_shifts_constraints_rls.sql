-- One shift allocation in force per engagement per day (inclusive end dates, decision #32).
ALTER TABLE shift_assignment ADD CONSTRAINT shift_assignment_no_overlap
  EXCLUDE USING gist (engagement_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&);
--> statement-breakpoint
ALTER TABLE shift_assignment ADD CONSTRAINT shift_assignment_dates_check
  CHECK (effective_to IS NULL OR effective_to >= effective_from);
--> statement-breakpoint
-- ISO weekdays only, no duplicates, and at least one working day a week.
ALTER TABLE shift ADD CONSTRAINT shift_weekly_offs_check
  CHECK (weekly_offs <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[] AND cardinality(weekly_offs) < 7);
--> statement-breakpoint
ALTER TABLE shift ADD CONSTRAINT shift_minutes_check
  CHECK (break_minutes >= 0 AND grace_minutes >= 0 AND half_day_minutes >= 0);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON shift, shift_assignment TO ipro_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shift', 'shift_assignment']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
