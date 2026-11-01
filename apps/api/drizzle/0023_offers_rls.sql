ALTER TABLE offer ADD CONSTRAINT offer_status_check CHECK (status IN
  ('draft', 'pending_approval', 'offered', 'accepted', 'joined', 'declined', 'withdrawn', 'no_show'));
--> statement-breakpoint
ALTER TABLE offer ADD CONSTRAINT offer_band_check_check CHECK (band_check IN
  ('within', 'above', 'no_band', 'not_comparable'));
--> statement-breakpoint
-- A closed offer says when and why.
ALTER TABLE offer ADD CONSTRAINT offer_closed_check CHECK (
  (status IN ('declined', 'withdrawn', 'no_show')) = (closed_at IS NOT NULL AND close_reason IS NOT NULL));
--> statement-breakpoint
ALTER TABLE engagement ADD CONSTRAINT engagement_contract_end_check
  CHECK (contract_end_date IS NULL OR contract_end_date >= joining_date);
--> statement-breakpoint
-- Offers are records of what was offered: they change state, never disappear.
GRANT SELECT, INSERT, UPDATE ON offer TO ipro_app;
--> statement-breakpoint
ALTER TABLE offer ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE offer FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON offer USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
