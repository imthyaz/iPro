import { z } from 'zod';
import { isoDateSchema } from './identity.js';

/**
 * Holiday calendars (slice 6a; decisions #48, #66): the company's (per location) and customers'
 * (for teams working a customer's week). Optional holidays are listed but count as working days
 * unless the person takes one as leave (slice 7).
 */
export const holidayCalendarKindSchema = z.enum(['company', 'customer']);

export const holidayCalendarInputSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(100),
  kind: holidayCalendarKindSchema,
});
export type HolidayCalendarInput = z.infer<typeof holidayCalendarInputSchema>;

export const holidayInputSchema = z.object({
  date: isoDateSchema,
  name: z.string().trim().min(1).max(100),
  optional: z.boolean(),
});
export type HolidayInput = z.infer<typeof holidayInputSchema>;

export interface HolidayView {
  id: string;
  date: string;
  name: string;
  optional: boolean;
}

export interface HolidayCalendarView {
  id: string;
  code: string;
  name: string;
  kind: z.infer<typeof holidayCalendarKindSchema>;
  /** Holidays in the requested year (or all, newest first). */
  holidays: HolidayView[];
  /** Locations that follow this calendar today (set from a date in organisation setup). */
  locations: { id: string; name: string }[];
}
