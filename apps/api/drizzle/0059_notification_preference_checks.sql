-- Decision #86: only switchable topics can be turned off (approvals and compliance items can't).
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_topics_check CHECK (
  off_topics <@ ARRAY['requests', 'people']::text[]);
--> statement-breakpoint
-- Preferences are changed in place, never deleted.
GRANT SELECT, INSERT, UPDATE ON notification_preference TO ipro_app;
--> statement-breakpoint
ALTER TABLE notification_preference ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_preference FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON notification_preference
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
