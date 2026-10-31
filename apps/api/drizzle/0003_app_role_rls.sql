-- The API runs each transaction as ipro_app (SET LOCAL ROLE, see src/db/tenant-context.ts). Superusers and
-- table owners bypass row-level security, so the role must be neither (decision #26).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ipro_app') THEN
    CREATE ROLE ipro_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
GRANT ipro_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ipro_app;
--> statement-breakpoint
GRANT SELECT ON tenant TO ipro_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app_user, role_assignment, entra_group_role, session, auth_request,
  approval_delegation, tenant_data_key TO ipro_app;
--> statement-breakpoint
-- Append-only: the app may only add audit rows.
GRANT SELECT, INSERT ON audit_log TO ipro_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint
-- Tenant isolation on every tenant-scoped table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_user', 'role_assignment', 'entra_group_role', 'session', 'auth_request',
    'approval_delegation', 'audit_log', 'tenant_data_key']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE approval_delegation
  ADD CONSTRAINT approval_delegation_dates_check CHECK (ends_on >= starts_on),
  ADD CONSTRAINT approval_delegation_not_self_check CHECK (delegate_user_id <> delegator_user_id);
--> statement-breakpoint
ALTER TABLE role_assignment
  ADD CONSTRAINT role_assignment_source_check CHECK (source IN ('entra_group', 'manual'));
--> statement-breakpoint
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('view', 'unmask', 'create', 'update', 'delete', 'export'));
