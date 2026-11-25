/**
 * Journey display words and colours (slice 10; decision #84), kept free of zod so screens can load
 * them through `@ipro/shared/words` without the schema library (decision #97).
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
