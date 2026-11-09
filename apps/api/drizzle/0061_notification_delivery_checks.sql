-- Decision #87: the delivery outbox and each person's Teams address.
ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_values_check CHECK (
  channel IN ('teams', 'email') AND
  status IN ('pending', 'sent', 'failed', 'unreachable') AND
  attempts >= 0 AND
  (status <> 'sent' OR sent_at IS NOT NULL));
--> statement-breakpoint
-- Delivery rows and Teams addresses are updated in place and kept as the record, never deleted.
GRANT SELECT, INSERT, UPDATE ON notification_delivery, teams_conversation TO ipro_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_delivery', 'teams_conversation']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
