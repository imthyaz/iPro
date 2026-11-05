import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import type {
  AttendanceDayView,
  AttendanceFlag,
  AttendanceStatus,
  BiometricDeviceView,
  BiometricPush,
  CheckInInput,
  PunchView,
  TodayView,
  WorkMode,
} from '@ipro/shared';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { locationVersions } from '../org/org.schema.js';
import { inForce } from '../people/people.queries.js';
import { assignments, engagements } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { SettingsService } from '../people/settings.service.js';
import { attendanceDays, biometricDevices, punches } from './attendance.schema.js';
import { leaveRequestDays, leaveRequests, leaveTypes } from '../leave/leave.schema.js';
import { ShiftsService } from './shifts.service.js';
import { notify, userOfPerson } from '../workflow/lookups.js';
import { notifications } from '../workflow/workflow.schema.js';

type PunchRow = typeof punches.$inferSelect;
type EngagementRow = typeof engagements.$inferSelect;

const WORKING_STATUSES = ['active', 'on_notice'] as const;
const EARTH_METRES = 6_371_000;

/** Great-circle distance in metres between two points. */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_METRES * Math.asin(Math.sqrt(h)));
}

/** Minutes after midnight in India for an instant. */
export function minutesInIndia(at: Date): number {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(at)
    .split(':')
    .map(Number) as [number, number];
  return h * 60 + m;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/**
 * The status, times and flags of one day from its punches and the calendar (pure, so it can be
 * tested on its own). Null means nothing to record yet: a working day today or later with no punch.
 */
export function buildDay(input: {
  day: string;
  today: string;
  working: boolean;
  holiday: { name: string; optional: boolean } | null;
  shift: {
    startTime: string;
    graceMinutes: number;
    breakMinutes: number;
    halfDayMinutes: number;
  } | null;
  punches: Pick<PunchRow, 'at' | 'source' | 'mode' | 'latitude' | 'outsideGeofence'>[];
  /** Approved leave on the day (slice 7): the whole day, or the first or second half. */
  leave?: 'full' | 'first' | 'second' | null;
}): {
  status: AttendanceStatus;
  firstIn: Date | null;
  lastOut: Date | null;
  workedMinutes: number | null;
  mode: WorkMode | null;
  flags: AttendanceFlag[];
} | null {
  const sorted = [...input.punches].sort((a, b) => a.at.getTime() - b.at.getTime());
  const dayOff = !input.working;
  const leave = input.leave ?? null;
  // A day of approved leave is leave; half a day of leave with work in the other half is a half day,
  // and with nothing in the other half (once the day is over) absent for that half.
  if (leave === 'full') return blank('leave');
  if (sorted.length === 0) {
    if (leave) return input.day < input.today ? blank('absent') : null;
    if (input.holiday && !input.holiday.optional) return blank('holiday');
    if (dayOff) return blank('weekly_off');
    return input.day < input.today ? blank('absent') : null;
  }
  const firstIn = sorted[0]!.at;
  const lastOut = sorted.length > 1 ? sorted.at(-1)!.at : null;
  const span = lastOut ? Math.round((lastOut.getTime() - firstIn.getTime()) / 60_000) : null;
  const breakMinutes = input.shift?.breakMinutes ?? 0;
  const workedMinutes =
    span === null ? null : Math.max(0, span > breakMinutes * 2 ? span - breakMinutes : span);
  const mode = [...sorted].reverse().find((p) => p.mode)?.mode ?? 'office';
  const flags = new Set<AttendanceFlag>();
  if (
    input.shift &&
    leave !== 'first' &&
    minutesInIndia(firstIn) > toMinutes(input.shift.startTime) + input.shift.graceMinutes
  ) {
    flags.add('late');
  }
  if (sorted.some((p) => p.outsideGeofence)) flags.add('outside_geofence');
  if (sorted.some((p) => p.source !== 'biometric' && p.mode !== 'wfh' && p.latitude === null)) {
    flags.add('no_location');
  }
  if (!lastOut && input.day < input.today) flags.add('missing_check_out');
  if (dayOff) flags.add('worked_on_day_off');
  let status: AttendanceStatus =
    mode === 'wfh' ? 'wfh' : mode === 'client_site' ? 'client_site' : 'present';
  if (workedMinutes !== null && input.shift && workedMinutes < input.shift.halfDayMinutes)
    status = 'half_day';
  if (leave) status = 'half_day';
  return { status, firstIn, lastOut, workedMinutes, mode, flags: [...flags] };

  function blank(status: AttendanceStatus) {
    return { status, firstIn: null, lastOut: null, workedMinutes: null, mode: null, flags: [] };
  }
}

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

/**
 * Attendance (spec workflow 5 inputs; decisions #67, #68): check-ins from web and phone with the
 * geofence check, biometric pushes, and the build that turns punches into attendance days.
 */
@Injectable()
export class AttendanceService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ShiftsService) private readonly shifts: ShiftsService,
  ) {}

  // ---- Check-in (E2) ----

  /** One tap: records the punch, its mode and location, how far from the site it was, and the day. */
  async punch(direction: 'in' | 'out', input: CheckInInput, now = new Date()): Promise<TodayView> {
    const actor = requireContext().actor!;
    if (!actor.personId) throw new ForbiddenException();
    const summary = await this.people.summary(actor.personId);
    await this.authz.assert(actor, 'create', {
      area: 'attendance',
      subjectPersonId: summary.personId,
      legalEntityId: summary.legalEntityId,
    });
    const day = businessDate(now);
    await this.db.tx(async (tx) => {
      const engagement = await this.working(tx, summary.engagementId, day);
      const site = input.mode === 'wfh' ? null : await this.siteOf(tx, engagement.id, day);
      const hasFix = input.latitude !== undefined && input.longitude !== undefined;
      let distance: number | null = null;
      let outside: boolean | null = null;
      if (site && hasFix) {
        distance = distanceMetres(
          { lat: input.latitude!, lng: input.longitude! },
          { lat: site.latitude, lng: site.longitude },
        );
        // A poor fix is given the benefit of its own accuracy, up to 100 m.
        outside = distance - Math.min(input.accuracy ?? 0, 100) > site.radius;
      }
      await tx.insert(punches).values({
        tenantId: requireContext().tenantId,
        engagementId: engagement.id,
        personId: summary.personId,
        at: now,
        day,
        direction,
        source: input.device,
        mode: input.mode,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        accuracyMetres: input.accuracy ?? null,
        siteLocationId: site?.locationId ?? null,
        distanceMetres: distance,
        outsideGeofence: outside,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
      await this.rebuild(tx, engagement, day, now);
    });
    return this.today(now);
  }

  async today(now = new Date()): Promise<TodayView> {
    const actor = requireContext().actor!;
    if (!actor.personId) throw new ForbiddenException();
    const summary = await this.people.summary(actor.personId);
    const day = businessDate(now);
    return this.db.tx(async (tx) => {
      const calendar = await this.shifts.calendarForEngagement(tx, summary.engagementId);
      const work = calendar.dayOn(day);
      const rows = await tx
        .select()
        .from(punches)
        .where(and(eq(punches.engagementId, summary.engagementId), eq(punches.day, day)))
        .orderBy(asc(punches.at));
      const [last] = await tx
        .select({ mode: punches.mode })
        .from(punches)
        .where(
          and(eq(punches.personId, summary.personId), inArray(punches.source, ['web', 'mobile'])),
        )
        .orderBy(desc(punches.at))
        .limit(1);
      return {
        date: day,
        working: calendar.isWorking(day),
        holiday: work.holiday && !work.holiday.optional ? work.holiday.name : null,
        shift: work.shift
          ? { code: work.shift.code, startTime: work.startTime, endTime: work.endTime }
          : null,
        checkedIn: rows.length % 2 === 1,
        punches: rows.map(punchView),
        lastMode: last?.mode ?? null,
      };
    });
  }

  // ---- Biometric devices (decision #67) ----

  /** A device (or its on-site agent) pushes punches with its key. Resends are ignored. */
  async push(key: string | undefined, body: BiometricPush, now = new Date()) {
    if (!key) throw new UnauthorizedException();
    return this.db.tx(async (tx) => {
      const [device] = await tx
        .select()
        .from(biometricDevices)
        .where(and(eq(biometricDevices.keyHash, hashKey(key)), isNull(biometricDevices.deletedAt)));
      if (!device) throw new UnauthorizedException();
      const codes = [...new Set(body.punches.map((p) => p.employeeCode))];
      const people = await tx
        .select()
        .from(engagements)
        .where(
          and(
            inArray(engagements.employeeCode, codes),
            inArray(engagements.status, [...WORKING_STATUSES]),
          ),
        );
      const byCode = new Map(people.map((e) => [e.employeeCode, e]));
      let accepted = 0;
      let duplicates = 0;
      const unknown = new Set<string>();
      const touched = new Map<string, { engagement: EngagementRow; day: string }>();
      for (const p of body.punches) {
        const engagement = byCode.get(p.employeeCode);
        if (!engagement) {
          unknown.add(p.employeeCode);
          continue;
        }
        const at = new Date(p.at);
        const day = businessDate(at);
        const inserted = await tx
          .insert(punches)
          .values({
            tenantId: requireContext().tenantId,
            engagementId: engagement.id,
            personId: engagement.personId,
            at,
            day,
            direction: p.direction ?? null,
            source: 'biometric',
            siteLocationId: device.locationId,
            deviceId: device.id,
            externalId: p.externalId,
          })
          .onConflictDoNothing()
          .returning({ id: punches.id });
        if (inserted.length) {
          accepted++;
          touched.set(`${engagement.id}:${day}`, { engagement, day });
        } else {
          duplicates++;
        }
      }
      for (const { engagement, day } of touched.values())
        await this.rebuild(tx, engagement, day, now);
      await tx
        .update(biometricDevices)
        .set({ lastSeenAt: now })
        .where(eq(biometricDevices.id, device.id));
      // Ids only: employee codes the device knows but iPro doesn't, for HR to check enrolment.
      return { accepted, duplicates, unknownEmployeeCodes: [...unknown] };
    });
  }

  async devices(): Promise<BiometricDeviceView[]> {
    await this.authz.assert(requireContext().actor!, 'read', { area: 'org_config' });
    const today = businessDate(new Date());
    return this.db.tx(async (tx) => {
      const rows = await tx
        .select({ device: biometricDevices, location: locationVersions.name })
        .from(biometricDevices)
        .leftJoin(
          locationVersions,
          and(
            eq(locationVersions.locationId, biometricDevices.locationId),
            inForce(locationVersions.effectiveFrom, locationVersions.effectiveTo, today),
          ),
        )
        .orderBy(asc(biometricDevices.code));
      return rows.map(({ device, location }) => ({
        id: device.id,
        code: device.code,
        name: device.name,
        location,
        active: !device.deletedAt,
        lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      }));
    });
  }

  /** Registers a device; its key is shown once and only its hash is kept. */
  async addDevice(input: { code: string; name: string; locationId: string }) {
    const { actor, tenantId } = requireContext();
    await this.authz.assert(actor!, 'create', { area: 'org_config' });
    const key = randomBytes(32).toString('base64url');
    const id = await this.db.tx(async (tx) => {
      const [existing] = await tx
        .select({ id: biometricDevices.id })
        .from(biometricDevices)
        .where(eq(biometricDevices.code, input.code));
      if (existing) throw new ConflictException({ message: 'A device with this code exists' });
      const [row] = await tx
        .insert(biometricDevices)
        .values({
          tenantId,
          ...input,
          keyHash: hashKey(key),
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        })
        .returning({ id: biometricDevices.id });
      await this.audit.record(tx, {
        action: 'create',
        table: 'biometric_device',
        recordId: row!.id,
      });
      return row!.id;
    });
    return { id, key };
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const actor = requireContext().actor!;
    await this.authz.assert(actor, 'update', { area: 'org_config' });
    await this.db.tx(async (tx) => {
      const [row] = await tx
        .update(biometricDevices)
        .set({ deletedAt: new Date(), updatedAt: new Date(), updatedBy: actor.userId })
        .where(and(eq(biometricDevices.id, deviceId), isNull(biometricDevices.deletedAt)))
        .returning({ id: biometricDevices.id });
      if (!row) throw new NotFoundException();
      await this.audit.record(tx, {
        action: 'delete',
        table: 'biometric_device',
        recordId: deviceId,
      });
    });
  }

  // ---- The attendance build ----

  /** Every 15 minutes: today's days for everyone who has punched. */
  async buildToday(now = new Date()): Promise<{ built: number }> {
    const day = businessDate(now);
    return this.db.tx(async (tx) => {
      const ids = await tx
        .selectDistinct({ engagementId: punches.engagementId })
        .from(punches)
        .where(eq(punches.day, day));
      const rows = ids.length
        ? await tx
            .select()
            .from(engagements)
            .where(
              inArray(
                engagements.id,
                ids.map((i) => i.engagementId),
              ),
            )
        : [];
      for (const engagement of rows) await this.rebuild(tx, engagement, day, now);
      return { built: rows.length };
    });
  }

  /** Nightly at 02:00: yesterday for everyone working, so a day with no punch becomes absent. */
  async buildDay(day: string, now = new Date()): Promise<{ built: number }> {
    return this.db.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(engagements)
        .where(
          and(
            inArray(engagements.status, [...WORKING_STATUSES, 'exited']),
            lte(engagements.joiningDate, day),
            or(isNull(engagements.lastWorkingDate), gte(engagements.lastWorkingDate, day)),
          ),
        );
      for (const engagement of rows) await this.rebuild(tx, engagement, day, now);
      return { built: rows.length };
    });
  }

  /** E3 / H9: a month of days, built ones with their status and the rest with calendar facts. */
  async month(personId: string, month: string): Promise<AttendanceDayView[]> {
    const summary = await this.people.summary(personId);
    const obligations = await this.authz.assert(requireContext().actor!, 'read', {
      area: 'attendance',
      subjectPersonId: personId,
      legalEntityId: summary.legalEntityId,
    });
    // CXO reads attendance as totals only (permissions table): no one person's days.
    if (obligations.has('aggregates_only')) throw new ForbiddenException();
    const from = `${month}-01`;
    const to = lastDayOf(month);
    return this.db.tx(async (tx) => {
      const calendar = await this.shifts.calendarForEngagement(tx, summary.engagementId);
      const built = await tx
        .select()
        .from(attendanceDays)
        .where(
          and(
            eq(attendanceDays.personId, personId),
            gte(attendanceDays.day, from),
            lte(attendanceDays.day, to),
          ),
        );
      const byDay = new Map(built.map((d) => [d.day, d]));
      const leave = await leaveOn(tx, summary.engagementId, from, to, false);
      const days: AttendanceDayView[] = [];
      for (let date = from; date <= to; date = addDays(date, 1)) {
        // A day built as leave whose leave was since cancelled or revoked (e.g. back today) shows as
        // not built until a punch or the nightly build replaces it: attendance rows aren't deleted.
        const stored = byDay.get(date);
        const row =
          stored?.status === 'leave' && !leave.get(date)?.approved && !stored.regularised
            ? undefined
            : stored;
        const work = calendar.dayOn(date);
        const holiday = work.holiday && !work.holiday.optional ? work.holiday.name : null;
        const working = calendar.isWorking(date);
        days.push({
          date,
          status:
            row?.status ??
            (leave.get(date)?.approved && leave.get(date)?.half === 'full'
              ? 'leave'
              : holiday
                ? 'holiday'
                : working
                  ? null
                  : 'weekly_off'),
          working,
          holiday,
          firstIn: row?.firstIn?.toISOString() ?? null,
          lastOut: row?.lastOut?.toISOString() ?? null,
          workedMinutes: row?.workedMinutes ?? null,
          mode: row?.mode ?? null,
          flags: (row?.flags ?? []) as AttendanceFlag[],
          regularised: row?.regularised ?? false,
          leave: leave.get(date) ?? null,
        });
      }
      return days;
    });
  }

  /**
   * Spec notifications: "Missing check-in" to the employee at shift start plus grace on a working day
   * with no punch, once a day. Leave (slice 7) and office bookings (slice 8) will also excuse a day.
   */
  async remindMissingCheckIns(now = new Date()): Promise<{ reminded: number }> {
    const day = businessDate(now);
    const minute = minutesInIndia(now);
    const startOfDay = new Date(`${day}T00:00:00+05:30`);
    return this.db.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(engagements)
        .where(
          and(
            inArray(engagements.status, [...WORKING_STATUSES]),
            lte(engagements.joiningDate, day),
            or(isNull(engagements.lastWorkingDate), gte(engagements.lastWorkingDate, day)),
          ),
        );
      const punched = new Set(
        (
          await tx
            .selectDistinct({ engagementId: punches.engagementId })
            .from(punches)
            .where(eq(punches.day, day))
        ).map((p) => p.engagementId),
      );
      let reminded = 0;
      for (const engagement of rows) {
        if (punched.has(engagement.id)) continue;
        if ((await leaveOn(tx, engagement.id, day, day, true)).has(day)) continue;
        const calendar = await this.shifts.calendarForEngagement(tx, engagement.id);
        if (!calendar.isWorking(day)) continue;
        const work = calendar.dayOn(day);
        const due = toMinutes(work.startTime) + (work.shift?.graceMinutes ?? 0);
        if (minute < due || minute >= toMinutes(work.endTime)) continue;
        const userId = await userOfPerson(tx, engagement.personId);
        if (!userId) continue;
        const [sent] = await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.recipientUserId, userId),
              eq(notifications.kind, 'missing_check_in'),
              gte(notifications.createdAt, startOfDay),
            ),
          )
          .limit(1);
        if (sent) continue;
        await notify(
          tx,
          [userId],
          'missing_check_in',
          "You haven't checked in today",
          '/attendance',
        );
        reminded++;
      }
      return { reminded };
    });
  }

  // ---- Internals ----

  /** Rebuilds one person's day in the caller's transaction (a regularised day is left as decided). */
  async rebuild(tx: Tx, engagement: EngagementRow, day: string, now: Date): Promise<void> {
    if (day < engagement.joiningDate) return;
    if (engagement.lastWorkingDate && day > engagement.lastWorkingDate) return;
    const [existing] = await tx
      .select({ regularised: attendanceDays.regularised })
      .from(attendanceDays)
      .where(and(eq(attendanceDays.engagementId, engagement.id), eq(attendanceDays.day, day)));
    if (existing?.regularised) return;
    const calendar = await this.shifts.calendarForEngagement(tx, engagement.id);
    const work = calendar.dayOn(day);
    const rows = await tx
      .select()
      .from(punches)
      .where(and(eq(punches.engagementId, engagement.id), eq(punches.day, day)));
    const result = buildDay({
      day,
      today: businessDate(now),
      working: calendar.isWorking(day),
      holiday: work.holiday,
      shift: work.shift
        ? {
            startTime: work.startTime,
            graceMinutes: work.shift.graceMinutes,
            breakMinutes: work.shift.breakMinutes,
            halfDayMinutes: work.shift.halfDayMinutes,
          }
        : null,
      punches: rows,
      leave: (await leaveOn(tx, engagement.id, day, day, true)).get(day)?.half ?? null,
    });
    if (!result) return;
    const values = { ...result, builtAt: now, updatedAt: now };
    await tx
      .insert(attendanceDays)
      .values({
        tenantId: requireContext().tenantId,
        engagementId: engagement.id,
        personId: engagement.personId,
        day,
        ...values,
      })
      .onConflictDoUpdate({
        target: [attendanceDays.tenantId, attendanceDays.engagementId, attendanceDays.day],
        set: values,
      });
  }

  private async working(tx: Tx, engagementId: string, day: string): Promise<EngagementRow> {
    const [engagement] = await tx
      .select()
      .from(engagements)
      .where(eq(engagements.id, engagementId));
    if (
      !engagement ||
      !WORKING_STATUSES.includes(engagement.status as (typeof WORKING_STATUSES)[number]) ||
      day < engagement.joiningDate
    ) {
      throw new BadRequestException({ message: 'You can check in from your joining day' });
    }
    return engagement;
  }

  /** The person's site on a day: their location then, with its coordinates and geofence radius. */
  private async siteOf(tx: Tx, engagementId: string, day: string) {
    const [row] = await tx
      .select({
        locationId: assignments.locationId,
        latitude: locationVersions.latitude,
        longitude: locationVersions.longitude,
        radius: locationVersions.geofenceRadiusMetres,
      })
      .from(assignments)
      .innerJoin(
        locationVersions,
        and(
          eq(locationVersions.locationId, assignments.locationId),
          inForce(locationVersions.effectiveFrom, locationVersions.effectiveTo, day),
        ),
      )
      .where(
        and(
          eq(assignments.engagementId, engagementId),
          inForce(assignments.effectiveFrom, assignments.effectiveTo, day),
        ),
      );
    if (!row || row.latitude === null || row.longitude === null) return null;
    return {
      locationId: row.locationId,
      latitude: row.latitude,
      longitude: row.longitude,
      radius: row.radius ?? (await this.settings.get(tx, 'geofence_radius_metres')),
    };
  }
}

