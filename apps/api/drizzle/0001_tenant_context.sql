-- Tenant context for row-level security. Each request runs in a transaction that sets
-- `app.tenant_id` locally (see src/db/tenant-context.ts). Every tenant-scoped table gets:
--   ALTER TABLE x ENABLE ROW LEVEL SECURITY; ALTER TABLE x FORCE ROW LEVEL SECURITY;
--   CREATE POLICY tenant_isolation ON x USING (tenant_id = app_current_tenant_id())
--     WITH CHECK (tenant_id = app_current_tenant_id());
CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
