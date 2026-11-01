ALTER TABLE letter_template ADD CONSTRAINT letter_template_type_check
  CHECK (type IN ('offer', 'loi', 'confirmation', 'extension', 'transfer', 'relieving', 'experience',
    'termination', 'other'));
--> statement-breakpoint
ALTER TABLE letter_template ADD CONSTRAINT letter_template_approver_check
  CHECK (approver_role IS NULL OR approver_role IN ('hr', 'hr_head'));
--> statement-breakpoint
ALTER TABLE letter_template ADD CONSTRAINT letter_template_signature_check
  CHECK (signature IN ('none', 'employee'));
--> statement-breakpoint
ALTER TABLE letter ADD CONSTRAINT letter_status_check
  CHECK (status IN ('pending_approval', 'ready', 'sent', 'signed', 'declined', 'returned', 'cancelled'));
--> statement-breakpoint
-- A signed letter always points at its signed copy.
ALTER TABLE letter ADD CONSTRAINT letter_signed_check
  CHECK (status <> 'signed' OR (signed_document_id IS NOT NULL AND signed_at IS NOT NULL));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON letter_template, letter TO ipro_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['letter_template', 'letter']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
