import { z } from 'zod';

/**
 * Attendance (slice 6b; decisions #67, #68). Punches come from web and phone check-ins and from
 * biometric devices; the attendance build turns them, with shifts, holidays and leave, into one
 * status per person per day.
 */
export const workModeSchema = z.enum(['office', 'wfh', 'client_site']);
export type WorkMode = z.infer<typeof workModeSchema>;

export const attendanceStatusSchema = z.enum([
  'present',
  'absent',
  'half_day',
  'leave',
  'holiday',
  'weekly_off',
  'wfh',
  'client_site',
]);
export type AttendanceStatus = z.infer<typeof attendanceStatusSchema>;

/** POST /api/attendance/check-in and /check-out: one tap, with the phone's location if it gives one. */
export const checkInSchema = z.object({
  mode: workModeSchema,
  device: z.enum(['web', 'mobile']),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  /** Metres, as the device reports it. */
  accuracy: z.number().min(0).max(100_000).optional(),
});
export type CheckInInput = z.infer<typeof checkInSchema>;

/**
 * POST /api/biometric/punches (decision #67): what an on-site agent or a vendor webhook pushes. The
 * device is identified by its key; people by employee code, as enrolled on the device.
 */
export const biometricPushSchema = z.object({
  punches: z
    .array(
      z.object({
        employeeCode: z.string().trim().min(1).max(40),
        /** ISO 8601 with an offset, e.g. 2026-11-09T09:28:00+05:30. */
        at: z.iso.datetime({ offset: true }),
        direction: z.enum(['in', 'out']).optional(),
        /** The device's own id for the punch, so a resend isn't counted twice. */
        externalId: z.string().trim().min(1).max(100),
      }),
    )
    .min(1)
    .max(500),
});
export type BiometricPush = z.infer<typeof biometricPushSchema>;

export const biometricDeviceInputSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(100),
  locationId: z.uuid(),
});

export interface BiometricDeviceView {
  id: string;
  code: string;
  name: string;
  location: string | null;
  active: boolean;
  lastSeenAt: string | null;
}

export interface PunchView {
  id: string;
  at: string;
  direction: 'in' | 'out' | null;
  source: 'web' | 'mobile' | 'biometric';
  mode: WorkMode | null;
  /** Null when there was nothing to compare with (no site coordinates, or WFH). */
  outsideGeofence: boolean | null;
  distanceMetres: number | null;
}

/** GET /api/attendance/today (E1, E2). */
export interface TodayView {
  date: string;
  working: boolean;
  holiday: string | null;
  shift: { code: string; startTime: string; endTime: string } | null;
  checkedIn: boolean;
  punches: PunchView[];
  /** The mode last used, offered first next time. */
  lastMode: WorkMode | null;
}

/** One day of a person's attendance (E3 calendar, H9). */
export interface AttendanceDayView {
  date: string;
  status: AttendanceStatus | null;
  /** Calendar facts, also for days not built yet (future, or today before any punch). */
  working: boolean;
  holiday: string | null;
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number | null;
  mode: WorkMode | null;
  flags: AttendanceFlag[];
  regularised: boolean;
}

export const attendanceFlagSchema = z.enum([
  'late',
  'outside_geofence',
  'no_location',
  'missing_check_out',
  'worked_on_day_off',
]);
export type AttendanceFlag = z.infer<typeof attendanceFlagSchema>;

export const attendanceMonthQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});
