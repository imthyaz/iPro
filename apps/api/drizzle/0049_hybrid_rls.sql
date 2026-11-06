ALTER TABLE work_policy ADD CONSTRAINT work_policy_values_check CHECK (
  required_mode IN ('office', 'client_site') AND
  required_days BETWEEN 0 AND 7 AND
  cardinality(allowed_modes) > 0 AND
  allowed_modes <@ ARRAY['office', 'wfh', 'client_site']::text[] AND
  location_types <@ ARRAY['office', 'client_site', 'remote']::text[] AND
  priority >= 0);
--> statement-breakpoint
ALTER TABLE team_anchor_day ADD CONSTRAINT team_anchor_day_weekday_check CHECK (
  weekday IS NULL OR weekday BETWEEN 1 AND 7);
--> statement-breakpoint
ALTER TABLE hybrid_exception ADD CONSTRAINT hybrid_exception_status_check CHECK (
  status IN ('pending', 'approved', 'returned', 'withdrawn') AND
  extract(isodow from week_start) = 1);
--> statement-breakpoint
ALTER TABLE work_booking ADD CONSTRAINT work_booking_values_check CHECK (
  mode IN ('office', 'wfh', 'client_site') AND
  status IN ('confirmed', 'pending', 'rejected', 'cancelled') AND
  extract(isodow from week_start) = 1 AND
  date BETWEEN week_start AND week_start + 6 AND
  (mode <> 'wfh' OR (location_id IS NULL AND seat_id IS NULL)) AND
  (seat_id IS NULL OR mode = 'office'));
--> statement-breakpoint
-- Configuration and plans are kept: policies and seats are made inactive, bookings cancelled.
GRANT SELECT, INSERT, UPDATE ON work_policy, seat, team_anchor_day, hybrid_exception, work_booking
  TO ipro_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_policy', 'seat', 'team_anchor_day', 'hybrid_exception',
    'work_booking']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
