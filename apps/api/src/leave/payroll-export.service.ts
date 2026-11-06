import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import {
  toDays,
  type AttendanceStatus,
  type PayrollExportRow,
  type PayrollExportView,
  type PayrollPendingItem,
  type WorkMode,
} from '@ipro/shared';
import { attendanceDays, attendanceRegularisations } from '../attendance/attendance.schema.js';
import { lastDayOf } from '../attendance/attendance.service.js';
import { ShiftsService } from '../attendance/shifts.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { personSummaries } from '../people/people.queries.js';
import { engagements, persons } from '../people/people.schema.js';
import { leaveRequestDays, leaveRequests, leaveTypes, payrollExports } from './leave.schema.js';
import {
  addDay,
  csvCell,
  emptyTotals,
  lopOf,
  payableOf,
  type MonthTotals,
} from './payroll-rules.js';

type EngagementRow = typeof engagements.$inferSelect;

const MONTH_NAMES = new Intl.DateTimeFormat('en-IN', { month: 'long', timeZone: 'UTC' });
const monthName = (month: string) => MONTH_NAMES.format(new Date(`${month}-01T00:00:00Z`));
const previousMonthOf = (month: string) => addDays(`${month}-01`, -1).slice(0, 7);
const daysIn = (month: string) => Number(lastDayOf(month).slice(8, 10));

const COLUMNS = [
  'employee_code',
  'name',
  'department',
  'joining_date',
  'last_working_date',
  'calendar_days',
  'employed_days',
  'payable_days',
  'present_days',
  'wfh_days',
  'client_site_days',
  'paid_leave_days',
  'lop_leave_days',
  'lop_absent_days',
  'lop_days',
  'weekly_off_days',
  'holiday_days',
  'pending_requests',
  'lop_adjustment_days',
  'lop_adjustment_note',
] as const;

interface Computed {
  engagement: EngagementRow;
  totals: MonthTotals;
}

/**
 * The monthly attendance and loss-of-pay export for the current payroll (spec integrations;
 * slice 7c, decision #77). A month is exported once it is over. Each day counts as it stands:
 * undecided requests are listed as a warning. A download is recorded, so a later change to that
 * month's loss of pay is carried into the next month's export as an adjustment.
 */
