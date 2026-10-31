import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health.js';

describe('healthResponseSchema', () => {
  it('accepts a healthy response', () => {
    const parsed = healthResponseSchema.parse({
      status: 'ok',
      checks: { database: 'ok' },
      time: '2026-10-31T10:00:00.000Z',
    });
    expect(parsed.status).toBe('ok');
  });

  it('rejects an unknown status', () => {
    const result = healthResponseSchema.safeParse({
      status: 'fine',
      checks: { database: 'ok' },
      time: '2026-10-31T10:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});
