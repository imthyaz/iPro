import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import type {
  AttendanceStatus,
  ComplianceView,
  ComplianceWeek,
  TeamCalendarView,
  TeamScope,
  TeamTodayStatus,
  TeamTodayView,
  WorkMode,
} from '@ipro/shared';
import { attendanceDays } from '../attendance/attendance.schema.js';
import { lastDayOf } from '../attendance/attendance.service.js';
import { ShiftsService } from '../attendance/shifts.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { leaveRequestDays, leaveRequests, leaveTypes } from '../leave/leave.schema.js';
import { engagements, persons } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { todayStatus, weekCompliance, type ComplianceDay } from './compliance-rules.js';
import { isoWeekday, mondayOf } from './hybrid-rules.js';
import {
  hybridComplianceDays,
  hybridExceptions,
  workBookings,
  workPolicies,
} from './hybrid.schema.js';
import { HybridService } from './hybrid.service.js';

type EngagementRow = typeof engagements.$inferSelect;
type Half = 'full' | 'first' | 'second';

const EMPLOYED = ['active', 'on_notice', 'exited'] as const;
const MAX_WEEKS = 13;
const STATUSES: TeamTodayStatus[] = [
  'office',
  'wfh',
  'client_site',
  'leave',
  'off',
  'absent',
  'not_checked_in',
];

const mergeHalf = (seen: Half | undefined, next: Half): Half =>
  !seen ? next : seen !== next || next === 'full' ? 'full' : seen;

/**
 * Hybrid compliance and the manager's team views (slice 8b; spec job "Hybrid compliance", screens
 * M2, M3, M4; decision #78). Each night the job records yesterday as planned and as it happened; on
 * Monday it records all of last week again, so late corrections count. Managers see their team,
 * HR the people in their entities; employees and CXO (totals only, H12) don't.
 */
