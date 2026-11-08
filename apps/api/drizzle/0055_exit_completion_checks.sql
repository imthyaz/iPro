ALTER TABLE exit_case ADD CONSTRAINT exit_case_completion_check CHECK (
  (access_method IS NULL OR access_method IN ('entra', 'it_task')) AND
  ((access_disabled_at IS NULL) = (access_method IS NULL)) AND
  (interview_recorded_at IS NULL OR interview_declined IS NOT NULL) AND
  (interview_declined IS NOT TRUE OR interview_answers IS NULL) AND
  (status <> 'exited' OR (exited_at IS NOT NULL AND interview_recorded_at IS NOT NULL
    AND clearance_done_at IS NOT NULL)));
