import { z } from 'zod';

/** Response of GET /api/health (readiness: the API can reach its database). */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({
    database: z.enum(['ok', 'down']),
  }),
  time: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
