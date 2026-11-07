import { describe, expect, it } from 'vitest';
import { checkLastDay, noticeLastDay, onProbation } from './exit-rules.js';

describe('notice and the last working day (spec workflow 7; decision #80)', () => {
  it('ends the notice the stated number of days after the resignation', () => {
    expect(noticeLastDay('2026-11-09', 60)).toBe('2027-01-08');
    expect(noticeLastDay('2026-11-09', 30)).toBe('2026-12-09');
  });

  it('is on probation until confirmed', () => {
    expect(onProbation({ probationEndDate: '2026-12-31', confirmationDate: null })).toBe(true);
    expect(onProbation({ probationEndDate: '2026-06-30', confirmationDate: '2026-06-30' })).toBe(
      false,
    );
    expect(onProbation({ probationEndDate: null, confirmationDate: null })).toBe(false);
  });

  it('allows a last day up to the end of the notice; earlier needs a buyout or waiver', () => {
    expect(checkLastDay('2026-11-09', '2027-01-08', '2027-01-08')).toEqual({ earlyBy: 0 });
    expect(checkLastDay('2026-11-09', '2027-01-08', '2026-12-09')).toEqual({ earlyBy: 30 });
    expect(checkLastDay('2026-11-09', '2027-01-08', '2027-01-09')).toEqual({
      problem: 'The last working day can be up to 8 Jan 2027, the end of the notice period',
    });
    expect(checkLastDay('2026-11-09', '2027-01-08', '2026-11-08')).toEqual({
      problem: 'The last working day can’t be before the resignation',
    });
  });
});
