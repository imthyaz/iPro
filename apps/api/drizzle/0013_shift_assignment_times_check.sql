-- A person's own day times override the shift's: both or neither.
ALTER TABLE shift_assignment ADD CONSTRAINT shift_assignment_times_check
  CHECK ((start_time IS NULL) = (end_time IS NULL));
