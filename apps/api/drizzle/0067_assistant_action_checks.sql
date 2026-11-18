-- Decision #91: confirmation cards. A card is confirmed or cancelled once, by its user.
ALTER TABLE assistant_action ADD CONSTRAINT assistant_action_values_check CHECK (
  kind IN ('apply_leave', 'approve_leave', 'draft_letter') AND
  status IN ('proposed', 'confirming', 'confirmed', 'cancelled', 'failed') AND
  (status IN ('proposed', 'confirming') OR decided_at IS NOT NULL));
--> statement-breakpoint
ALTER TABLE assistant_message ADD CONSTRAINT assistant_message_action_fk
  FOREIGN KEY (proposed_action_id) REFERENCES assistant_action(id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON assistant_action TO ipro_app;
--> statement-breakpoint
-- Messages stay as written; only the confirmation of the card they offered is recorded later.
GRANT UPDATE (confirmed_action_id) ON assistant_message TO ipro_app;
--> statement-breakpoint
ALTER TABLE assistant_action ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE assistant_action FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON assistant_action
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
