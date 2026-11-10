import { describe, expect, it } from 'vitest';
import { anniversaryYears, channelsFor, nextAttempt } from './delivery-rules.js';

describe('delivery channels (decision #87)', () => {
  it('Teams by default; email for pre-joiners and for those who ask for a copy', () => {
    expect(channelsFor({ preJoiner: false, emailCopy: false })).toEqual(['teams']);
    expect(channelsFor({ preJoiner: false, emailCopy: true })).toEqual(['teams', 'email']);
    expect(channelsFor({ preJoiner: true, emailCopy: false })).toEqual(['email']);
    expect(channelsFor({ preJoiner: true, emailCopy: true })).toEqual(['email']);
  });

  it('retries after 1, 5, 30 and 120 minutes, then gives up', () => {
    const now = new Date('2026-11-09T04:00:00Z');
    expect(nextAttempt(1, now)?.toISOString()).toBe('2026-11-09T04:01:00.000Z');
    expect(nextAttempt(2, now)?.toISOString()).toBe('2026-11-09T04:05:00.000Z');
    expect(nextAttempt(4, now)?.toISOString()).toBe('2026-11-09T06:00:00.000Z');
    expect(nextAttempt(5, now)).toBeNull();
  });
});

describe('work anniversaries', () => {
  it('counts whole years on the day, not in the first year', () => {
    expect(anniversaryYears('2023-11-09', '2026-11-09')).toBe(3);
    expect(anniversaryYears('2026-11-09', '2026-11-09')).toBeNull();
    expect(anniversaryYears('2023-11-10', '2026-11-09')).toBeNull();
  });

  it('a 29 February joiner celebrates on 28 February in other years', () => {
    expect(anniversaryYears('2024-02-29', '2025-02-28')).toBe(1);
    expect(anniversaryYears('2024-02-29', '2028-02-28')).toBeNull();
    expect(anniversaryYears('2024-02-29', '2028-02-29')).toBe(4);
  });
});
