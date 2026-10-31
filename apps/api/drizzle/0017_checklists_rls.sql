ALTER TABLE checklist_template ADD CONSTRAINT checklist_template_stage_check
  CHECK (stage IN ('onboarding', 'exit', 'transfer'));
--> statement-breakpoint
ALTER TABLE checklist_run ADD CONSTRAINT checklist_run_status_check
  CHECK (status IN ('open', 'complete', 'cancelled'));
--> statement-breakpoint
ALTER TABLE checklist_task ADD CONSTRAINT checklist_task_status_check
  CHECK (status IN ('open', 'done', 'waived'));
--> statement-breakpoint
-- The person's own tasks need no stored assignee (they may not have a sign-in yet); others do.
ALTER TABLE checklist_task ADD CONSTRAINT checklist_task_assignee_check
  CHECK (owner_kind = 'employee' OR assignee_user_id IS NOT NULL OR assignee_role IS NOT NULL);
--> statement-breakpoint
-- Waiving is HR-only and always says why; a done task that needs a document has one.
ALTER TABLE checklist_task ADD CONSTRAINT checklist_task_waive_reason_check
  CHECK (status <> 'waived' OR length(trim(waive_reason)) > 0);
--> statement-breakpoint
ALTER TABLE checklist_task ADD CONSTRAINT checklist_task_evidence_check
  CHECK (status <> 'done' OR NOT requires_document OR evidence_document_id IS NOT NULL);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON checklist_template, checklist_run, checklist_task TO ipro_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['checklist_template', 'checklist_run', 'checklist_task']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
