ALTER TABLE comp_off_request ADD CONSTRAINT comp_off_request_values_check CHECK (
  status IN ('applied', 'returned', 'approved', 'withdrawn') AND
  amount IN (50, 100) AND
  (status <> 'approved' OR granted_on IS NOT NULL) AND
  (valid_until IS NULL OR valid_until >= granted_on) AND
  (expired_amount IS NULL OR (expired_amount >= 0 AND expired_amount <= amount)));
--> statement-breakpoint
-- Decision #76: comp-off runs out by its expiry date, not at year end, so what is left carries into
-- the new year. Only the type created from the earlier defaults is updated.
UPDATE leave_type SET carry_forward_cap = NULL
  WHERE code = 'CO' AND kind = 'granted' AND carry_forward_cap = 0;
--> statement-breakpoint
-- Requests are kept with their outcome, never deleted.
GRANT SELECT, INSERT, UPDATE ON comp_off_request TO ipro_app;
--> statement-breakpoint
ALTER TABLE comp_off_request ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE comp_off_request FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON comp_off_request USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
