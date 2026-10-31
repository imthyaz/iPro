import { z } from 'zod';
import { isoDateSchema } from './identity.js';

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time as HH:MM');

/** ISO weekdays: 1 = Monday … 7 = Sunday. */
export const weekdayNames = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const shiftFields = {
  code: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(100),
  startTime: timeSchema,
  endTime: timeSchema,
  breakMinutes: z.number().int().min(0).max(480).optional(),
  graceMinutes: z.number().int().min(0).max(240).optional(),
  halfDayMinutes: z.number().int().min(0).max(1440).optional(),
  /** Days off, e.g. [6, 7] for Mon–Fri, [5, 6] for Sun–Thu (Middle East customers). */
  weeklyOffs: z
    .array(z.number().int().min(1).max(7))
    .max(6)
    .refine((days) => new Set(days).size === days.length, 'no repeated days'),
  isDefault: z.boolean().optional(),
};

/** POST /api/shifts. No defaults here: the database applies them (decision #33). */
export const shiftInputSchema = z.object(shiftFields);
export const shiftUpdateSchema = z.object(shiftFields).partial();
export type ShiftInput = z.infer<typeof shiftInputSchema>;

export interface ShiftView {
  id: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  graceMinutes: number;
  halfDayMinutes: number;
  weeklyOffs: number[];
  isDefault: boolean;
}

/**
 * POST /api/shifts/allocations: put one or many people (e.g. a project team) on a shift from a date,
 * optionally until a date, after which their previous shift resumes.
 */
export const allocateShiftSchema = z
  .object({
    personIds: z.array(z.uuid()).min(1).max(500),
    shiftId: z.uuid(),
    effectiveFrom: isoDateSchema,
    effectiveTo: isoDateSchema.optional(),
    /** When they start and end the day, if different from the shift (e.g. 11:00–20:00). Both or neither. */
    startTime: timeSchema.optional(),
    endTime: timeSchema.optional(),
    reason: z.string().trim().min(1).max(200),
  })
  .refine((a) => !a.effectiveTo || a.effectiveTo >= a.effectiveFrom, {
    path: ['effectiveTo'],
    message: 'ends before it starts',
  })
  .refine((a) => Boolean(a.startTime) === Boolean(a.endTime), {
    path: ['endTime'],
    message: 'give both a start and an end time, or neither',
  });
export type AllocateShiftInput = z.infer<typeof allocateShiftSchema>;

/** A person's shift history (GET /api/people/:id/shifts). */
export interface ShiftAllocationView {
  id: string;
  shiftId: string;
  shiftName: string;
  weeklyOffs: number[];
  effectiveFrom: string;
  effectiveTo: string | null;
  /** The day this person works: their own times if set, otherwise the shift’s. */
  startTime: string;
  endTime: string;
  /** True when the times are this person’s own rather than the shift’s. */
  customTimes: boolean;
  reason: string;
}

/** GET /api/people/:id/working-days?from=&to=: which dates are working days and on which shift. */
export interface WorkingDayView {
  date: string;
  working: boolean;
  shiftCode: string;
  /** Start and end of the working day (person’s own times if allocated, else the shift’s). */
  startTime: string;
  endTime: string;
}