@Injectable()
export class ComplianceService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(ShiftsService) private readonly shifts: ShiftsService,
    @Inject(HybridService) private readonly hybrid: HybridService,
  ) {}

  // ---- The nightly job (03:00) ----

  async runDaily(today: string): Promise<{ recorded: number; week: string | null }> {
    let recorded = await this.record(addDays(today, -1));
    let week: string | null = null;
    if (isoWeekday(today) === 1) {
      week = addDays(today, -7);
      for (let i = 0; i < 6; i++) recorded += await this.record(addDays(week, i));
    }
    return { recorded, week };
  }

  /** One day for everyone employed with a policy that sets days. Safe to run again. */
  async record(day: string): Promise<number> {
    return this.db.tx(async (tx) => {
      const rows = await this.employedOn(tx, day, day);
      let recorded = 0;
      for (const engagement of rows) {
        const summary = await this.people.summary(engagement.personId);
        if (summary.engagementId !== engagement.id) continue;
        const ctx = await this.hybrid.contextOf(tx, summary, mondayOf(day));
        if (!ctx.policy || ctx.policy.requiredDays === 0) continue;
        const [booking] = await tx
          .select({ mode: workBookings.mode })
          .from(workBookings)
          .where(
            and(
              eq(workBookings.engagementId, engagement.id),
              eq(workBookings.date, day),
              eq(workBookings.status, 'confirmed'),
            ),
          );
        const [actual] = await tx
          .select({ status: attendanceDays.status, mode: attendanceDays.mode })
          .from(attendanceDays)
          .where(and(eq(attendanceDays.engagementId, engagement.id), eq(attendanceDays.day, day)));
        const leave = await this.leaveOn(tx, [engagement.id], day, day, true);
        const values = {
          personId: engagement.personId,
          weekStart: mondayOf(day),
          policyId: ctx.policy.id,
          requiredMode: ctx.policy.requiredMode,
          requiredDays: ctx.policy.requiredDays,
          working: ctx.calendar.isWorking(day),
          onLeave: leave.get(`${engagement.id}:${day}`)?.half === 'full',
          plannedMode: booking?.mode ?? null,
          actualStatus: actual?.status ?? null,
          actualMode: actual?.mode ?? null,
          updatedAt: new Date(),
        };
        await tx
          .insert(hybridComplianceDays)
          .values({
            tenantId: requireContext().tenantId,
            engagementId: engagement.id,
            date: day,
            ...values,
          })
          .onConflictDoUpdate({
            target: [
              hybridComplianceDays.tenantId,
              hybridComplianceDays.engagementId,
              hybridComplianceDays.date,
            ],
            set: values,
          });
        recorded++;
      }
      return recorded;
    });
  }

  // ---- M4: compliance ----

  async report(from: string, to: string, scope: TeamScope = 'team'): Promise<ComplianceView> {
    if (isoWeekday(from) !== 1 || isoWeekday(to) !== 1 || to < from) {
      throw new BadRequestException({ message: 'Weeks start on Monday' });
    }
    if (addDays(from, 7 * (MAX_WEEKS - 1)) < to) {
      throw new BadRequestException({ message: `Choose up to ${MAX_WEEKS} weeks` });
    }
    return this.db.tx(async (tx) => {
      const people = await this.visible(tx, await this.employedOn(tx, from, addDays(to, 6)), scope);
      const ids = people.map((e) => e.id);
      const days = ids.length
        ? await tx
            .select({ row: hybridComplianceDays, policyName: workPolicies.name })
            .from(hybridComplianceDays)
            .innerJoin(workPolicies, eq(workPolicies.id, hybridComplianceDays.policyId))
            .where(
              and(
                inArray(hybridComplianceDays.engagementId, ids),
                gte(hybridComplianceDays.weekStart, from),
                lte(hybridComplianceDays.weekStart, to),
              ),
            )
            .orderBy(asc(hybridComplianceDays.date))
        : [];
      const approved = ids.length
        ? await tx
            .select({
              engagementId: hybridExceptions.engagementId,
              weekStart: hybridExceptions.weekStart,
            })
            .from(hybridExceptions)
            .where(
              and(
                inArray(hybridExceptions.engagementId, ids),
                eq(hybridExceptions.status, 'approved'),
                gte(hybridExceptions.weekStart, from),
                lte(hybridExceptions.weekStart, to),
              ),
            )
        : [];
      const approvedSet = new Set(approved.map((a) => `${a.engagementId}:${a.weekStart}`));
      const names = await this.names(tx, people);
      const out: ComplianceView['people'] = [];
      for (const e of people) {
        const mine = days.filter((d) => d.row.engagementId === e.id);
        if (mine.length === 0) continue;
        const weeks: ComplianceWeek[] = [];
        for (const weekStart of [...new Set(mine.map((d) => d.row.weekStart))].sort()) {
          const inWeek = mine.filter((d) => d.row.weekStart === weekStart);
          const last = inWeek.at(-1)!;
          const result = weekCompliance(
            last.row.requiredMode,
            last.row.requiredDays,
            inWeek.map((d): ComplianceDay => ({
              date: d.row.date,
              working: d.row.working,
              onLeave: d.row.onLeave,
              planned: d.row.plannedMode,
              actualStatus: d.row.actualStatus as AttendanceStatus | null,
              actualMode: d.row.actualMode,
            })),
          );
          weeks.push({
            weekStart,
            policyName: last.policyName,
            requiredMode: last.row.requiredMode,
            ...result,
            approvedBelow: !result.met && approvedSet.has(`${e.id}:${weekStart}`),
          });
        }
        out.push({
          personId: e.personId,
          name: names.get(e.personId) ?? '',
          employeeCode: e.employeeCode,
          weeks,
        });
      }
      // Exceptions first: anyone who missed a week without approval, then by name.
      const missed = (p: (typeof out)[number]) => p.weeks.some((w) => !w.met && !w.approvedBelow);
      out.sort((a, b) => Number(missed(b)) - Number(missed(a)) || a.name.localeCompare(b.name));
      const weekStarts = [...new Set(out.flatMap((p) => p.weeks.map((w) => w.weekStart)))].sort();
      return {
        from,
        to,
        people: out,
        summary: weekStarts.map((weekStart) => {
          const weeks = out.flatMap((p) => p.weeks.filter((w) => w.weekStart === weekStart));
          return {
            weekStart,
            people: weeks.length,
            met: weeks.filter((w) => w.met).length,
            approvedBelow: weeks.filter((w) => w.approvedBelow).length,
          };
        }),
      };
    });
  }

  // ---- M2: Team today ----

  async teamToday(scope: TeamScope = 'team', now = new Date()): Promise<TeamTodayView> {
    const day = businessDate(now);
    return this.db.tx(async (tx) => {
      const people = await this.visible(tx, await this.employedOn(tx, day, day, false), scope);
      const ids = people.map((e) => e.id);
      const names = await this.names(tx, people);
      const attendance = ids.length
        ? await tx
            .select()
            .from(attendanceDays)
            .where(and(inArray(attendanceDays.engagementId, ids), eq(attendanceDays.day, day)))
        : [];
      const bookings = ids.length
        ? await tx
            .select()
            .from(workBookings)
            .where(
              and(
                inArray(workBookings.engagementId, ids),
                eq(workBookings.date, day),
                inArray(workBookings.status, ['confirmed', 'pending']),
              ),
            )
        : [];
      const leave = await this.leaveOn(tx, ids, day, day, true);
      const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as TeamTodayView['counts'];
      const rows: TeamTodayView['rows'] = [];
      for (const e of people) {
        const calendar = await this.shifts.calendarForEngagement(tx, e.id);
        const work = calendar.dayOn(day);
        const att = attendance.find((a) => a.engagementId === e.id);
        const onLeave = leave.get(`${e.id}:${day}`);
        const status = todayStatus({
          working: calendar.isWorking(day),
          leave: onLeave?.half ?? null,
          status: (att?.status ?? null) as AttendanceStatus | null,
          mode: att?.mode ?? null,
        });
        counts[status]++;
        rows.push({
          personId: e.personId,
          name: names.get(e.personId) ?? '',
          employeeCode: e.employeeCode,
          status,
          planned: bookings.find((b) => b.engagementId === e.id)?.mode ?? null,
          checkedInAt: att?.firstIn?.toISOString() ?? null,
          note:
            onLeave?.name ?? (work.holiday && !work.holiday.optional ? work.holiday.name : null),
        });
      }
      const order = (s: TeamTodayStatus) => STATUSES.indexOf(s);
      rows.sort((a, b) => order(a.status) - order(b.status) || a.name.localeCompare(b.name));
      return { date: day, rows, counts };
    });
  }

  // ---- M3: Team calendar ----

  async teamCalendar(month: string, scope: TeamScope = 'team'): Promise<TeamCalendarView> {
    const first = `${month}-01`;
    const last = lastDayOf(month);
    return this.db.tx(async (tx) => {
      const people = await this.visible(tx, await this.employedOn(tx, first, last, false), scope);
      const ids = people.map((e) => e.id);
      const names = await this.names(tx, people);
      const bookings = ids.length
        ? await tx
            .select()
            .from(workBookings)
            .where(
              and(
                inArray(workBookings.engagementId, ids),
                gte(workBookings.date, first),
                lte(workBookings.date, last),
                ne(workBookings.status, 'cancelled'),
              ),
            )
        : [];
      const leave = await this.leaveOn(tx, ids, first, last, false);
      const out: TeamCalendarView['people'] = [];
      for (const e of people) {
        const calendar = await this.shifts.calendarForEngagement(tx, e.id);
        const days: TeamCalendarView['people'][number]['days'] = [];
        for (let date = first; date <= last; date = addDays(date, 1)) {
          const work = calendar.dayOn(date);
          const l = leave.get(`${e.id}:${date}`);
          const b = bookings.find((x) => x.engagementId === e.id && x.date === date);
          days.push({
            date,
            working: calendar.isWorking(date),
            holiday: work.holiday && !work.holiday.optional ? work.holiday.name : null,
            leave: l ? { code: l.code, half: l.half, approved: l.approved } : null,
            booking: b
              ? {
                  mode: b.mode as WorkMode,
                  status: b.status as 'confirmed' | 'pending' | 'rejected',
                }
              : null,
          });
        }
        out.push({
          personId: e.personId,
          name: names.get(e.personId) ?? '',
          employeeCode: e.employeeCode,
          days,
        });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return { month, people: out };
    });
  }

  // ---- Internals ----

  /** Engagements employed on at least one day of a range (leavers included unless asked not to). */
  private employedOn(tx: Tx, from: string, to: string, withLeavers = true) {
    return tx
      .select()
      .from(engagements)
      .where(
        and(
          inArray(engagements.status, withLeavers ? [...EMPLOYED] : ['active', 'on_notice']),
          lte(engagements.joiningDate, to),
          or(isNull(engagements.lastWorkingDate), gte(engagements.lastWorkingDate, from)),
        ),
      )
      .orderBy(asc(engagements.employeeCode));
  }

  /**
   * The people shown: with "team", those whose bookings the viewer approves (their reports); with
   * "all", everyone they may read one by one (HR: their entities). Never the viewer, never CXO rows.
   */
  private async visible(tx: Tx, rows: EngagementRow[], scope: TeamScope): Promise<EngagementRow[]> {
    const actor = requireContext().actor!;
    const out: EngagementRow[] = [];
    for (const e of rows) {
      if (e.personId === actor.personId) continue;
      const decision = await this.authz.check(actor, scope === 'team' ? 'approve' : 'read', {
        area: 'hybrid_booking',
        subjectPersonId: e.personId,
        legalEntityId: e.legalEntityId,
      });
      if (decision.allowed && !decision.obligations.has('aggregates_only')) out.push(e);
    }
    return out;
  }

  private async names(tx: Tx, rows: EngagementRow[]) {
    if (rows.length === 0) return new Map<string, string>();
    const found = await tx
      .select({
        id: persons.id,
        legalName: persons.legalName,
        preferredName: persons.preferredName,
      })
      .from(persons)
      .where(
        inArray(
          persons.id,
          rows.map((e) => e.personId),
        ),
      );
    return new Map(found.map((p) => [p.id, p.preferredName ?? p.legalName]));
  }

  /** Leave per engagement and day ("id:date"), approved only or also asked for. */
  private async leaveOn(
    tx: Tx,
    engagementIds: string[],
    from: string,
    to: string,
    approvedOnly: boolean,
  ) {
    const out = new Map<string, { code: string; name: string; half: Half; approved: boolean }>();
    if (engagementIds.length === 0) return out;
    const rows = await tx
      .select({
        engagementId: leaveRequestDays.engagementId,
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
          inArray(leaveRequestDays.engagementId, engagementIds),
          isNull(leaveRequestDays.cancelledAt),
          inArray(
            leaveRequests.status,
            approvedOnly ? ['approved'] : ['applied', 'returned', 'approved'],
          ),
          gte(leaveRequestDays.day, from),
          lte(leaveRequestDays.day, to),
        ),
      );
    for (const r of rows) {
      const key = `${r.engagementId}:${r.day}`;
      const seen = out.get(key);
      out.set(key, {
        code: seen?.code ?? r.code,
        name: seen?.name ?? r.name,
        half: mergeHalf(seen?.half, r.half),
        approved: (seen?.approved ?? true) && r.status === 'approved',
      });
    }
    return out;
  }
}
