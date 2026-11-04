ALTER TABLE holiday_calendar ADD CONSTRAINT holiday_calendar_kind_check
  CHECK (kind IN ('company', 'customer'));
--> statement-breakpoint
-- Locations point at their company calendar (the column existed since slice 2).
ALTER TABLE location_version ADD CONSTRAINT location_version_holiday_calendar_fk
  FOREIGN KEY (holiday_calendar_id) REFERENCES holiday_calendar(id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON holiday_calendar TO ipro_app;
--> statement-breakpoint
-- Calendars and holidays are soft-deleted, never removed.
GRANT SELECT, INSERT, UPDATE ON holiday TO ipro_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['holiday_calendar', 'holiday']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
