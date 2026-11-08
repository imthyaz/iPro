import type { JourneyEvent } from './journey.service.js';

/**
 * Planned journal events (decision #84): dated futures the workflows create, written ahead so
 * timelines can show what's coming while still reading only from the journal.
 */

/** The planned end of a probation: on hire (source: the engagement) or an extension (the review). */
export function probationEnd(input: {
  engagementId: string;
  personId: string;
  probationEndDate: string;
  sourceTable?: string;
  sourceId?: string;
}): JourneyEvent {
  return {
    engagementId: input.engagementId,
    personId: input.personId,
    eventType: 'probation_end',
    category: 'lifecycle',
    occurredOn: input.probationEndDate,
    isPlanned: true,
    title: 'Probation ends',
    detail: { probationEndDate: input.probationEndDate },
    sensitivity: 'public',
    sourceTable: input.sourceTable ?? 'engagement',
    sourceId: input.sourceId ?? input.engagementId,
  };
}

/** The last working day agreed for an exit (source: the exit case); no reason on it. */
export function lastWorkingDay(input: {
  engagementId: string;
  personId: string;
  lastWorkingDate: string;
  exitCaseId: string;
}): JourneyEvent {
  return {
    engagementId: input.engagementId,
    personId: input.personId,
    eventType: 'last_working_day',
    category: 'exit',
    occurredOn: input.lastWorkingDate,
    isPlanned: true,
    title: 'Last working day',
    detail: { lastWorkingDate: input.lastWorkingDate },
    sensitivity: 'manager',
    sourceTable: 'exit_case',
    sourceId: input.exitCaseId,
  };
}
