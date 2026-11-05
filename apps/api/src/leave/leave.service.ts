import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  toDays,
  toHundredths,
  type LeaveAdjustmentInput,
  type LeaveBalanceView,
  type LeaveImportInput,
  type LeaveImportResult,
  type LeaveTypeInput,
  type LeaveTypeView,
  type LedgerKind,
} from '@ipro/shared';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { assignments, engagements } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { appliesToMatches } from '../workflow/checklist-rules.js';
import { parseCsv } from './csv.js';
import { defaultLeaveTypes, monthlyAccrual, yearEnd } from './leave-rules.js';
import { leaveLedger, leaveTypes } from './leave.schema.js';

type TypeRow = typeof leaveTypes.$inferSelect;
type EngagementRow = typeof engagements.$inferSelect;

const ACCRUING_STATUSES = ['active', 'on_notice', 'exited'] as const;
const IMPORT = 'leave_import';

const lastDay = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
export const previousMonth = (day: string) => addDays(`${day.slice(0, 7)}-01`, -1).slice(0, 7);

function typeView(row: TypeRow): LeaveTypeView {
  const d = (v: number | null) => (v === null ? null : toDays(v));
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    paid: row.paid,
    daysPerYear: d(row.perYear),
    accruesAfterConfirmation: row.accruesAfterConfirmation,
    availableOnProbation: row.availableOnProbation,
    maxBalance: d(row.maxBalance),
    carryForwardCap: d(row.carryForwardCap),
    encashable: row.encashable,
    documentAfterDays: row.documentAfterDays,
    allowNegative: row.allowNegative,
    maxDaysPerRequest: d(row.maxPerRequest),
    expiresAfterDays: row.expiresAfterDays,
    appliesTo: row.appliesTo,
    active: row.active,
    sortOrder: row.sortOrder,
  };
}

function typeValues(input: LeaveTypeInput) {
  const h = (v: number | null) => (v === null ? null : toHundredths(v));
  return {
    name: input.name,
    kind: input.kind,
    paid: input.paid,
    perYear: input.kind === 'accrued' ? h(input.daysPerYear ?? 0) : null,
    accruesAfterConfirmation: input.accruesAfterConfirmation,
    availableOnProbation: input.availableOnProbation,
    maxBalance: h(input.maxBalance),
    carryForwardCap: h(input.carryForwardCap),
    encashable: input.encashable,
    documentAfterDays: input.documentAfterDays,
    allowNegative: input.allowNegative,
    maxPerRequest: h(input.maxDaysPerRequest),
    expiresAfterDays: input.expiresAfterDays,
    appliesTo: input.appliesTo,
    active: input.active,
  };
}

/**
 * Leave types, balances and accrual (slice 7a; decisions #71, #72). Balances are the sum of an
 * add-only ledger; the monthly job credits accruals and closes the year; HR adjusts with a reason
 * and imports balances at cut-over.
 */
