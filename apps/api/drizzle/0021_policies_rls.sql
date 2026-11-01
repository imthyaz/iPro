ALTER TABLE policy_version ADD CONSTRAINT policy_version_hash_check
  CHECK (content_hash ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
-- An acceptance is of the exact content that was published.
CREATE OR REPLACE FUNCTION policy_acknowledgement_hash_matches() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM policy_version v WHERE v.id = NEW.policy_version_id AND v.content_hash = NEW.content_hash
  ) THEN
    RAISE EXCEPTION 'acknowledged content does not match the policy version';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER policy_acknowledgement_hash BEFORE INSERT ON policy_acknowledgement
  FOR EACH ROW EXECUTE FUNCTION policy_acknowledgement_hash_matches();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON policy TO ipro_app;
--> statement-breakpoint
-- Published versions and acceptances are records: add only.
GRANT SELECT, INSERT ON policy_version, policy_acknowledgement TO ipro_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['policy', 'policy_version', 'policy_acknowledgement']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
