import { isRequiredTopic, topicOf } from '@ipro/shared';
import { describe, expect, it } from 'vitest';

describe('notification topics (X1; decision #86)', () => {
  it.each([
    ['approval_requested', 'approvals'],
    ['approval_reminder', 'approvals'],
    ['approval_escalated', 'approvals'],
    ['checklist_task', 'tasks'],
    ['checklist_task_due', 'tasks'],
    ['checklist_task_overdue', 'tasks'],
    ['probation_review_due', 'tasks'],
    ['internship_review_reminder', 'tasks'],
    ['probation_review_overdue', 'tasks'],
    ['probation_check_in_due', 'tasks'],
    ['probation_check_in_reminder', 'tasks'],
    ['letter_needed', 'tasks'],
    ['scheduled_change_failed', 'tasks'],
    ['prejoiner_invite_failed', 'tasks'],
    ['policy_acknowledgement', 'compliance'],
    ['missing_check_in', 'compliance'],
    ['hybrid_below_policy', 'compliance'],
    ['workflow_approved', 'requests'],
    ['workflow_returned', 'requests'],
    ['workflow_comment', 'requests'],
    ['offer_accepted', 'people'],
    ['resignation_submitted', 'people'],
    ['probation_confirm', 'people'],
    ['internship_convert', 'people'],
    ['pay_change', 'people'],
    ['checklist_complete', 'people'],
  ])('%s is a %s notification', (kind, topic) => {
    expect(topicOf(kind)).toBe(topic);
  });

  it('approvals and compliance items can’t be switched off; updates can', () => {
    expect(isRequiredTopic('approvals')).toBe(true);
    expect(isRequiredTopic('tasks')).toBe(true);
    expect(isRequiredTopic('compliance')).toBe(true);
    expect(isRequiredTopic('requests')).toBe(false);
    expect(isRequiredTopic('people')).toBe(false);
  });
});
