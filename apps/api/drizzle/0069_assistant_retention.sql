-- Decision #92: after 180 days a conversation is replaced by its summary. The retention job is the
-- only place that deletes rows (CLAUDE.md): a conversation's questions, answers and cards.
GRANT SELECT, INSERT ON assistant_summary TO ipro_app;
--> statement-breakpoint
GRANT DELETE ON assistant_message, assistant_action TO ipro_app;
--> statement-breakpoint
ALTER TABLE assistant_summary ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE assistant_summary FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON assistant_summary
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- The daily brief (decision #92) is a topic people may switch off, like requests and people updates.
ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_topics_check;
--> statement-breakpoint
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_topics_check CHECK (
  off_topics <@ ARRAY['requests', 'people', 'brief']::text[]);
