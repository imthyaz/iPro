-- IT housekeeping checklists, e.g. removing a pre-joiner's Entra guest account (decision #58).
ALTER TABLE checklist_template DROP CONSTRAINT checklist_template_stage_check;
--> statement-breakpoint
ALTER TABLE checklist_template ADD CONSTRAINT checklist_template_stage_check
  CHECK (stage IN ('onboarding', 'exit', 'transfer', 'access'));
