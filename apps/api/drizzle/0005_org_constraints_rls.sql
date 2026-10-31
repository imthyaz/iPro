-- Effective dating: no two versions of one unit may overlap (inclusive end dates, null = open).
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE business_unit_version ADD CONSTRAINT business_unit_version_no_overlap
  EXCLUDE USING gist (business_unit_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&);
--> statement-breakpoint
ALTER TABLE department_version ADD CONSTRAINT department_version_no_overlap
  EXCLUDE USING gist (department_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&);
--> statement-breakpoint
ALTER TABLE location_version ADD CONSTRAINT location_version_no_overlap
  EXCLUDE USING gist (location_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&);
--> statement-breakpoint
ALTER TABLE business_unit_version ADD CONSTRAINT business_unit_version_dates_check
  CHECK (effective_to IS NULL OR effective_to >= effective_from);
--> statement-breakpoint
ALTER TABLE department_version ADD CONSTRAINT department_version_dates_check
  CHECK (effective_to IS NULL OR effective_to >= effective_from);
--> statement-breakpoint
ALTER TABLE location_version ADD CONSTRAINT location_version_dates_check
  CHECK (effective_to IS NULL OR effective_to >= effective_from);
--> statement-breakpoint
ALTER TABLE department_version ADD CONSTRAINT department_version_not_own_parent_check
  CHECK (parent_department_id IS NULL OR parent_department_id <> department_id);
--> statement-breakpoint
ALTER TABLE grade ADD CONSTRAINT grade_band_check
  CHECK (band_min IS NULL OR band_max IS NULL OR band_max >= band_min);
--> statement-breakpoint
ALTER TABLE location_version ADD CONSTRAINT location_version_type_check
  CHECK (type IN ('office', 'client_site', 'remote'));
--> statement-breakpoint
ALTER TABLE designation ADD CONSTRAINT designation_band_check
  CHECK (designation_band IN ('associate', 'senior_lead', 'manager_plus'));
--> statement-breakpoint
ALTER TABLE position ADD CONSTRAINT position_status_check CHECK (status IN ('open', 'filled', 'frozen'));
--> statement-breakpoint
-- Nothing is hard-deleted: the app may insert and update, not delete.
GRANT SELECT, INSERT, UPDATE ON legal_entity, business_unit, business_unit_version, department,
  department_version, location, location_version, cost_centre, grade, designation, position TO ipro_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['legal_entity', 'business_unit', 'business_unit_version', 'department',
    'department_version', 'location', 'location_version', 'cost_centre', 'grade', 'designation', 'position']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
