import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type {
  AbsenteeismReport,
  AbsenteeismRow,
  AttritionReport,
  CountRow,
  HeadcountReport,
  HybridComplianceReport,
  LeaveLiabilityReport,
  MovementReport,
  PersonSummary,
  SeatOccupancyReport,
} from '@ipro/shared';
import { attendanceDays } from '../attendance/attendance.schema.js';
import { SensitiveReads } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import type { DataArea } from '../authz/permissions.js';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { exitCases } from '../exit/exit.schema.js';
import { ComplianceService } from '../hybrid/compliance.service.js';
import { seats, workBookings } from '../hybrid/hybrid.schema.js';
import { leaveRequestDays, leaveRequests } from '../leave/leave.schema.js';
import { LeaveService } from '../leave/leave.service.js';
import { legalEntities, locationVersions } from '../org/org.schema.js';
import { inForce, personSummaries } from '../people/people.queries.js';
import { compensations, engagements, persons } from '../people/people.schema.js';
import {
  attrition,
  exitKindOf,
  joinedIn,
  leftIn,
  onHeadcount,
  percent,
  round1,
  WORKING_STATUSES,
  type EngagementFact,
} from './report-rules.js';

interface Fact extends EngagementFact {
  engagementId: string;
  legalEntityId: string;
  type: string;
}

/** Longest range for day-by-day reports (absenteeism, seats). */
const MAX_DAYS = 366;