function punchView(row: PunchRow): PunchView {
  return {
    id: row.id,
    at: row.at.toISOString(),
    direction: row.direction,
    source: row.source,
    mode: row.mode,
    outsideGeofence: row.outsideGeofence,
    distanceMetres: row.distanceMetres,
  };
}

type DayLeave = NonNullable<AttendanceDayView['leave']>;

/**
 * Leave on each day for one engagement (slice 7): approved, or also asked for. Two halves on one
 * day make a full day.
 */
async function leaveOn(
  tx: Tx,
  engagementId: string,
  from: string,
  to: string,
  approvedOnly: boolean,
): Promise<Map<string, DayLeave>> {
  const rows = await tx
    .select({
      day: leaveRequestDays.day,
      half: leaveRequestDays.half,
      status: leaveRequests.status,
      code: leaveTypes.code,
      name: leaveTypes.name,
    })
    .from(leaveRequestDays)
    .innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequestDays.leaveTypeId))
    .where(
      and(
        eq(leaveRequestDays.engagementId, engagementId),
        isNull(leaveRequestDays.cancelledAt),
        inArray(
          leaveRequests.status,
          approvedOnly ? ['approved'] : ['applied', 'returned', 'approved'],
        ),
        gte(leaveRequestDays.day, from),
        lte(leaveRequestDays.day, to),
      ),
    );
  const byDay = new Map<string, DayLeave>();
  for (const r of rows) {
    const approved = r.status === 'approved';
    const seen = byDay.get(r.day);
    if (!seen) {
      byDay.set(r.day, { code: r.code, name: r.name, half: r.half, approved });
      continue;
    }
    byDay.set(r.day, {
      code: seen.code,
      name: seen.name,
      half: seen.half !== r.half || r.half === 'full' ? 'full' : seen.half,
      approved: seen.approved && approved,
    });
  }
  return byDay;
}

/** The last day of a YYYY-MM month. */
export function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
