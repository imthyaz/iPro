import { describe, expect, it } from 'vitest';
import { briefLine } from './brief.service.js';

const none = {
  approvals: 0,
  approvalsOverdue: 0,
  tasks: 0,
  tasksOverdue: 0,
  reviews: 0,
  reviewsOverdue: 0,
  probationsEnding: null,
};

describe('the daily brief line (decision #92)', () => {
  it('says nothing when nothing is waiting', () => {
    expect(briefLine(none)).toBeNull();
    expect(briefLine({ ...none, probationsEnding: 0 })).toBeNull();
  });

  it('names what is waiting and due, with what is overdue', () => {
    expect(
      briefLine({
        ...none,
        approvals: 3,
        approvalsOverdue: 1,
        tasks: 2,
        reviews: 1,
        probationsEnding: 4,
      }),
    ).toBe(
      '3 approvals waiting (1 overdue) · 2 tasks due this week · 1 review or check-in due · 4 probations end in 30 days',
    );
    expect(briefLine({ ...none, approvals: 1 })).toBe('1 approval waiting');
  });
});