@Injectable()
export class PayrollExportService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ShiftsService) private readonly shifts: ShiftsService,
  ) {}

  async view(month: string, now = new Date()): Promise<PayrollExportView> {
    this.assertOver(month, now);
    return this.db.tx((tx) => this.build(tx, month));
  }

  async csv(month: string, now = new Date()): Promise<{ filename: string; body: string }> {
    this.assertOver(month, now);
    return this.db.tx(async (tx) => {
      const view = await this.build(tx, month);
      const [saved] = await tx
        .insert(payrollExports)
        .values({
          tenantId: requireContext().tenantId,
          month,
          rowCount: view.rows.length,
          lines: view.rows.map((r) => ({
            engagementId: r.engagementId,
            lop: Math.round(r.lop * 100),
            payable: Math.round(r.payableDays * 100),
          })),
          createdBy: requireContext().actor!.userId,
          updatedBy: requireContext().actor!.userId,
        })
        .returning({ id: payrollExports.id });
      await this.audit.record(tx, {
        action: 'export',
        table: 'payroll_export',
        recordId: saved!.id,
        fieldChanges: [
          { field: 'month', to: month },
          { field: 'rows', to: String(view.rows.length) },
        ],
      });
      const lines = [COLUMNS.join(',')];
      for (const r of view.rows) {
        lines.push(
          [
            r.employeeCode,
            r.name,
            r.department,
            r.joinedOn,
            r.leftOn,
            r.calendarDays,
            r.employedDays,
            r.payableDays,
            r.present,
            r.wfh,
            r.clientSite,
            r.paidLeave,
            r.lopLeave,
            r.lopAbsent,
            r.lop,
            r.weeklyOffs,
            r.holidays,
            r.pending,
            r.adjustment?.days ?? null,
            r.adjustment?.note ?? null,
          ]
            .map(csvCell)
            .join(','),
        );
      }
      return { filename: `attendance-${month}.csv`, body: `${lines.join('\n')}\n` };
    });
  }

  // ---- Internals ----

  private assertOver(month: string, now: Date) {
    if (month >= businessDate(now).slice(0, 7)) {
      throw new BadRequestException({ message: 'Export a month once it is over' });
    }
  }

  private async build(tx: Tx, month: string): Promise<PayrollExportView> {
    const people = await this.visible(tx, await this.employedIn(tx, month));
    const computed = await this.compute(tx, people, month);
    const summaries = new Map(
      (
        await personSummaries(tx, lastDayOf(month), {
          personIds: people.map((e) => e.personId),
        })
      ).map((s) => [s.personId, s]),
    );
    const names = new Map(
      people.length
        ? (
            await tx
              .select({ id: persons.id, legalName: persons.legalName })
              .from(persons)
              .where(
                inArray(
                  persons.id,
                  people.map((e) => e.personId),
                ),
              )
          ).map((p) => [p.id, p.legalName])
        : [],
    );
    const pending = await this.pending(tx, people, month, names);
    const previous = previousMonthOf(month);
    const adjustments = await this.adjustments(tx, previous);
    const first = `${month}-01`;
    const last = lastDayOf(month);
    const rows: PayrollExportRow[] = computed.map(({ engagement: e, totals: t }) => {
      const adjustment = adjustments.byEngagement.get(e.id) ?? null;
      return {
        personId: e.personId,
        engagementId: e.id,
        employeeCode: e.employeeCode,
        name: names.get(e.personId) ?? '',
        department: summaries.get(e.personId)?.department?.name ?? null,
        joinedOn: e.joiningDate >= first ? e.joiningDate : null,
        leftOn: e.lastWorkingDate && e.lastWorkingDate <= last ? e.lastWorkingDate : null,
        calendarDays: daysIn(month),
        employedDays: toDays(t.employed),
        payableDays: toDays(payableOf(t)),
        present: toDays(t.office),
        wfh: toDays(t.wfh),
        clientSite: toDays(t.clientSite),
        paidLeave: toDays(t.paidLeave),
        lopLeave: toDays(t.lopLeave),
        lopAbsent: toDays(t.lopAbsent),
        lop: toDays(lopOf(t)),
        weeklyOffs: toDays(t.weeklyOff),
        holidays: toDays(t.holiday),
        lopDays: t.lopDays.map((d) => ({ date: d.date, days: toDays(d.amount), why: d.why })),
        pending: pending.filter((p) => p.engagementId === e.id).length,
        adjustment,
      };
    });
    rows.sort((a, b) => a.employeeCode.localeCompare(b.employeeCode));
    const exports = await tx
      .select({ at: payrollExports.createdAt, rows: payrollExports.rowCount })
      .from(payrollExports)
      .where(eq(payrollExports.month, month))
      .orderBy(desc(payrollExports.createdAt));
    return {
      month,
      previousMonth: previous,
      previousExportedAt: adjustments.exportedAt,
      exports: exports.map((x) => ({ at: x.at.toISOString(), rows: x.rows })),
      rows,
      pending,
      totals: {
        people: rows.length,
        lop: rows.reduce((s, r) => s + r.lop, 0),
        payable: rows.reduce((s, r) => s + r.payableDays, 0),
        adjustments: rows.filter((r) => r.adjustment).length,
      },
    };
  }

  /** Everyone employed on at least one day of the month, joiners and leavers included. */
  private async employedIn(tx: Tx, month: string): Promise<EngagementRow[]> {
    return tx
      .select()
      .from(engagements)
      .where(
        and(
          inArray(engagements.status, ['active', 'on_notice', 'exited']),
          lte(engagements.joiningDate, lastDayOf(month)),
          or(isNull(engagements.lastWorkingDate), gte(engagements.lastWorkingDate, `${month}-01`)),
        ),
      )
      .orderBy(asc(engagements.employeeCode));
  }

  /** Only people whose attendance the exporter may change (HR for their entities; never CXO rows). */
  private async visible(tx: Tx, rows: EngagementRow[]): Promise<EngagementRow[]> {
    const actor = requireContext().actor!;
    const out: EngagementRow[] = [];
    for (const e of rows) {
      const decision = await this.authz.check(actor, 'update', {
        area: 'attendance',
        subjectPersonId: e.personId,
        legalEntityId: e.legalEntityId,
      });
      if (decision.allowed && !decision.obligations.has('aggregates_only')) out.push(e);
    }
    return out;
  }

  /** Each engagement's month, day by day (payroll-rules.ts). */
  private async compute(tx: Tx, people: EngagementRow[], month: string): Promise<Computed[]> {
    const first = `${month}-01`;
    const last = lastDayOf(month);
    if (people.length === 0) return [];
    const ids = people.map((e) => e.id);
    const built = await tx
      .select({
        engagementId: attendanceDays.engagementId,
        day: attendanceDays.day,
        status: attendanceDays.status,
        mode: attendanceDays.mode,
        regularised: attendanceDays.regularised,
      })
      .from(attendanceDays)
      .where(
        and(
          inArray(attendanceDays.engagementId, ids),
          gte(attendanceDays.day, first),
          lte(attendanceDays.day, last),
        ),
      );
    const leave = await tx
      .select({
        engagementId: leaveRequestDays.engagementId,
        day: leaveRequestDays.day,
        amount: leaveRequestDays.amount,
        paid: leaveTypes.paid,
      })
      .from(leaveRequestDays)
      .innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequestDays.leaveTypeId))
      .where(
        and(
          inArray(leaveRequestDays.engagementId, ids),
          isNull(leaveRequestDays.cancelledAt),
          eq(leaveRequests.status, 'approved'),
          gte(leaveRequestDays.day, first),
          lte(leaveRequestDays.day, last),
        ),
      );
    const out: Computed[] = [];
    for (const engagement of people) {
      const calendar = await this.shifts.calendarForEngagement(tx, engagement.id);
      const days = new Map(
        built.filter((b) => b.engagementId === engagement.id).map((b) => [b.day, b]),
      );
      const mine = leave.filter((l) => l.engagementId === engagement.id);
      let totals = emptyTotals();
      for (let day = first; day <= last; day = addDays(day, 1)) {
        const onDay = mine.filter((l) => l.day === day);
        const paidLeave = onDay.filter((l) => l.paid).reduce((s, l) => s + l.amount, 0);
        const unpaidLeave = onDay.filter((l) => !l.paid).reduce((s, l) => s + l.amount, 0);
        const stored = days.get(day);
        // A day built as leave whose leave was since withdrawn counts as not recorded (as on E3).
        const row =
          stored?.status === 'leave' && paidLeave + unpaidLeave === 0 && !stored.regularised
            ? undefined
            : stored;
        const work = calendar.dayOn(day);
        totals = addDay(totals, {
          day,
          employed:
            day >= engagement.joiningDate &&
            (!engagement.lastWorkingDate || day <= engagement.lastWorkingDate),
          working: calendar.isWorking(day),
          holiday: Boolean(work.holiday && !work.holiday.optional),
          status: (row?.status ?? null) as AttendanceStatus | null,
          mode: (row?.mode ?? null) as WorkMode | null,
          paidLeave,
          unpaidLeave,
        });
      }
      out.push({ engagement, totals });
    }
    return out;
  }

  /** Leave and regularisations in the month asked for and not yet decided. */
  private async pending(
    tx: Tx,
    people: EngagementRow[],
    month: string,
    names: Map<string, string>,
  ): Promise<PayrollPendingItem[]> {
    if (people.length === 0) return [];
    const ids = people.map((e) => e.id);
    const byId = new Map(people.map((e) => [e.id, e]));
    const first = `${month}-01`;
    const last = lastDayOf(month);
    const leave = await tx
      .selectDistinct({
        engagementId: leaveRequests.engagementId,
        from: leaveRequests.fromDate,
        to: leaveRequests.toDate,
        type: leaveTypes.name,
      })
      .from(leaveRequests)
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
      .where(
        and(
          inArray(leaveRequests.engagementId, ids),
          inArray(leaveRequests.status, ['applied', 'returned']),
          lte(leaveRequests.fromDate, last),
          gte(leaveRequests.toDate, first),
        ),
      );
    const regularisations = await tx
      .select({
        engagementId: attendanceRegularisations.engagementId,
        day: attendanceRegularisations.day,
      })
      .from(attendanceRegularisations)
      .where(
        and(
          inArray(attendanceRegularisations.engagementId, ids),
          inArray(attendanceRegularisations.state, ['pending', 'returned']),
          gte(attendanceRegularisations.day, first),
          lte(attendanceRegularisations.day, last),
        ),
      );
    const item = (engagementId: string, date: string, what: string): PayrollPendingItem => {
      const e = byId.get(engagementId)!;
      return {
        personId: e.personId,
        engagementId,
        name: names.get(e.personId) ?? '',
        employeeCode: e.employeeCode,
        what,
        date,
      };
    };
    return [
      ...leave.map((l) =>
        item(
          l.engagementId,
          l.from < first ? first : l.from,
          `${l.type} asked for, not yet approved`,
        ),
      ),
      ...regularisations.map((r) =>
        item(r.engagementId, r.day, 'Regularisation asked for, not yet approved'),
      ),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.employeeCode.localeCompare(b.employeeCode));
  }

  /**
   * Last month as it stands against what was last exported for it: a difference in loss of pay is
   * carried into this month's export. Nothing when last month was never exported.
   */
  private async adjustments(tx: Tx, previous: string) {
    const [exported] = await tx
      .select()
      .from(payrollExports)
      .where(eq(payrollExports.month, previous))
      .orderBy(desc(payrollExports.createdAt))
      .limit(1);
    const byEngagement = new Map<string, { days: number; note: string }>();
    if (!exported) return { exportedAt: null, byEngagement };
    const people = await this.visible(tx, await this.employedIn(tx, previous));
    const sent = new Map(exported.lines.map((l) => [l.engagementId, l.lop]));
    for (const { engagement, totals } of await this.compute(tx, people, previous)) {
      const now = lopOf(totals);
      const before = sent.get(engagement.id);
      const name = monthName(previous);
      if (before === undefined) {
        if (now > 0) {
          byEngagement.set(engagement.id, {
            days: toDays(now),
            note: `${name}: not in the export; loss of pay ${toDays(now)}`,
          });
        }
      } else if (before !== now) {
        byEngagement.set(engagement.id, {
          days: toDays(now - before),
          note: `${name}: loss of pay ${toDays(before)} → ${toDays(now)} since it was exported`,
        });
      }
    }
    return { exportedAt: exported.createdAt.toISOString(), byEngagement };
  }
}
