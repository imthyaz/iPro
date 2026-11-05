ALTER TABLE leave_type ADD CONSTRAINT leave_type_credit_on_check CHECK (
  credit_on IN ('month_start', 'month_end'));
--> statement-breakpoint
-- Decision #73: types created from the earlier defaults take the owner's confirmed values. Types an
-- admin has already changed from those defaults are left alone.
UPDATE leave_type SET credit_on = 'month_start'
  WHERE code IN ('CL', 'SL') AND credit_on = 'month_end' AND kind = 'accrued';
--> statement-breakpoint
UPDATE leave_type SET max_balance = 3000
  WHERE code = 'EL' AND max_balance IS NULL AND kind = 'accrued';
