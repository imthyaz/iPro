import { z } from 'zod';

/**
 * A6 import (slice 13b; decision #94): a CSV checked first; nothing loads until it has no errors.
 * `commit: false` checks only (a dry run that rolls back); `commit: true` loads when the check passes.
 */
export const importFileSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
  commit: z.boolean(),
});
export type ImportFileInput = z.infer<typeof importFileSchema>;

export interface ImportResult {
  committed: boolean;
  rows: number;
  /** Rows that load (or would, on a check). */
  ready: number;
  errors: { line: number; message: string }[];
}
