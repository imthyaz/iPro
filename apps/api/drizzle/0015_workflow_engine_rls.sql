ALTER TABLE workflow_instance ADD CONSTRAINT workflow_instance_status_check
  CHECK (status IN ('pending', 'returned', 'approved', 'withdrawn'));
--> statement-breakpoint
ALTER TABLE approval ADD CONSTRAINT approval_decision_check
  CHECK (decision IS NULL OR decision IN ('approved', 'rejected'));
--> statement-breakpoint
-- Assigned to a person or to a role, and a rejection always carries a comment.
ALTER TABLE approval ADD CONSTRAINT approval_assignee_check
  CHECK (assigned_user_id IS NOT NULL OR assigned_role IS NOT NULL);
--> statement-breakpoint
ALTER TABLE approval ADD CONSTRAINT approval_reject_comment_check
  CHECK (decision IS DISTINCT FROM 'rejected' OR length(trim(comment)) > 0);
--> statement-breakpoint
-- At most one open step per item.
CREATE UNIQUE INDEX approval_one_open_step_key ON approval (instance_id)
  WHERE decision IS NULL AND closed_at IS NULL;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON workflow_definition, workflow_instance, approval, notification
  TO ipro_app;
--> statement-breakpoint
-- Comments are a record of the conversation: add only.
GRANT SELECT, INSERT ON workflow_comment TO ipro_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_definition', 'workflow_instance', 'approval', 'workflow_comment',
    'notification']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