@Injectable()
export class LeaveService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PeopleService) private readonly people: PeopleService,
  ) {}

  // ---- Leave types (A2) ----

  async types(): Promise<LeaveTypeView[]> {
    return this.db.tx(async (tx) => (await this.ensureTypes(tx)).map(typeView));
  }

  async createType(input: LeaveTypeInput): Promise<LeaveTypeView> {
    const { actor, tenantId } = requireContext();
    await this.authz.assert(actor!, 'create', { area: 'org_config' });
    return this.db.tx(async (tx) => {
      const existing = await this.ensureTypes(tx);
      if (existing.some((t) => t.code === input.code)) {
        throw new ConflictException({ message: `A leave type ${input.code} exists` });
      }
      const [row] = await tx
        .insert(leaveTypes)
        .values({
          tenantId,
          code: input.code,
          ...typeValues(input),
          sortOrder: existing.length + 1,
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        })
        .returning();
      await this.audit.record(tx, { action: 'create', table: 'leave_type', recordId: row!.id });
      return typeView(row!);
    });
  }

  /** Changes apply from the next accrual; entries already written stand. The code can't change. */
  async updateType(id: string, input: LeaveTypeInput): Promise<LeaveTypeView> {
    const actor = requireContext().actor!;
    await this.authz.assert(actor, 'update', { area: 'org_config' });
    return this.db.tx(async (tx) => {
      const [current] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, id));
      if (!current) throw new NotFoundException();
      if (current.code !== input.code) {
        throw new BadRequestException({ message: 'A leave type’s code can’t change' });
      }
      const [row] = await tx
        .update(leaveTypes)
        .set({ ...typeValues(input), updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(leaveTypes.id, id))
        .returning();
      await this.audit.record(tx, { action: 'update', table: 'leave_type', recordId: id });
      return typeView(row!);
    });
  }

  // ---- Balances (E5, H9) ----

  async balances(personId: string, year: number): Promise<LeaveBalanceView[]> {
    const summary = await this.people.summary(personId);
    const obligations = await this.authz.assert(requireContext().actor!, 'read', {
      area: 'leave',
      subjectPersonId: personId,
      legalEntityId: summary.legalEntityId,
    });
    if (obligations.has('aggregates_only')) throw new ForbiddenException();
    return this.db.tx(async (tx) => {
      const types = await this.ensureTypes(tx);
      const entries = await tx
        .select()
        .from(leaveLedger)
        .where(and(eq(leaveLedger.engagementId, summary.engagementId), eq(leaveLedger.year, year)))
        .orderBy(asc(leaveLedger.entryDate), asc(leaveLedger.createdAt));
      const facts = {
        legalEntityId: summary.legalEntityId,
        engagementType: summary.engagementType,
        departmentId: summary.department?.id ?? null,
        locationId: summary.location?.id ?? null,
      };
      return types
        .filter(
          (t) =>
            (t.active && appliesToMatches(t.appliesTo, facts)) ||
            entries.some((e) => e.leaveTypeId === t.id),
        )
        .map((t) =>
          balanceView(
            t,
            year,
            entries.filter((e) => e.leaveTypeId === t.id),
          ),
        );
    });
  }

  /** HR changes a balance with a reason (permissions table: leave U with reason). */
  async adjust(personId: string, input: LeaveAdjustmentInput): Promise<LeaveBalanceView> {
    const summary = await this.people.summary(personId);
    const actor = requireContext().actor!;
    await this.authz.assert(actor, 'update', {
      area: 'leave',
      subjectPersonId: personId,
      legalEntityId: summary.legalEntityId,
    });
    const today = businessDate(new Date());
    const year = Number(today.slice(0, 4));
    return this.db.tx(async (tx) => {
      const [type] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, input.leaveTypeId));
      if (!type) throw new NotFoundException();
      if (type.kind === 'unlimited' || type.kind === 'per_request') {
        throw new BadRequestException({ message: `${type.name} has no balance to adjust` });
      }
      const amount = toHundredths(input.days);
      const before = await this.balanceOf(tx, summary.engagementId, type.id, year);
      if (before + amount < 0 && !type.allowNegative) {
        throw new BadRequestException({ message: `${type.name} can’t go below zero` });
      }
      const [entry] = await tx
        .insert(leaveLedger)
        .values({
          tenantId: requireContext().tenantId,
          engagementId: summary.engagementId,
          personId,
          leaveTypeId: type.id,
          year,
          entryDate: today,
          kind: 'adjustment',
          amount,
          note: input.reason,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning();
      await this.audit.record(tx, {
        action: 'create',
        table: 'leave_ledger_entry',
        recordId: entry!.id,
        subjectPersonId: personId,
        fieldChanges: [
          { field: type.code, from: String(toDays(before)), to: String(toDays(before + amount)) },
        ],
      });
      const entries = await tx
        .select()
        .from(leaveLedger)
        .where(
          and(
            eq(leaveLedger.engagementId, summary.engagementId),
            eq(leaveLedger.leaveTypeId, type.id),
            eq(leaveLedger.year, year),
          ),
        )
        .orderBy(asc(leaveLedger.entryDate), asc(leaveLedger.createdAt));
      return balanceView(type, year, entries);
    });
  }

  /**
   * Cut-over import (spec migration step 6): sets each balance to the source's value as of a date
   * with an opening entry for the difference. Checked first; applied only when every row is valid;
   * applying again changes nothing. Accruals for months up to the date are then skipped.
   */
  async import(input: LeaveImportInput): Promise<LeaveImportResult> {
    const actor = requireContext().actor!;
    const year = Number(input.asOf.slice(0, 4));
    const result: LeaveImportResult = { committed: false, rows: 0, changes: [], errors: [] };
    let records: Record<string, string>[];
    try {
      records = parseCsv(input.csv);
    } catch (error) {
      throw new BadRequestException({ message: (error as Error).message });
    }
    const header = Object.keys(records[0] ?? {});
    for (const column of ['employee_code', 'leave_type', 'balance']) {
      if (!header.includes(column)) {
        throw new BadRequestException({ message: `The CSV needs a ${column} column` });
      }
    }
    result.rows = records.length;
    return this.db.tx(async (tx) => {
      const types = await this.ensureTypes(tx);
      const codes = [...new Set(records.map((r) => r.employee_code!.trim()))];
      const rows = codes.length
        ? await tx
            .select()
            .from(engagements)
            .where(
              and(
                inArray(engagements.employeeCode, codes),
                inArray(engagements.status, ['pre_joining', 'active', 'on_notice']),
              ),
            )
        : [];
      const byCode = new Map(rows.map((e) => [e.employeeCode, e]));
      const allowed = new Map<string, boolean>();
      const seen = new Set<string>();
      const writes: { engagement: EngagementRow; type: TypeRow; amount: number }[] = [];
      for (const [i, record] of records.entries()) {
        const line = i + 2;
        const code = record.employee_code!.trim();
        const engagement = byCode.get(code);
        const type = types.find((t) => t.code === record.leave_type!.trim().toUpperCase());
        const balance = Number(record.balance!.trim());
        if (!engagement) {
          result.errors.push({ line, message: `No current employee ${code}` });
          continue;
        }
        if (!type) {
          result.errors.push({ line, message: `Unknown leave type ${record.leave_type}` });
          continue;
        }
        if (type.kind === 'unlimited' || type.kind === 'per_request') {
          result.errors.push({ line, message: `${type.code} has no balance` });
          continue;
        }
        if (!Number.isFinite(balance) || !Number.isInteger(balance * 2)) {
          result.errors.push({
            line,
            message: `Balance "${record.balance}" isn’t a whole or half day`,
          });
          continue;
        }
        if (balance < 0 && !type.allowNegative) {
          result.errors.push({ line, message: `${type.code} can’t be negative` });
          continue;
        }
        const key = `${engagement.id}:${type.id}`;
        if (seen.has(key)) {
          result.errors.push({ line, message: `${code} ${type.code} appears twice` });
          continue;
        }
        seen.add(key);
        if (!allowed.has(engagement.personId)) {
          const decision = await this.authz.check(actor, 'update', {
            area: 'leave',
            subjectPersonId: engagement.personId,
            legalEntityId: engagement.legalEntityId,
          });
          allowed.set(engagement.personId, decision.allowed);
        }
        if (!allowed.get(engagement.personId)) {
          result.errors.push({ line, message: `You can’t change ${code}’s leave` });
          continue;
        }
        const current = await this.balanceOf(tx, engagement.id, type.id, year, input.asOf);
        const target = toHundredths(balance);
        if (current !== target) {
          result.changes.push({
            line,
            employeeCode: code,
            leaveType: type.code,
            from: toDays(current),
            to: balance,
          });
          writes.push({ engagement, type, amount: target - current });
        }
      }
      if (!input.commit || result.errors.length > 0) return result;
      for (const w of writes) {
        await tx.insert(leaveLedger).values({
          tenantId: requireContext().tenantId,
          engagementId: w.engagement.id,
          personId: w.engagement.personId,
          leaveTypeId: w.type.id,
          year,
          entryDate: input.asOf,
          kind: 'opening',
          amount: w.amount,
          note: `Imported balance as of ${input.asOf}`,
          sourceTable: IMPORT,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        });
      }
      await this.audit.record(tx, {
        action: 'create',
        table: 'leave_ledger_entry',
        recordId: requireContext().tenantId,
        fieldChanges: [{ field: 'imported_rows', to: String(writes.length) }],
      });
      return { ...result, committed: true };
    });
  }

  // ---- The monthly job (spec: leave accrual, 1st of each month 01:00) ----

  /**
   * Credits one month's accruals to everyone employed in it. Safe to run again: each person, type
   * and month is credited once. Months up to an imported balance are skipped.
   */
  async accrueMonth(month: string): Promise<{ credited: number }> {
    const first = `${month}-01`;
    const last = lastDay(month);
    const year = Number(month.slice(0, 4));
    return this.db.tx(async (tx) => {
      const types = (await this.ensureTypes(tx)).filter((t) => t.active && t.kind === 'accrued');
      const people = await tx
        .select()
        .from(engagements)
        .where(
          and(
            inArray(engagements.status, [...ACCRUING_STATUSES]),
            lte(engagements.joiningDate, last),
            or(isNull(engagements.lastWorkingDate), gte(engagements.lastWorkingDate, first)),
          ),
        );
      const facts = await this.factsOn(tx, people, last);
      const imported = await tx
        .select({ engagementId: leaveLedger.engagementId, leaveTypeId: leaveLedger.leaveTypeId })
        .from(leaveLedger)
        .where(and(eq(leaveLedger.sourceTable, IMPORT), gte(leaveLedger.entryDate, last)));
      const skip = new Set(imported.map((i) => `${i.engagementId}:${i.leaveTypeId}`));
      let credited = 0;
      for (const engagement of people) {
        for (const type of types) {
          if (!appliesToMatches(type.appliesTo, facts.get(engagement.id)!)) continue;
          if (skip.has(`${engagement.id}:${type.id}`)) continue;
          const { amount: raw, note } = monthlyAccrual(
            { perYear: type.perYear!, accruesAfterConfirmation: type.accruesAfterConfirmation },
            {
              joiningDate: engagement.joiningDate,
              lastWorkingDate: engagement.lastWorkingDate,
              confirmationDate: engagement.confirmationDate,
              hasProbation: engagement.probationEndDate !== null,
            },
            month,
          );
          let amount = raw;
          let why = note;
          if (amount > 0 && type.maxBalance !== null) {
            const balance = await this.balanceOf(tx, engagement.id, type.id, year);
            amount = Math.max(0, Math.min(amount, type.maxBalance - balance));
            if (amount < raw) why = `${note}; capped at ${toDays(type.maxBalance)} days`;
          }
          if (amount <= 0) continue;
          const inserted = await tx
            .insert(leaveLedger)
            .values({
              tenantId: requireContext().tenantId,
              engagementId: engagement.id,
              personId: engagement.personId,
              leaveTypeId: type.id,
              year,
              entryDate: last,
              kind: 'accrual',
              amount,
              period: month,
              note: why,
            })
            .onConflictDoNothing()
            .returning({ id: leaveLedger.id });
          credited += inserted.length;
        }
      }
      return { credited };
    });
  }

  /** Year end: up to the carry-forward cap moves into the new year; the rest lapses. Run once. */
  async closeYear(year: number): Promise<{ carried: number; lapsed: number }> {
    return this.db.tx(async (tx) => {
      const types = (await this.ensureTypes(tx)).filter(
        (t) => t.kind === 'accrued' || t.kind === 'granted',
      );
      const totals = await tx
        .select({
          engagementId: leaveLedger.engagementId,
          personId: leaveLedger.personId,
          leaveTypeId: leaveLedger.leaveTypeId,
          balance: sql<number>`sum(${leaveLedger.amount})::int`,
        })
        .from(leaveLedger)
        .where(
          and(
            eq(leaveLedger.year, year),
            inArray(
              leaveLedger.leaveTypeId,
              types.map((t) => t.id),
            ),
          ),
        )
        .groupBy(leaveLedger.engagementId, leaveLedger.personId, leaveLedger.leaveTypeId);
      let carried = 0;
      let lapsed = 0;
      for (const total of totals) {
        const type = types.find((t) => t.id === total.leaveTypeId)!;
        const { carry, lapse } = yearEnd(total.balance, type.carryForwardCap);
        const base = {
          tenantId: requireContext().tenantId,
          engagementId: total.engagementId,
          personId: total.personId,
          leaveTypeId: type.id,
          period: String(year),
        };
        if (lapse > 0) {
          const rows = await tx
            .insert(leaveLedger)
            .values({
              ...base,
              year,
              entryDate: `${year}-12-31`,
              kind: 'lapse',
              amount: -lapse,
              note:
                type.carryForwardCap === 0
                  ? `Year end: ${type.name} doesn’t carry forward`
                  : `Year end: above the ${toDays(type.carryForwardCap!)}-day carry-forward cap`,
            })
            .onConflictDoNothing()
            .returning({ id: leaveLedger.id });
          lapsed += rows.length;
        }
        if (carry !== 0) {
          const rows = await tx
            .insert(leaveLedger)
            .values({
              ...base,
              year: year + 1,
              entryDate: `${year + 1}-01-01`,
              kind: 'carry_forward',
              amount: carry,
              note: `Carried forward from ${year}`,
            })
            .onConflictDoNothing()
            .returning({ id: leaveLedger.id });
          carried += rows.length;
        }
      }
      return { carried, lapsed };
    });
  }

  /**
   * The 1st-of-month job: the month just ended, and the one before it again (it changes nothing if
   * already credited, and picks up a confirmation recorded late); in January, the year is closed.
   */
  async runMonthly(today: string): Promise<{ credited: number; closedYear: number | null }> {
    const last = previousMonth(today);
    const before = previousMonth(`${last}-01`);
    const credited =
      (await this.accrueMonth(before)).credited + (await this.accrueMonth(last)).credited;
    let closedYear: number | null = null;
    if (last.endsWith('-12')) {
      closedYear = Number(last.slice(0, 4));
      await this.closeYear(closedYear);
    }
    return { credited, closedYear };
  }

  // ---- Internals ----

  /** The tenant's leave types, created from the confirmed defaults on first use (race-safe). */
  async ensureTypes(tx: Tx): Promise<TypeRow[]> {
    let rows = await tx.select().from(leaveTypes).orderBy(asc(leaveTypes.sortOrder));
    if (rows.length === 0) {
      await tx
        .insert(leaveTypes)
        .values(
          defaultLeaveTypes.map((t) => ({
            tenantId: requireContext().tenantId,
            code: t.code,
            ...typeValues(t),
            sortOrder: t.sortOrder,
          })),
        )
        .onConflictDoNothing();
      rows = await tx.select().from(leaveTypes).orderBy(asc(leaveTypes.sortOrder));
    }
    return rows;
  }

  /** A year's balance (optionally up to a date) for one person and type. */
  async balanceOf(
    tx: Tx,
    engagementId: string,
    leaveTypeId: string,
    year: number,
    upTo?: string,
  ): Promise<number> {
    const [row] = await tx
      .select({ total: sql<number>`coalesce(sum(${leaveLedger.amount}), 0)::int` })
      .from(leaveLedger)
      .where(
        and(
          eq(leaveLedger.engagementId, engagementId),
          eq(leaveLedger.leaveTypeId, leaveTypeId),
          eq(leaveLedger.year, year),
          upTo ? lte(leaveLedger.entryDate, upTo) : undefined,
        ),
      );
    return row?.total ?? 0;
  }

  /** Who each engagement is on a day, for applies-to rules (entity, type, department, location). */
  private async factsOn(tx: Tx, people: EngagementRow[], day: string) {
    const ids = people.map((p) => p.id);
    const rows = ids.length
      ? await tx
          .select({
            engagementId: assignments.engagementId,
            departmentId: assignments.departmentId,
            locationId: assignments.locationId,
            effectiveFrom: assignments.effectiveFrom,
          })
          .from(assignments)
          .where(inArray(assignments.engagementId, ids))
          .orderBy(asc(assignments.effectiveFrom))
      : [];
    const facts = new Map<string, Parameters<typeof appliesToMatches>[1]>();
    for (const p of people) {
      // The assignment in force on the day, or the last one before it for people who have left.
      const on = p.lastWorkingDate && p.lastWorkingDate < day ? p.lastWorkingDate : day;
      const a = rows.filter((r) => r.engagementId === p.id && r.effectiveFrom <= on).at(-1);
      facts.set(p.id, {
        legalEntityId: p.legalEntityId,
        engagementType: p.type,
        departmentId: a?.departmentId ?? null,
        locationId: a?.locationId ?? null,
      });
    }
    return facts;
  }
}

