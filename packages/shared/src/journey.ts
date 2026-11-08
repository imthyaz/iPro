/**
 * Journey timelines (slice 10; screens E8, H2, M6, H11; decision #84). Timelines read only from the
 * journal; each event shows in one display category with the design's colour.
 */
export const timelineCategories = [
  'lifecycle',
  'career',
  'team',
  'pay',
  'leave',
  'records',
] as const;
export type TimelineCategory = (typeof timelineCategories)[number];

export const timelineCategoryWords: Record<TimelineCategory, string> = {
  lifecycle: 'Lifecycle',
  career: 'Designation',
  team: 'Team & role',
  pay: 'Pay',
  leave: 'Leave & attendance',
  records: 'Records',
};

/** The timeline design's palette (Employee Journey Timeline canvas). */
export const timelineCategoryColours: Record<TimelineCategory, string> = {
  lifecycle: '#2B3140',
  career: '#2F5BD3',
  team: '#7A4FD1',
  pay: '#C2620E',
  leave: '#0F7F69',
  records: '#B88400',
};

/** Shown unless turned on (decision #84: leave and attendance are off by default). */
export const timelineHiddenByDefault: readonly TimelineCategory[] = ['leave'];

export interface TimelineEvent {
  id: string;
  type: string;
  category: TimelineCategory;
  title: string;
  date: string;
  /** Still ahead (or planned and not yet happened). */
  upcoming: boolean;
  planned: boolean;
  /** Planned, its day has passed and it hasn't happened (e.g. a probation review still open). */
  overdue: boolean;
  /** Label/value facts for the detail panel, already safe for the viewer. */
  facts: [string, string][];
  /** Where it was recorded, for "View" in the detail panel (e.g. a request). */
  link: string | null;
}

export interface TimelineSegment {
  label: string;
  from: string;
  /** null: still in force. */
  to: string | null;
}

export interface CtcSegment {
  amountPaise: string;
  rateUnit: string;
  from: string;
  to: string | null;
}

export interface PersonTimelineView {
  today: string;
  person: {
    personId: string;
    name: string;
    employeeCode: string;
    designation: string | null;
    department: string | null;
    location: string | null;
    status: 'offered' | 'pre_joining' | 'active' | 'on_notice' | 'exited' | 'withdrawn';
    onProbation: boolean;
    joiningDate: string;
    lastWorkingDate: string | null;
  };
  events: TimelineEvent[];
  lanes: {
    designation: TimelineSegment[];
    team: TimelineSegment[];
    status: TimelineSegment[];
    /** Pay readers only (HR, HR head, CXO, the person; decision #84); one audit entry per view. */
    ctc: CtcSegment[] | null;
  };
  tiles: {
    tenure: { years: number; months: number; days: number };
    designations: number;
    designationChanges: number;
    teams: number;
    ctcGrowth: { fromPaise: string; toPaise: string; revisions: number } | null;
  };
}
