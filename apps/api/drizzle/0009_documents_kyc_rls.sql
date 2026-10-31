ALTER TABLE document ADD CONSTRAINT document_type_check
  CHECK (type IN ('kyc_scan', 'letter', 'certificate', 'photo', 'other'));
--> statement-breakpoint
ALTER TABLE document ADD CONSTRAINT document_previous_version_fk
  FOREIGN KEY (previous_version_id) REFERENCES document (id);
--> statement-breakpoint
ALTER TABLE kyc_record ADD CONSTRAINT kyc_record_type_check
  CHECK (type IN ('pan', 'aadhaar', 'passport', 'bank', 'uan', 'esic'));
--> statement-breakpoint
-- Nothing is hard-deleted by the app.
GRANT SELECT, INSERT, UPDATE ON document, kyc_record TO ipro_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document', 'kyc_record']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END $$;
