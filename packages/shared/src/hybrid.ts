import { z } from 'zod';
import { workModeSchema, type WorkMode } from './attendance.js';
import { appliesToSchema } from './checklists.js';

/**
 * The hybrid planner (slice 8; spec workflow 6; decision #78). A work policy says how many days a
 * week are in the office (or at a client site), which modes are allowed and whether the team's
 * anchor day counts. Policies are configuration rows, matched to people like leave types.
 */
export const workPolicyInputSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(12)
    .regex(/^[A-Z0-9_]+$/),
  name: z.string().trim().min(1).max(80),
  requiredMode: z.enum(['office', 'client_site']),
  requiredDays: z.number().int().min(0).max(7),
  anchorDayRequired: z.boolean(),
  allowedModes: z.array(workModeSchema).min(1),
  appliesTo: appliesToSchema,
  /** Matches people whose location is of these types (e.g. client-deployed: client_site). */
  locationTypes: z.array(z.enum(['office', 'client_site', 'remote'])),
  /** Lower first: the first matching active policy applies. */
  priority: z.number().int().min(0).max(1000),
  active: z.boolean(),
});
export type WorkPolicyInput = z.infer<typeof workPolicyInputSchema>;

export interface WorkPolicyView extends WorkPolicyInput {
  id: string;
}

/** A bookable seat at an office (spec data model: Seat). */
export const seatInputSchema = z.object({
  locationId: z.uuid(),
  label: z.string().trim().min(1).max(20),
  zone: z.string().trim().max(40).optional(),
});
export type SeatInput = z.infer<typeof seatInputSchema>;

export interface SeatView {
  id: string;
  locationId: string;
  label: string;
  zone: string | null;
  active: boolean;
}

export const bookingStatusSchema = z.enum(['confirmed', 'pending', 'rejected']);
export type BookingStatus = z.infer<typeof bookingStatusSchema>;

/** PUT /api/hybrid/week: the whole week as planned; a day with no mode is cleared. */
export const weekPlanSchema = z.object({
  weekStart: z.iso.date(),
  days: z
    .array(
      z.object({
        date: z.iso.date(),
        mode: workModeSchema.nullable(),
        locationId: z.uuid().optional(),
        seatId: z.uuid().optional(),
      }),
    )
    .max(7),
  /** Why the week is below policy (needed then; the manager sees it). */
  note: z.string().trim().max(500).optional(),
});
export type WeekPlanInput = z.infer<typeof weekPlanSchema>;

export const weekQuerySchema = z.object({ start: z.iso.date() });

export interface WeekDayView {
  date: string;
  working: boolean;
  holiday: string | null;
  /** Leave on the day, approved or asked for. */
  leave: 'full' | 'first' | 'second' | null;
  booking: {
    mode: WorkMode;
    locationId: string | null;
    locationName: string | null;
    seatId: string | null;
    seatLabel: string | null;
    status: BookingStatus;
  } | null;
  /** False after 18:00 the day before (decision #78). */
  editable: boolean;
  cutoffAt: string;
}

export interface WeekPlanView {
  weekStart: string;
  policy: {
    id: string;
    name: string;
    requiredMode: 'office' | 'client_site';
    requiredDays: number;
    anchorDayRequired: boolean;
    allowedModes: WorkMode[];
  } | null;
  /** The team's anchor day (ISO weekday, 1 = Monday), set by the manager. */
  anchorWeekday: number | null;
  days: WeekDayView[];
  fit: { target: number; booked: number; fits: boolean; reasons: string[] };
  exception: {
    status: 'pending' | 'approved' | 'returned';
    note: string | null;
    requestId: string | null;
  } | null;
  /** Where office and client-site days can be booked, with seat counts. */
  places: { id: string; name: string; type: 'office' | 'client_site'; seatCount: number | null }[];
  /** The person's own location, picked by default for office days. */
  homeLocationId: string | null;
}

/** GET /api/hybrid/seats?locationId&date: the seats, and whether each is taken that day. */
export const seatQuerySchema = z.object({ locationId: z.uuid(), date: z.iso.date() });
export interface SeatAvailability extends SeatView {
  taken: boolean;
}

/** PUT /api/hybrid/team-anchor: the manager's team anchor day, or none. */
export const teamAnchorSchema = z.object({ weekday: z.number().int().min(1).max(7).nullable() });