const sums: Record<
  LedgerKind,
  keyof Omit<LeaveBalanceView, 'leaveType' | 'year' | 'balance' | 'entries'>
> = {
  opening: 'opening',
  carry_forward: 'opening',
  accrual: 'accrued',
  grant: 'granted',
  expiry: 'lapsed',
  lapse: 'lapsed',
  taken: 'taken',
  restored: 'taken',
  encashed: 'encashed',
  adjustment: 'adjusted',
};

function balanceView(
  type: TypeRow,
  year: number,
  entries: (typeof leaveLedger.$inferSelect)[],
): LeaveBalanceView {
  const totals = {
    opening: 0,
    accrued: 0,
    granted: 0,
    taken: 0,
    lapsed: 0,
    encashed: 0,
    adjusted: 0,
  };
  let balance = 0;
  for (const e of entries) {
    totals[sums[e.kind]] += e.amount;
    balance += e.amount;
  }
  return {
    leaveType: { id: type.id, code: type.code, name: type.name, kind: type.kind, paid: type.paid },
    year,
    opening: toDays(totals.opening),
    accrued: toDays(totals.accrued),
    granted: toDays(totals.granted),
    // Shown as positive numbers: days taken, days lapsed, days encashed.
    taken: toDays(-totals.taken),
    lapsed: toDays(-totals.lapsed),
    encashed: toDays(-totals.encashed),
    adjusted: toDays(totals.adjusted),
    balance: toDays(balance),
    entries: entries.map((e) => ({
      id: e.id,
      date: e.entryDate,
      kind: e.kind,
      days: toDays(e.amount),
      note: e.note,
    })),
  };
}
