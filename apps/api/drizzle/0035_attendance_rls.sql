ALTER TABLE punch ADD CONSTRAINT punch_values_check CHECK (
  (direction IS NULL OR direction IN ('in', 'out')) AND
  source IN ('web', 'mobile', 'biometric') AND
  (mode IS NULL OR mode IN ('office', 'wfh', 'client_site')) AND
  -- A biometric punch names its device; a check-in from web or phone names its mode.
  ((source = 'biometric') = (device_id IS NOT NULL)) AND
  (source = 'biometric' OR mode IS NOT NULL));
--> statement-breakpoint
ALTER TABLE attendance_day ADD CONSTRAINT attendance_day_status_check CHECK (
  status IN ('present', 'absent', 'half_day', 'leave', 'holiday', 'weekly_off', 'wfh', 'client_site'));
--> statement-breakpoint
ALTER TABLE location_version ADD CONSTRAINT location_version_geofence_check CHECK (
  (latitude IS NULL) = (longitude IS NULL) AND
  (latitude IS NULL OR latitude BETWEEN -90 AND 90) AND
  (longitude IS NULL OR longitude BETWEEN -180 AND 180) AND
  (geofence_radius_metres IS NULL OR geofence_radius_metres BETWEEN 25 AND 5000));
--> statement-breakpoint
-- Punches are records of what happened: add only.
GRANT SELECT, INSERT ON punch TO ipro_app;
--> statement-breakpoint
-- Attendance days are rebuilt from punches; devices are configuration (soft-deleted).
GRANT SELECT, INSERT, UPDATE ON attendance_day, biometric_device TO ipro_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['punch', 'attendance_day', 'biometric_device']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
