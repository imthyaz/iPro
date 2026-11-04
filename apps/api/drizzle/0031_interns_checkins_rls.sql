ALTER TABLE probation_check_in ADD CONSTRAINT probation_check_in_progress_check
  CHECK (progress IS NULL OR progress IN ('on_track', 'needs_support', 'at_risk'));
--> statement-breakpoint
-- A recorded check-in says how it went, in a word and a note, and when.
ALTER TABLE probation_check_in ADD CONSTRAINT probation_check_in_recorded_check
  CHECK ((recorded_at IS NULL) = (progress IS NULL) AND (recorded_at IS NULL) = (notes IS NULL));
--> statement-breakpoint
ALTER TABLE probation_check_in ADD CONSTRAINT probation_check_in_month_check CHECK (month >= 1);
--> statement-breakpoint
ALTER TABLE review ADD CONSTRAINT review_convert_check CHECK (
  (convert_to IS NULL OR convert_to IN ('permanent', 'fixed_term')) AND
  (convert_probation IS NULL OR convert_probation IN ('policy', 'none')));
--> statement-breakpoint
-- Check-ins are performance records: they change state, never disappear.
GRANT SELECT, INSERT, UPDATE ON probation_check_in TO ipro_app;
--> statement-breakpoint
ALTER TABLE probation_check_in ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE probation_check_in FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON probation_check_in USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
