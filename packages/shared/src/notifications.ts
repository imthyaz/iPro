import { z } from 'zod';

/**
 * Notification topics (X1, slice 11). Every notification kind belongs to one topic; the recipient
 * can switch a topic off unless it carries approvals or compliance items (spec: Notifications).
 */
export const notificationTopics = [
  {
    key: 'approvals',
    label: 'Approvals waiting for you',
    description: 'New approvals, reminders and escalations.',
    required: true,
  },
  {
    key: 'tasks',
    label: 'Tasks, reviews and check-ins',
    description: 'Checklist tasks, probation and internship reviews, and things HR must fix.',
    required: true,
  },
  {
    key: 'compliance',
    label: 'Policies, attendance and hybrid',
    description: 'Policies to accept, a missing check-in, and a week below the hybrid policy.',
    required: true,
  },
  {
    key: 'requests',
    label: 'Your requests',
    description: 'When something you asked for is approved, returned or commented on.',
    required: false,
  },
  {
    key: 'people',
    label: 'People updates',
    description: 'Offers, joinings, exits, changes to records and milestones.',
    required: false,
  },
] as const;

export type NotificationTopic = (typeof notificationTopics)[number]['key'];
export const switchableTopics = notificationTopics
  .filter((t) => !t.required)
  .map((t) => t.key) as NotificationTopic[];

const exact: Record<string, NotificationTopic> = {
  approval_requested: 'approvals',
  approval_reminder: 'approvals',
  approval_escalated: 'approvals',
  letter_needed: 'tasks',
  scheduled_change_failed: 'tasks',
  prejoiner_invite_failed: 'tasks',
  policy_acknowledgement: 'compliance',
  missing_check_in: 'compliance',
  hybrid_below_policy: 'compliance',
  workflow_approved: 'requests',
  workflow_returned: 'requests',
  workflow_comment: 'requests',
};

/** The topic a notification kind belongs to; anything not listed is a people update. */
export function topicOf(kind: string): NotificationTopic {
  if (exact[kind]) return exact[kind];
  if (/^checklist_task/.test(kind)) return 'tasks';
  if (/_review_(due|reminder|overdue)$/.test(kind)) return 'tasks';
  if (/^probation_check_in_/.test(kind)) return 'tasks';
  return 'people';
}

export const isRequiredTopic = (topic: NotificationTopic) =>
  notificationTopics.find((t) => t.key === topic)!.required;

export interface NotificationView {
  id: string;
  kind: string;
  topic: NotificationTopic;
  title: string;
  link: string | null;
  createdAt: string;
  read: boolean;
}

export interface NotificationPreferencesView {
  topics: {
    key: NotificationTopic;
    label: string;
    description: string;
    required: boolean;
    on: boolean;
  }[];
  /** Also send each notification by email (Teams is the default channel). */
  emailCopy: boolean;
}

/** PUT /api/notification-preferences: the switchable topics to turn off, and the email copy. */
export const notificationPreferencesSchema = z.object({
  off: z.array(z.enum(switchableTopics as [NotificationTopic, ...NotificationTopic[]])).max(10),
  emailCopy: z.boolean(),
});
export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;

/** POST /api/approvals/bulk-approve: routine approvals decided together (decision #86). */
export const bulkApproveSchema = z.object({
  approvalIds: z.array(z.uuid()).min(1).max(50),
});

export interface BulkApproveResult {
  results: { approvalId: string; ok: boolean; message: string | null }[];
}
