import { z } from 'zod';
import { addDays } from '../common/effective-dating.js';

/**
 * HR policy settings with the spec's proposed defaults (business rules table). A `tenant_setting` row
 * overrides a default; the values are confirmed in the policy workshop (docs/open-questions.md).
 */
export const settingSchemas = {
  employee_code: z.object({ prefix: z.string().min(1), width: z.number().int().min(1).max(10) }),
  buckets: z.array(z.string().min(1)).min(1),
  /** Months of probation by engagement type; a missing type has no probation configured. */
  probation_months: z.record(z.string(), z.number().int().min(0)),
  /** Working days (of the approver) before an approval escalates, and before a reminder. */
  approval_escalation_days: z.number().int().min(1).max(30),
  approval_reminder_days: z.number().int().min(1).max(30),
  /** Days an offer stays open for signature before it counts as declined (decision #54). */
  offer_expiry_days: z.number().int().min(1).max(90),
  notice_days: z.object({
    on_probation: z.number().int().min(0),
    confirmed: z.number().int().min(0),
    manager_plus: z.number().int().min(0),
  }),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingSchemas)[K]>;

export const settingDefaults: { [K in SettingKey]: SettingValue<K> } = {
  employee_code: { prefix: 'IDS-', width: 4 },
  buckets: ['billable', 'bench', 'management', 'administration', 'pre_sales', 'trainee'],
  probation_months: { permanent: 6, retainer: 0 },
  notice_days: { on_probation: 30, confirmed: 60, manager_plus: 90 },
  approval_escalation_days: 3,
  approval_reminder_days: 2,
  offer_expiry_days: 7,
};

export function formatEmployeeCode(value: number, format: SettingValue<'employee_code'>): string {
  return `${format.prefix}${String(value).padStart(format.width, '0')}`;
}

/** Last day of probation: N months after joining, less a day. Null when the type has no probation. */
export function probationEndDate(
  joiningDate: string,
  engagementType: string,
  months: SettingValue<'probation_months'>,
): string | null {
  const length = months[engagementType];
  if (!length) return null;
  const date = new Date(`${joiningDate}T00:00:00Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + length);
  // Clamp to the month's last day (31 Aug + 6 months = 28/29 Feb, not 3 Mar).
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return addDays(date.toISOString().slice(0, 10), -1);
}

/** Notice period: Manager+ band first, then probation vs confirmed. */
export function noticePeriodDays(
  onProbation: boolean,
  designationBand: string,
  notice: SettingValue<'notice_days'>,
): number {
  if (designationBand === 'manager_plus') return notice.manager_plus;
  return onProbation ? notice.on_probation : notice.confirmed;
}
