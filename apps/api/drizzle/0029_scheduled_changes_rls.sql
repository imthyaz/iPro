ALTER TABLE scheduled_change ADD CONSTRAINT scheduled_change_kind_check CHECK (kind IN ('conversion'));
--> statement-breakpoint
ALTER TABLE scheduled_change ADD CONSTRAINT scheduled_change_status_check
  CHECK (status IN ('pending', 'applied', 'failed', 'cancelled'));
--> statement-breakpoint
ALTER TABLE scheduled_change ADD CONSTRAINT scheduled_change_applied_check
  CHECK ((status = 'applied') = (applied_at IS NOT NULL));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON scheduled_change TO ipro_app;
--> statement-breakpoint
ALTER TABLE scheduled_change ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE scheduled_change FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON scheduled_change USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
