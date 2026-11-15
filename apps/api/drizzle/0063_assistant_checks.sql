-- Decision #88: Ask iPro conversations. Questions and answers are never edited; the 180-day
-- retention job (slice 12c) replaces old conversations with a summary.
ALTER TABLE assistant_message ADD CONSTRAINT assistant_message_role_check CHECK (
  role IN ('user', 'assistant') AND
  (role = 'assistant' OR model IS NULL));
--> statement-breakpoint
GRANT SELECT, INSERT ON assistant_message TO ipro_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON assistant_conversation TO ipro_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistant_conversation', 'assistant_message']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