/**
 * H12 Phase 1 reports (slice 13a; decision #93). Aggregates over the legal entities the user may
 * read for each report's data area at entity scope (HR, HR head, CXO); a manager's team scope
 * doesn't open them. Definitions are in report-rules.ts and the decision.
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(SensitiveReads) private readonly sensitive: SensitiveReads,
    @Inject(LeaveService) private readonly leave: LeaveService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
  ) {}

  async headcount(asOf: string): Promise<HeadcountReport> {
    return this.db.tx(async (tx) => {
      const facts = (await this.facts(tx, await this.entities(tx, 'profile'))).filter((e) =>
        onHeadcount(e, asOf),
      );
      const summaries = await this.summaries(tx, asOf, facts);
      return {
        asOf,
        total: facts.length,
        byDepartment: count(facts.map((e) => summaries.get(e.personId)?.department?.name ?? null)),
        byLocation: count(facts.map((e) => summaries.get(e.personId)?.location?.name ?? null)),
        byType: count(facts.map((e) => e.type)),
      };
    });
  }

  async movement(from: string, to: string): Promise<MovementReport> {
    return this.db.tx(async (tx) => {
      const facts = await this.facts(tx, await this.entities(tx, 'profile'));
      const joiners = facts.filter((e) => joinedIn(e, from, to));
      const leavers = facts.filter((e) => leftIn(e, from, to));
      const list = async (rows: Fact[], dateOf: (e: Fact) => string) =>
        Promise.all(
          rows.map(async (e) => {
            const s = (await this.summaries(tx, dateOf(e), [e])).get(e.personId);
            return {
              personId: e.personId,
              name: s ? (s.preferredName ?? s.legalName) : '',
              date: dateOf(e),
              department: s?.department?.name ?? null,
            };
          }),
        );
      const joinerList = (await list(joiners, (e) => e.joiningDate)).sort(byDate);
      const leaverList = (await list(leavers, (e) => e.lastWorkingDate!)).sort(byDate);
      const months = [...new Set([...joinerList, ...leaverList].map((p) => p.date.slice(0, 7)))]
        .sort()
        .map((month) => ({
          month,
          joiners: joinerList.filter((p) => p.date.startsWith(month)).length,
          leavers: leaverList.filter((p) => p.date.startsWith(month)).length,
        }));
      return {
        from,
        to,
        joiners: joiners.length,
        leavers: leavers.length,
        months,
        joinersByDepartment: count(joinerList.map((p) => p.department)),
        leaversByDepartment: count(leaverList.map((p) => p.department)),
        joinerList,
        leaverList,
      };
    });
  }

  async attrition(from: string, to: string): Promise<AttritionReport> {
    return this.db.tx(async (tx) => {
      const facts = await this.facts(tx, await this.entities(tx, 'profile'));
      return { from, to, ...attrition(facts, from, to) };
    });
  }

  /**
   * Absenteeism (decision #93): unplanned leave days (applied on or after the first day, incl.
   * retro-applied) plus absent days, ÷ scheduled working days, from the attendance build. Days after
   * yesterday aren't counted: they haven't happened.
   */
  async absenteeism(from: string, to: string): Promise<AbsenteeismReport> {
    this.checkRange(from, to);
    const until = minDate(to, addDays(businessDate(new Date()), -1));
    return this.db.tx(async (tx) => {
      const facts = await this.facts(tx, await this.entities(tx, 'attendance'));
      const ids = facts.map((e) => e.engagementId);
      const rows = ids.length
        ? await tx
            .select({
              engagementId: attendanceDays.engagementId,
              working: sql<number>`count(*) filter (where ${attendanceDays.status} in (${sql.join(
                WORKING_STATUSES.map((s) => sql`${s}`),
                sql`, `,
              )}))`.mapWith(Number),
              absent:
                sql<number>`count(*) filter (where ${attendanceDays.status} = 'absent')`.mapWith(
                  Number,
                ),
            })
            .from(attendanceDays)
            .where(
              and(
                inArray(attendanceDays.engagementId, ids),
                gte(attendanceDays.day, from),
                lte(attendanceDays.day, until),
              ),
            )
            .groupBy(attendanceDays.engagementId)
        : [];
      const unplanned = ids.length
        ? await tx
            .select({
              engagementId: leaveRequestDays.engagementId,
              hundredths: sql<number>`coalesce(sum(${leaveRequestDays.amount}), 0)`.mapWith(Number),
            })
            .from(leaveRequestDays)
            .innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
            .where(
              and(
                inArray(leaveRequestDays.engagementId, ids),
                isNull(leaveRequestDays.cancelledAt),
                eq(leaveRequests.status, 'approved'),
                eq(leaveRequests.unplanned, true),
                gte(leaveRequestDays.day, from),
                lte(leaveRequestDays.day, until),
              ),
            )
            .groupBy(leaveRequestDays.engagementId)
        : [];
      const summaries = await this.summaries(tx, until < from ? from : until, facts);
      const byDept = new Map<string, Omit<AbsenteeismRow, 'name' | 'rate'>>();
      const total = { workingDays: 0, unplannedLeaveDays: 0, absentDays: 0 };
      for (const e of facts) {
        const att = rows.find((r) => r.engagementId === e.engagementId);
        const lv = unplanned.find((r) => r.engagementId === e.engagementId);
        if (!att && !lv) continue;
        const add = {
          workingDays: att?.working ?? 0,
          unplannedLeaveDays: (lv?.hundredths ?? 0) / 100,
          absentDays: att?.absent ?? 0,
        };
        const name = summaries.get(e.personId)?.department?.name ?? 'No department';
        const row = byDept.get(name) ?? { workingDays: 0, unplannedLeaveDays: 0, absentDays: 0 };
        for (const k of Object.keys(add) as (keyof typeof add)[]) {
          row[k] += add[k];
          total[k] += add[k];
        }
        byDept.set(name, row);
      }
      const rate = (r: typeof total) => percent(r.unplannedLeaveDays + r.absentDays, r.workingDays);
      return {
        from,
        to,
        ...total,
        unplannedLeaveDays: round1(total.unplannedLeaveDays),
        rate: rate(total),
        byDepartment: [...byDept.entries()]
          .map(([name, r]) => ({
            name,
            ...r,
            unplannedLeaveDays: round1(r.unplannedLeaveDays),
            rate: rate(r),
          }))
          .sort((a, b) => b.rate - a.rate || a.name.localeCompare(b.name)),
      };
    });
  }

  /**
   * Leave liability (decision #93): balances held at year end by leave type and department; for
   * those who may see pay in an entity, an estimate of encashable leave (days × annual CTC ÷ 365),
   * each pay read audited.
   */
  async leaveLiability(year: number): Promise<LeaveLiabilityReport> {
    const actor = requireContext().actor!;
    return this.db.tx(async (tx) => {
      const entityIds = await this.entities(tx, 'leave');
      const payEntities = new Set<string>();
      for (const id of entityIds) {
        if (
          (await this.authz.check(actor, 'read', { area: 'compensation', legalEntityId: id }))
            .allowed
        ) {
          payEntities.add(id);
        }
      }
      const facts = (await this.facts(tx, entityIds)).filter(
        (e) => e.status === 'active' || e.status === 'on_notice',
      );
      const types = (await this.leave.ensureTypes(tx)).filter(
        (t) => t.active !== false && (t.kind === 'accrued' || t.kind === 'granted'),
      );
      const summaries = await this.summaries(tx, businessDate(new Date()), facts);
      const byType = new Map(types.map((t) => [t.code, 0]));
      const byDept = new Map<string, Record<string, number>>();
      const value = new Map(types.filter((t) => t.encashable).map((t) => [t.code, 0n]));
      let valued = 0;
      for (const e of facts) {
        const dept = summaries.get(e.personId)?.department?.name ?? 'No department';
        const row = byDept.get(dept) ?? {};
        let annual: bigint | null = null;
        let triedPay = false;
        for (const t of types) {
          const days = (await this.leave.balanceOf(tx, e.engagementId, t.id, year)) / 100;
          if (!days) continue;
          byType.set(t.code, (byType.get(t.code) ?? 0) + days);
          row[t.code] = round1((row[t.code] ?? 0) + days);
          if (t.encashable && payEntities.has(e.legalEntityId) && days > 0) {
            if (!triedPay) {
              annual = await this.annualPay(tx, e);
              triedPay = true;
              if (annual !== null) valued += 1;
            }
            if (annual !== null) {
              const paise = (annual * BigInt(Math.round(days * 100))) / 36_500n;
              value.set(t.code, (value.get(t.code) ?? 0n) + paise);
            }
          }
        }
        byDept.set(dept, row);
      }
      const total = [...value.values()].reduce((a, b) => a + b, 0n);
      return {
        year,
        byType: types.map((t) => ({
          code: t.code,
          name: t.name,
          days: round1(byType.get(t.code) ?? 0),
          encashable: t.encashable,
        })),
        byDepartment: [...byDept.entries()]
          .map(([name, days]) => ({ name, days }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        value:
          payEntities.size > 0
            ? {
                paise: total.toString(),
                people: valued,
                byType: [...value.entries()].map(([code, paise]) => ({
                  code,
                  paise: paise.toString(),
                })),
              }
            : null,
      };
    });
  }

  async hybridCompliance(from: string, to: string): Promise<HybridComplianceReport> {
    const actor = requireContext().actor!;
    const allowed = new Set(await this.db.tx((tx) => this.entities(tx, 'hybrid_booking')));
    const monday = (d: string) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
    const view = await this.compliance.forReport(monday(from), monday(to), async (e) =>
      allowed.has(e.legalEntityId)
        ? (
            await this.authz.check(actor, 'read', {
              area: 'hybrid_booking',
              subjectPersonId: e.personId,
              legalEntityId: e.legalEntityId,
            })
          ).allowed
        : false,
    );
    const weeks = view.summary.map((w) => ({
      ...w,
      rate: percent(w.met + w.approvedBelow, w.people),
    }));
    const people = weeks.reduce((n, w) => n + w.people, 0);
    const met = weeks.reduce((n, w) => n + w.met + w.approvedBelow, 0);
    return { from, to, weeks, rate: percent(met, people) };
  }

  /**
   * Seat occupancy (decision #93): office seats booked (confirmed, with a seat) per working day,
   * ÷ the location's active seats; the average over the range and the busiest day.
   */
  async seatOccupancy(from: string, to: string): Promise<SeatOccupancyReport> {
    this.checkRange(from, to);
    return this.db.tx(async (tx) => {
      const entityIds = await this.entities(tx, 'hybrid_booking');
      if (entityIds.length === 0) return { from, to, byLocation: [] };
      const seatRows = await tx
        .select({
          locationId: seats.locationId,
          count: sql<number>`count(*)`.mapWith(Number),
        })
        .from(seats)
        .where(eq(seats.active, true))
        .groupBy(seats.locationId);
      const bookings = await tx
        .select({
          locationId: workBookings.locationId,
          date: workBookings.date,
          count: sql<number>`count(*)`.mapWith(Number),
        })
        .from(workBookings)
        .innerJoin(engagements, eq(engagements.id, workBookings.engagementId))
        .where(
          and(
            inArray(engagements.legalEntityId, entityIds),
            eq(workBookings.status, 'confirmed'),
            eq(workBookings.mode, 'office'),
            sql`${workBookings.seatId} is not null`,
            gte(workBookings.date, from),
            lte(workBookings.date, to),
          ),
        )
        .groupBy(workBookings.locationId, workBookings.date);
      const names = await tx
        .select({ locationId: locationVersions.locationId, name: locationVersions.name })
        .from(locationVersions)
        .where(inForce(locationVersions.effectiveFrom, locationVersions.effectiveTo, to));
      const working = weekdays(from, to);
      return {
        from,
        to,
        byLocation: seatRows
          .map((s) => {
            const mine = bookings.filter((b) => b.locationId === s.locationId);
            const booked = mine.reduce((n, b) => n + b.count, 0);
            const peak = mine.reduce<{ count: number; date: string | null }>(
              (best, b) => (b.count > best.count ? { count: b.count, date: b.date } : best),
              { count: 0, date: null },
            );
            return {
              location: names.find((n) => n.locationId === s.locationId)?.name ?? '',
              seats: s.count,
              workingDays: working,
              bookedSeatDays: booked,
              average: percent(booked, s.count * working),
              peak: percent(peak.count, s.count),
              peakDate: peak.date,
            };
          })
          .sort((a, b) => a.location.localeCompare(b.location)),
      };
    });
  }

  // ---- Shared ----

  /**
   * The legal entities whose data in `area` the user may read entity-wide (HR, HR head, CXO). With
   * none, the report is refused: a manager's own team is on their team screens.
   */
  private async entities(tx: Tx, area: DataArea): Promise<string[]> {
    const actor = requireContext().actor!;
    const all = await tx
      .select({ id: legalEntities.id })
      .from(legalEntities)
      .where(isNull(legalEntities.deletedAt));
    const allowed: string[] = [];
    for (const { id } of all) {
      if ((await this.authz.check(actor, 'read', { area, legalEntityId: id })).allowed)
        allowed.push(id);
    }
    if (allowed.length === 0) throw new ForbiddenException();
    return allowed;
  }

  private async facts(tx: Tx, entityIds: string[]): Promise<Fact[]> {
    const rows = await tx
      .select({
        engagementId: engagements.id,
        personId: engagements.personId,
        legalEntityId: engagements.legalEntityId,
        type: engagements.type,
        status: engagements.status,
        joiningDate: engagements.joiningDate,
        lastWorkingDate: engagements.lastWorkingDate,
        resignationDate: engagements.resignationDate,
        exitReason: engagements.exitReason,
        caseKind: sql<string | null>`(select ${exitCases.kind} from ${exitCases}
          where ${exitCases.engagementId} = ${engagements.id} and ${exitCases.status} = 'exited'
          order by ${exitCases.createdAt} desc limit 1)`,
      })
      .from(engagements)
      .innerJoin(persons, eq(persons.id, engagements.personId))
      .where(and(inArray(engagements.legalEntityId, entityIds), isNull(persons.deletedAt)));
    return rows.map((r) => ({
      engagementId: r.engagementId,
      personId: r.personId,
      legalEntityId: r.legalEntityId,
      type: r.type,
      status: r.status,
      joiningDate: r.joiningDate,
      lastWorkingDate: r.lastWorkingDate,
      exitKind: exitKindOf(r.caseKind, r.resignationDate, r.exitReason),
    }));
  }

  /** Department, location and name as of a date, by person. */
  private async summaries(tx: Tx, asOf: string, facts: Fact[]) {
    if (facts.length === 0) return new Map<string, PersonSummary>();
    const rows = await personSummaries(tx, asOf, { personIds: facts.map((e) => e.personId) });
    return new Map(rows.map((s) => [s.personId, s]));
  }

  /** Annual CTC in paise today, or null when not a yearly or monthly rate (audited read). */
  private async annualPay(tx: Tx, e: Fact): Promise<bigint | null> {
    const today = businessDate(new Date());
    const [row] = await tx
      .select()
      .from(compensations)
      .where(
        and(
          eq(compensations.engagementId, e.engagementId),
          inForce(compensations.effectiveFrom, compensations.effectiveTo, today),
        ),
      )
      .orderBy(desc(compensations.effectiveFrom))
      .limit(1);
    if (!row || (row.rateUnit !== 'year' && row.rateUnit !== 'month')) return null;
    const amount = await this.sensitive.compensation(tx, {
      table: 'compensation',
      column: 'amount_encrypted',
      recordId: row.id,
      stored: row.amountEncrypted,
      subjectPersonId: e.personId,
    });
    return row.rateUnit === 'month' ? amount * 12n : amount;
  }

  private checkRange(from: string, to: string) {
    if (addDays(from, MAX_DAYS) < to) {
      throw new BadRequestException({ message: `Choose up to ${MAX_DAYS} days` });
    }
  }
}

function count(values: (string | null)[]): CountRow[] {
  const map = new Map<string, number>();
  for (const v of values) map.set(v ?? 'Not set', (map.get(v ?? 'Not set') ?? 0) + 1);
  return [...map.entries()]
    .map(([name, n]) => ({ name, count: n }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);
const minDate = (a: string, b: string) => (a < b ? a : b);

/** Monday to Friday in the range (seat occupancy's working days). */
function weekdays(from: string, to: string): number {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) n += 1;
  }
  return n;
}
