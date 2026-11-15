-- Decision #89: policy clauses for Ask iPro, searchable with Postgres full-text search.
ALTER TABLE policy_clause ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(number, '') || ' ' || heading), 'A') ||
  setweight(to_tsvector('english', body), 'B')) STORED;
--> statement-breakpoint
CREATE INDEX policy_clause_search_idx ON policy_clause USING gin (search);
--> statement-breakpoint
ALTER TABLE policy_clause ADD CONSTRAINT policy_clause_position_check CHECK (position >= 1);
--> statement-breakpoint
ALTER TABLE policy_version ADD CONSTRAINT policy_version_text_check CHECK (
  text_status IN ('pending', 'ready', 'empty', 'failed') AND
  clause_count >= 0 AND
  (text_status = 'ready') = (clause_count > 0));
--> statement-breakpoint
-- A version's file stays as published; only Ask iPro's reading of it is recorded later.
GRANT UPDATE (text_status, clause_count, updated_at, updated_by) ON policy_version TO ipro_app;
--> statement-breakpoint
-- Clauses are written once per version and never changed.
GRANT SELECT, INSERT ON policy_clause TO ipro_app;
--> statement-breakpoint
ALTER TABLE policy_clause ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE policy_clause FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON policy_clause
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
