import type { AppliesTo } from '@ipro/shared';
import { addDays } from '../common/effective-dating.js';

export interface EngagementFacts {
  legalEntityId: string;
  engagementType: string;
  departmentId: string | null;
  locationId: string | null;
}

/** Whether a template applies to an engagement. An empty or missing list means "any". */
export function appliesToMatches(appliesTo: AppliesTo, facts: EngagementFacts): boolean {
  const ok = (list: readonly string[] | undefined, value: string | null) =>
    !list || list.length === 0 || (value !== null && list.includes(value));
  return (
    ok(appliesTo.legalEntityIds, facts.legalEntityId) &&
    ok(appliesTo.engagementTypes, facts.engagementType) &&
    ok(appliesTo.departmentIds, facts.departmentId) &&
    ok(appliesTo.locationIds, facts.locationId)
  );
}

/** A task's due date: the anchor date (e.g. joining) plus the template's offset in calendar days. */
export const taskDueOn = (anchorDate: string, dueOffsetDays: number) =>
  addDays(anchorDate, dueOffsetDays);

/** A run is complete when every mandatory task is done or waived (spec: workflow 2). */
export function runIsComplete(tasks: readonly { mandatory: boolean; status: string }[]): boolean {
  return tasks.every((task) => !task.mandatory || task.status !== 'open');
}
