ALTER TABLE review ADD CONSTRAINT review_kind_check CHECK (kind IN ('probation', 'internship'));
--> statement-breakpoint
ALTER TABLE review ADD CONSTRAINT review_status_check
  CHECK (status IN ('due', 'submitted', 'decided', 'cancelled'));
--> statement-breakpoint
-- A submitted or decided review carries what the manager recommended and when.
ALTER TABLE review ADD CONSTRAINT review_submitted_check CHECK (
  status IN ('due', 'cancelled') OR (recommendation IS NOT NULL AND submitted_at IS NOT NULL));
--> statement-breakpoint
ALTER TABLE review ADD CONSTRAINT review_decided_check
  CHECK ((status = 'decided') = (decision IS NOT NULL AND decided_at IS NOT NULL));
--> statement-breakpoint
-- Reviews are performance records: they change state, never disappear.
GRANT SELECT, INSERT, UPDATE ON review TO ipro_app;
--> statement-breakpoint
ALTER TABLE review ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE review FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON review USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
