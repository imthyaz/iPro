import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, ne } from 'drizzle-orm';
import {
  toDays,
  type ChangeLine,
  type LeaveApplyInput,
  type LeavePreview,
  type LeaveRequestView,
  type LeaveRevokeInput,
  type PersonSummary,
} from '@ipro/shared';
import { z } from 'zod';
import { AttendanceService } from '../attendance/attendance.service.js';
import { ShiftsService } from '../attendance/shifts.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { JourneyService } from '../journey/journey.service.js';
import { DocumentsService, type IncomingFile } from '../people/documents.service.js';
import { inForce } from '../people/people.queries.js';
import { assignments, engagements, persons } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { SettingsService } from '../people/settings.service.js';
import { appliesToMatches } from '../workflow/checklist-rules.js';
import { WorkflowActions } from '../workflow/actions.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { leaveLedger, leaveRequestDays, leaveRequests, leaveTypes } from './leave.schema.js';
import { usableBy } from './comp-off-rules.js';
import { LeaveService } from './leave.service.js';
import {
  halvesOverlap,
  planDays,
  splitShortfall,
  totalOf,
  type PlannedDay,
} from './request-rules.js';

type RequestRow = typeof leaveRequests.$inferSelect;
type TypeRow = typeof leaveTypes.$inferSelect;
type EngagementRow = typeof engagements.$inferSelect;

const payloadSchema = z.object({
  leaveRequestId: z.uuid(),
  needsSecondApproval: z.boolean(),
});
const OPEN = ['applied', 'returned'] as const;
const LIVE = ['applied', 'returned', 'approved'] as const;
const WORKING = ['active', 'on_notice'] as const;
const hasBalance = (t: TypeRow) => t.kind === 'accrued' || t.kind === 'granted';

const short = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmt = (iso: string) => short.format(new Date(`${iso}T00:00:00Z`));
const span = (from: string, to: string) => (from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`);
const daysWord = (hundredths: number) =>
  `${toDays(hundredths)} ${hundredths === 100 ? 'day' : 'days'}`;

interface Plan {
  type: TypeRow;
  lopType: TypeRow | null;
  paid: PlannedDay[];
  lop: PlannedDay[];
  preview: LeavePreview;
}

/**
 * Leave requests (spec workflow 4; decision #74): apply with the balance checked (pending leave
 * included), the manager approves and the manager's manager too for long leave, approval debits the
 * balance and marks the days as leave on the attendance calendar; cancelled before it starts by the
 * employee, revoked after by HR, with the days given back.
 */
@Injectable()
export class LeaveRequestsService implements OnModuleInit {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ShiftsService) private readonly shifts: ShiftsService,
    @Inject(AttendanceService) private readonly attendance: AttendanceService,
    @Inject(LeaveService) private readonly leave: LeaveService,
    @Inject(JourneyService) private readonly journey: JourneyService,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(WorkflowActions) private readonly actions: WorkflowActions,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  onModuleInit(): void {
    this.actions.register('leave.approve', {
      validate: (payload) => {
        const parsed = payloadSchema.safeParse(payload);
        if (!parsed.success) throw new BadRequestException({ message: 'Invalid leave request' });
        return parsed.data;
      },
      describe: (tx, instance) =>
        this.describe(tx, payloadSchema.parse(instance.payload).leaveRequestId),
      apply: (tx, instance) =>
        this.approve(tx, payloadSchema.parse(instance.payload).leaveRequestId),
      // Decision #75: leave that needs a medical certificate waits for it at every step.
      readyToApprove: async (tx, instance) => {
        const row = await this.load(tx, payloadSchema.parse(instance.payload).leaveRequestId);
        return row?.needsCertificate && !row.certificateDocumentId
          ? 'Waiting for the medical certificate'
          : null;
      },
      onStatus: async (tx, instance, status) => {
        if (status === 'approved') return;
        const id = payloadSchema.parse(instance.payload).leaveRequestId;
        await tx
          .update(leaveRequests)
          .set({ status: status === 'pending' ? 'applied' : status, updatedAt: new Date() })
          .where(eq(leaveRequests.id, id));
        if (status === 'withdrawn') {
          await tx
            .update(leaveRequestDays)
            .set({ cancelledAt: new Date() })
            .where(and(eq(leaveRequestDays.requestId, id), isNull(leaveRequestDays.cancelledAt)));
        }
      },
    });
  }

  // ---- E4: apply ----

  /** What the request would be: days, balance after, loss of pay, warnings. Nothing is saved. */
  async preview(input: LeaveApplyInput, now = new Date()): Promise<LeavePreview> {
    const summary = await this.self('create');
    return this.db.tx(async (tx) => (await this.plan(tx, summary, input, now)).preview);
  }

  async apply(input: LeaveApplyInput, now = new Date()): Promise<LeaveRequestView> {
    const summary = await this.self('create');
    const actor = requireContext().actor!;
    return this.db.tx(async (tx) => {
      const plan = await this.plan(tx, summary, input, now);
      if (plan.preview.problems.length) {
        throw new BadRequestException({
          message: plan.preview.problems[0],
          problems: plan.preview.problems,
          shortfall: plan.preview.shortfall,
        });
      }
      const all = [...plan.paid, ...plan.lop];
      const [row] = await tx
        .insert(leaveRequests)
        .values({
          tenantId: requireContext().tenantId,
          engagementId: summary.engagementId,
          personId: summary.personId,
          leaveTypeId: plan.type.id,
          fromDate: input.from,
          toDate: input.to,
          startHalf: input.startHalf ?? 'full',
          endHalf: input.endHalf ?? 'full',
          days: totalOf(all),
          lopDays: totalOf(plan.lop),
          reason: input.reason || null,
          status: 'applied',
          unplanned: plan.preview.unplanned,
          needsCertificate: plan.preview.needsCertificate,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning();
      const dayRow = (d: PlannedDay, typeId: string) => ({
        tenantId: requireContext().tenantId,
        requestId: row!.id,
        engagementId: summary.engagementId,
        personId: summary.personId,
        day: d.day,
        half: d.half,
        leaveTypeId: typeId,
        amount: d.amount,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
      await tx
        .insert(leaveRequestDays)
        .values([
          ...plan.paid.map((d) => dayRow(d, plan.type.id)),
          ...plan.lop.map((d) => dayRow(d, plan.lopType!.id)),
        ]);
      const instanceId = await this.workflows.submit(tx, {
        key: 'leave_request',
        subjectPersonId: summary.personId,
        title: `${plan.type.name}: ${summary.preferredName ?? summary.legalName}, ${span(
          input.from,
          input.to,
        )} (${daysWord(totalOf(all))})`,
        payload: {
          leaveRequestId: row!.id,
          needsSecondApproval: plan.preview.needsSecondApproval,
        },
      });
      await tx
        .update(leaveRequests)
        .set({ workflowInstanceId: instanceId })
        .where(eq(leaveRequests.id, row!.id));
      return this.view(tx, (await this.load(tx, row!.id))!, now);
    });
  }

  // ---- E5 and the person record ----

  async mine(year: number): Promise<LeaveRequestView[]> {
    const summary = await this.self('read');
    return this.list(summary.personId, year);
  }

  async forPerson(personId: string, year: number): Promise<LeaveRequestView[]> {
    const summary = await this.people.summary(personId);
    const obligations = await this.authz.assert(requireContext().actor!, 'read', {
      area: 'leave',
      subjectPersonId: personId,
      legalEntityId: summary.legalEntityId,
    });
    if (obligations.has('aggregates_only')) throw new ForbiddenException();
    return this.list(personId, year);
  }

  /** The employee cancels before the leave starts (spec); started leave is revoked by HR. */
  async cancel(id: string, now = new Date()): Promise<LeaveRequestView> {
    const actor = requireContext().actor!;
    const today = businessDate(now);
    return this.db.tx(async (tx) => {
      const row = await this.load(tx, id);
      if (!row) throw new NotFoundException();
      const summary = await this.people.summary(row.personId);
      await this.authz.assert(actor, 'cancel', {
        area: 'leave',
        subjectPersonId: row.personId,
        legalEntityId: summary.legalEntityId,
      });
      if (OPEN.includes(row.status as (typeof OPEN)[number])) {
        if (row.workflowInstanceId) await this.workflows.cancelIn(tx, row.workflowInstanceId);
      } else if (row.status === 'approved') {
        if (row.fromDate <= today) {
          throw new BadRequestException({
            message: 'This leave has started; ask HR to give back the remaining days',
          });
        }
        await this.giveBack(tx, row, row.fromDate, 'cancelled', now);
        await tx
          .update(leaveRequests)
          .set({ status: 'cancelled', updatedAt: now, updatedBy: actor.userId })
          .where(eq(leaveRequests.id, id));
        await this.record(tx, row, 'leave_cancelled', 'Leave cancelled', today);
      } else {
        throw new BadRequestException({ message: 'This request is already closed' });
      }
      return this.view(tx, (await this.load(tx, id))!, now);
    });
  }

  /** HR gives back the days from a date, with a reason (spec: revoked after start, HR only). */
  async revoke(id: string, input: LeaveRevokeInput, now = new Date()): Promise<LeaveRequestView> {
    const actor = requireContext().actor!;
    const today = businessDate(now);
    return this.db.tx(async (tx) => {
      const row = await this.load(tx, id);
      if (!row) throw new NotFoundException();
      const summary = await this.people.summary(row.personId);
      await this.authz.assert(actor, 'update', {
        area: 'leave',
        subjectPersonId: row.personId,
        legalEntityId: summary.legalEntityId,
      });
      if (row.status !== 'approved') {
        throw new BadRequestException({ message: 'Only approved leave can be revoked' });
      }
      if (input.from < row.fromDate || input.from > row.toDate) {
        throw new BadRequestException({ message: 'Choose a day within the leave' });
      }
      const all = input.from === row.fromDate;
      await this.giveBack(tx, row, input.from, 'revoked', now);
      await tx
        .update(leaveRequests)
        .set({
          status: all ? 'revoked' : 'approved',
          revokedFrom: input.from,
          revokeReason: input.reason,
          updatedAt: now,
          updatedBy: actor.userId,
        })
        .where(eq(leaveRequests.id, id));
      await this.audit.record(tx, {
        action: 'update',
        table: 'leave_request',
        recordId: id,
        subjectPersonId: row.personId,
        fieldChanges: [{ field: 'revoked_from', to: input.from }],
      });
      await this.record(
        tx,
        row,
        'leave_revoked',
        all ? 'Leave revoked' : `Leave shortened: back from ${fmt(input.from)}`,
        today,
      );
      return this.view(tx, (await this.load(tx, id))!, now);
    });
  }

  /** A medical certificate for the request, kept confidential: the manager sees only that it's there. */
  async attachCertificate(id: string, file: IncomingFile | undefined, now = new Date()) {
    const actor = requireContext().actor!;
    const row = await this.db.tx((tx) => this.load(tx, id));
    if (!row) throw new NotFoundException();
    const summary = await this.people.summary(row.personId);
    const resource = {
      area: 'leave' as const,
      subjectPersonId: row.personId,
      legalEntityId: summary.legalEntityId,
    };
    const asHr = (await this.authz.check(actor, 'update', resource)).allowed;
    if (!asHr) await this.authz.assert(actor, 'create', resource);
    const document = await this.documents.store(row.personId, file, {
      type: 'certificate',
      title: `Medical certificate, leave ${span(row.fromDate, row.toDate)}`,
      confidential: true,
    });
    return this.db.tx(async (tx) => {
      await tx
        .update(leaveRequests)
        .set({ certificateDocumentId: document.id, updatedAt: now, updatedBy: actor.userId })
        .where(eq(leaveRequests.id, id));
      return this.view(tx, (await this.load(tx, id))!, now);
    });
  }

  // ---- Internals ----

  private async self(action: 'create' | 'read') {
    const actor = requireContext().actor!;
    if (!actor.personId) throw new ForbiddenException();
    const summary = await this.people.summary(actor.personId);
    await this.authz.assert(actor, action, {
      area: 'leave',
      subjectPersonId: summary.personId,
      legalEntityId: summary.legalEntityId,
    });
    return summary;
  }

  /** Checks the request against the rules and balances, and works out its days. */
  private async plan(
    tx: Tx,
    summary: PersonSummary,
    input: LeaveApplyInput,
    now: Date,
  ): Promise<Plan> {
    const today = businessDate(now);
    const problems: string[] = [];
    const types = await this.leave.ensureTypes(tx);
    const type = types.find((t) => t.id === input.leaveTypeId && t.active);
    if (!type) throw new BadRequestException({ message: 'Choose a leave type' });
    const lopType = types.find((t) => t.kind === 'unlimited' && t.active) ?? null;
    const [engagement] = await tx
      .select()
      .from(engagements)
      .where(eq(engagements.id, summary.engagementId));
    const facts = {
      legalEntityId: summary.legalEntityId,
      engagementType: summary.engagementType,
      departmentId: summary.department?.id ?? null,
      locationId: summary.location?.id ?? null,
    };
    if (!appliesToMatches(type.appliesTo, facts))
      problems.push(`${type.name} doesn’t apply to you`);
    if (!engagement || !WORKING.includes(engagement.status as (typeof WORKING)[number])) {
      problems.push('Leave is for people currently employed');
    }
    const backdate = await this.settings.get(tx, 'leave_backdate_days');
    if (input.from < addDays(today, -backdate)) {
      problems.push(`Leave can be applied up to ${backdate} days back; ask HR for older days`);
    }
    if (input.to > addDays(today, 365)) problems.push('Leave can be applied up to a year ahead');
    if (engagement && input.from < engagement.joiningDate)
      problems.push('That is before you joined');
    if (engagement?.lastWorkingDate && input.to > engagement.lastWorkingDate) {
      problems.push('That is after your last working day');
    }
    if (
      !type.availableOnProbation &&
      engagement?.probationEndDate &&
      (!engagement.confirmationDate || engagement.confirmationDate > input.from)
    ) {
      problems.push(`${type.name} can’t be taken during probation`);
    }
    const calendar = await this.shifts.calendarForEngagement(tx, summary.engagementId);
    let days: PlannedDay[] = [];
    try {
      days = planDays({
        from: input.from,
        to: input.to,
        startHalf: input.startHalf ?? 'full',
        endHalf: input.endHalf ?? 'full',
        countsCalendarDays: type.countsCalendarDays,
        isWorking: calendar.isWorking,
      });
    } catch (error) {
      problems.push((error as Error).message);
    }
    if (days.length === 0 && problems.length === 0) {
      problems.push('There are no working days in these dates');
    }
    const clash = await this.clash(tx, summary.engagementId, days);
    if (clash) problems.push(`You already have leave on ${fmt(clash)}`);
    const total = totalOf(days);
    if (type.kind === 'per_request' && type.maxPerRequest !== null && total > type.maxPerRequest) {
      problems.push(`${type.name} is up to ${daysWord(type.maxPerRequest)} a request`);
    }

    let paid = days;
    const lop: PlannedDay[] = [];
    let balanceBefore: number | null = null;
    let balanceAfter: number | null = null;
    let shortfall = 0;
    if (type.kind === 'granted' && days.length) {
      // Comp-off runs out by grant (decision #76): only grants still valid on the last day count.
      const available = await this.usableGrants(tx, summary.engagementId, type.id, input.to);
      balanceBefore = available;
      const split = type.allowNegative ? { paid: days, lop: [] } : splitShortfall(days, available);
      paid = split.paid;
      lop.push(...split.lop);
      shortfall = totalOf(lop);
      balanceAfter = balanceBefore - totalOf(paid);
      if (shortfall > 0) {
        if (!lopType) problems.push(`Not enough ${type.name}`);
        else if (!input.lopForShortfall) {
          problems.push(
            `You have ${daysWord(balanceBefore)} of ${type.name} usable by ${fmt(input.to)}; ${daysWord(shortfall)} would be loss of pay`,
          );
        }
      }
    } else if (hasBalance(type) && days.length) {
      const years = [...new Set(days.map((d) => d.day.slice(0, 4)))].sort();
      paid = [];
      for (const year of years) {
        const inYear = days.filter((d) => d.day.startsWith(year));
        const available = await this.available(tx, summary.engagementId, type.id, Number(year));
        if (balanceBefore === null) balanceBefore = available;
        if (type.allowNegative) {
          paid.push(...inYear);
          continue;
        }
        const split = splitShortfall(inYear, available);
        paid.push(...split.paid);
        lop.push(...split.lop);
      }
      shortfall = totalOf(lop);
      balanceAfter = balanceBefore! - totalOf(paid.filter((d) => d.day.startsWith(years[0]!)));
      if (shortfall > 0) {
        if (!lopType) problems.push(`Not enough ${type.name}`);
        else if (!input.lopForShortfall) {
          problems.push(
            `You have ${daysWord(balanceBefore!)} of ${type.name}; ${daysWord(shortfall)} would be loss of pay`,
          );
        }
      }
    }
    const secondOver = await this.settings.get(tx, 'leave_second_approval_over_days');
    const preview: LeavePreview = {
      days: toDays(total),
      fromType: toDays(totalOf(paid)),
      lop: toDays(totalOf(lop)),
      balanceBefore: balanceBefore === null ? null : toDays(balanceBefore),
      balanceAfter: balanceAfter === null ? null : toDays(balanceAfter),
      shortfall: toDays(shortfall),
      needsSecondApproval: total > secondOver * 100,
      unplanned: input.from <= today,
      needsCertificate: type.documentAfterDays !== null && total > type.documentAfterDays * 100,
      problems,
    };
    return { type, lopType, paid, lop, preview };
  }

  /** The balance less leave asked for and not yet decided (it isn't debited until approval). */
  private async available(tx: Tx, engagementId: string, typeId: string, year: number) {
    const balance = await this.leave.balanceOf(tx, engagementId, typeId, year);
    const held = await tx
      .select({ amount: leaveRequestDays.amount, day: leaveRequestDays.day })
      .from(leaveRequestDays)
      .innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
      .where(
        and(
          eq(leaveRequestDays.engagementId, engagementId),
          eq(leaveRequestDays.leaveTypeId, typeId),
          isNull(leaveRequestDays.cancelledAt),
          inArray(leaveRequests.status, [...OPEN]),
          gte(leaveRequestDays.day, `${year}-01-01`),
          lte(leaveRequestDays.day, `${year}-12-31`),
        ),
      );
    return balance - totalOf(held);
  }

  /** Comp-off usable by a day: the balance less undecided requests, without grants run out by then. */
  private async usableGrants(tx: Tx, engagementId: string, typeId: string, by: string) {
    const { balance, grants } = await this.leave.grantPosition(tx, engagementId, typeId);
    const pending = await this.leave.pendingDays(tx, engagementId, typeId);
    return usableBy(grants, balance - pending, by);
  }

  /** The first day that overlaps leave already asked for or approved. */
  private async clash(tx: Tx, engagementId: string, days: PlannedDay[]): Promise<string | null> {
    if (days.length === 0) return null;
    const existing = await tx
      .select({ day: leaveRequestDays.day, half: leaveRequestDays.half })
      .from(leaveRequestDays)
      .innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
      .where(
        and(
          eq(leaveRequestDays.engagementId, engagementId),
          isNull(leaveRequestDays.cancelledAt),
          inArray(leaveRequests.status, [...LIVE]),
          gte(leaveRequestDays.day, days[0]!.day),
          lte(leaveRequestDays.day, days.at(-1)!.day),
        ),
      );
    for (const d of days) {
      if (existing.some((e) => e.day === d.day && halvesOverlap(e.half, d.half))) return d.day;
    }
    return null;
  }

  /** On final approval: debit the balance, mark the days on the calendar, write the journey. */
  private async approve(tx: Tx, id: string): Promise<void> {
    const now = new Date();
    const row = await this.load(tx, id);
    if (!row || row.status !== 'applied') return;
    const days = await this.activeDays(tx, id);
    const types = await this.leave.ensureTypes(tx);
    for (const [key, group] of groupByTypeYear(days)) {
      const [typeId, year] = key.split(':') as [string, string];
      const type = types.find((t) => t.id === typeId)!;
      if (!hasBalance(type)) continue;
      await tx.insert(leaveLedger).values({
        tenantId: requireContext().tenantId,
        engagementId: row.engagementId,
        personId: row.personId,
        leaveTypeId: typeId,
        year: Number(year),
        entryDate: group[0]!.day,
        kind: 'taken',
        amount: -totalOf(group),
        note: `Leave ${span(group[0]!.day, group.at(-1)!.day)}`,
        sourceTable: 'leave_request',
        sourceId: id,
      });
    }
    await tx
      .update(leaveRequests)
      .set({ status: 'approved', decidedAt: now, updatedAt: now })
      .where(eq(leaveRequests.id, id));
    const type = types.find((t) => t.id === row.leaveTypeId)!;
    await this.record(
      tx,
      row,
      'leave_approved',
      `${type.name}, ${span(row.fromDate, row.toDate)} (${daysWord(row.days)})`,
      row.fromDate,
    );
    await this.rebuild(tx, row, days, now);
  }

  /** Gives back the days from a date: restored to the balance, off the calendar. */
  private async giveBack(
    tx: Tx,
    row: RequestRow,
    from: string,
    why: 'cancelled' | 'revoked',
    now: Date,
  ): Promise<void> {
    const days = (await this.activeDays(tx, row.id)).filter((d) => d.day >= from);
    if (days.length === 0) return;
    await tx
      .update(leaveRequestDays)
      .set({ cancelledAt: now })
      .where(
        inArray(
          leaveRequestDays.id,
          days.map((d) => d.id),
        ),
      );
    const types = await this.leave.ensureTypes(tx);
    for (const [key, group] of groupByTypeYear(days)) {
      const [typeId, year] = key.split(':') as [string, string];
      if (!hasBalance(types.find((t) => t.id === typeId)!)) continue;
      await tx.insert(leaveLedger).values({
        tenantId: requireContext().tenantId,
        engagementId: row.engagementId,
        personId: row.personId,
        leaveTypeId: typeId,
        year: Number(year),
        entryDate: businessDate(now),
        kind: 'restored',
        amount: totalOf(group),
        note: `Leave ${why}: ${span(group[0]!.day, group.at(-1)!.day)}`,
        sourceTable: 'leave_request',
        sourceId: row.id,
      });
    }
    await this.rebuild(tx, row, days, now);
  }

  /** Past and today's days are rebuilt now; later ones are built on the day. */
  private async rebuild(tx: Tx, row: RequestRow, days: { day: string }[], now: Date) {
    const today = businessDate(now);
    const [engagement] = await tx
      .select()
      .from(engagements)
      .where(eq(engagements.id, row.engagementId));
    for (const day of new Set(days.map((d) => d.day))) {
      if (day <= today) await this.attendance.rebuild(tx, engagement as EngagementRow, day, now);
    }
  }

  private async record(tx: Tx, row: RequestRow, eventType: string, title: string, on: string) {
    await this.journey.record(tx, {
      engagementId: row.engagementId,
      personId: row.personId,
      eventType,
      category: 'leave',
      occurredOn: on,
      isPlanned: on > businessDate(new Date()),
      title,
      detail: { from: row.fromDate, to: row.toDate, days: toDays(row.days) },
      sensitivity: 'manager',
      sourceTable: 'leave_request',
      sourceId: row.id,
    });
  }

  /** The approval card (CLAUDE.md: decide on the card): the leave, balance after, who else is off, fit. */
  private async describe(tx: Tx, id: string): Promise<ChangeLine[]> {
    const row = await this.load(tx, id);
    if (!row) return [];
    const types = await this.leave.ensureTypes(tx);
    const type = types.find((t) => t.id === row.leaveTypeId)!;
    const days = await this.activeDays(tx, id);
    const paid = days.filter((d) => d.leaveTypeId === type.id);
    const lines: ChangeLine[] = [
      {
        label: 'Leave',
        from: null,
        to: `${type.name}, ${span(row.fromDate, row.toDate)} (${daysWord(row.days)})${
          row.startHalf === 'second' ? ', from the afternoon' : ''
        }${row.endHalf === 'first' ? ', until midday' : ''}`,
      },
    ];
    if (type.kind === 'granted') {
      const { balance } = await this.leave.grantPosition(tx, row.engagementId, type.id);
      lines.push({
        label: `${type.name} balance`,
        from: String(toDays(balance)),
        to: String(toDays(balance - totalOf(paid))),
      });
    } else if (hasBalance(type)) {
      const year = Number(row.fromDate.slice(0, 4));
      const balance = await this.leave.balanceOf(tx, row.engagementId, type.id, year);
      lines.push({
        label: `${type.name} balance`,
        from: String(toDays(balance)),
        to: String(toDays(balance - totalOf(paid.filter((d) => d.day.startsWith(String(year)))))),
      });
    }
    if (row.lopDays > 0)
      lines.push({ label: 'Loss of pay', from: null, to: daysWord(row.lopDays) });
    lines.push({ label: 'Also off', from: null, to: await this.alsoOff(tx, row) });
    const fit: string[] = [];
    const lead = Math.round(
      (Date.parse(`${row.fromDate}T00:00:00Z`) -
        Date.parse(`${row.createdAt.toISOString().slice(0, 10)}T00:00:00Z`)) /
        86_400_000,
    );
    fit.push(
      row.unplanned
        ? 'Unplanned: applied on or after the first day'
        : `Planned, ${lead} days ahead`,
    );
    if (row.needsCertificate) {
      fit.push(
        row.certificateDocumentId
          ? 'Medical certificate attached'
          : 'Medical certificate needed: approval waits for it',
      );
    }
    if (row.reason) fit.push(`Reason: ${row.reason}`);
    lines.push({ label: 'Policy', from: null, to: fit.join(' · ') });
    return lines;
  }

  /** Others in the same team (same manager then) with leave asked for or approved on these days. */
  private async alsoOff(tx: Tx, row: RequestRow): Promise<string> {
    const [mine] = await tx
      .select({ manager: assignments.managerEngagementId })
      .from(assignments)
      .where(
        and(
          eq(assignments.engagementId, row.engagementId),
          inForce(assignments.effectiveFrom, assignments.effectiveTo, row.fromDate),
        ),
      );
    if (!mine?.manager) return 'No team on record';
    const team = await tx
      .select({ engagementId: assignments.engagementId })
      .from(assignments)
      .where(
        and(
          eq(assignments.managerEngagementId, mine.manager),
          inForce(assignments.effectiveFrom, assignments.effectiveTo, row.fromDate),
          ne(assignments.engagementId, row.engagementId),
        ),
      );
    if (team.length === 0) return 'No one else in the team';
    const off = await tx
      .select({
        personId: leaveRequestDays.personId,
        day: leaveRequestDays.day,
        name: persons.preferredName,
        legalName: persons.legalName,
        status: leaveRequests.status,
      })
      .from(leaveRequestDays)
      .innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
      .innerJoin(persons, eq(persons.id, leaveRequestDays.personId))
      .where(
        and(
          inArray(
            leaveRequestDays.engagementId,
            team.map((t) => t.engagementId),
          ),
          isNull(leaveRequestDays.cancelledAt),
          inArray(leaveRequests.status, ['applied', 'approved']),
          gte(leaveRequestDays.day, row.fromDate),
          lte(leaveRequestDays.day, row.toDate),
        ),
      )
      .orderBy(asc(leaveRequestDays.day));
    if (off.length === 0) return `No one else in the team (${team.length + 1} people)`;
    const byPerson = new Map<string, { name: string; days: string[]; asked: boolean }>();
    for (const o of off) {
      const entry = byPerson.get(o.personId) ?? {
        name: o.name ?? o.legalName,
        days: [],
        asked: false,
      };
      entry.days.push(o.day);
      entry.asked ||= o.status === 'applied';
      byPerson.set(o.personId, entry);
    }
    const names = [...byPerson.values()].map(
      (p) => `${p.name} (${span(p.days[0]!, p.days.at(-1)!)}${p.asked ? ', asked' : ''})`,
    );
    return `${names.length} of ${team.length + 1}: ${names.slice(0, 4).join(', ')}${
      names.length > 4 ? ` and ${names.length - 4} more` : ''
    }`;
  }

  private async list(personId: string, year: number): Promise<LeaveRequestView[]> {
    return this.db.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(leaveRequests)
        .where(
          and(
            eq(leaveRequests.personId, personId),
            lte(leaveRequests.fromDate, `${year}-12-31`),
            gte(leaveRequests.toDate, `${year}-01-01`),
          ),
        )
        .orderBy(asc(leaveRequests.fromDate));
      const now = new Date();
      const views: LeaveRequestView[] = [];
      for (const r of rows.reverse()) views.push(await this.view(tx, r, now));
      return views;
    });
  }

  private async view(tx: Tx, row: RequestRow, now: Date): Promise<LeaveRequestView> {
    const [type] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, row.leaveTypeId));
    const today = businessDate(now);
    const actor = requireContext().actor;
    const own = actor?.personId === row.personId;
    return {
      id: row.id,
      personId: row.personId,
      leaveType: { id: type!.id, code: type!.code, name: type!.name },
      from: row.fromDate,
      to: row.toDate,
      startHalf: row.startHalf,
      endHalf: row.endHalf,
      days: toDays(row.days),
      lop: toDays(row.lopDays),
      reason: row.reason,
      status: row.status,
      unplanned: row.unplanned,
      certificateAttached: row.certificateDocumentId !== null,
      needsCertificate: row.needsCertificate,
      requestId: row.workflowInstanceId,
      revokedFrom: row.revokedFrom,
      canCancel:
        own &&
        (OPEN.includes(row.status as (typeof OPEN)[number]) ||
          (row.status === 'approved' && row.fromDate > today)),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async load(tx: Tx, id: string): Promise<RequestRow | undefined> {
    const [row] = await tx.select().from(leaveRequests).where(eq(leaveRequests.id, id));
    return row;
  }

  private activeDays(tx: Tx, requestId: string) {
    return tx
      .select()
      .from(leaveRequestDays)
      .where(and(eq(leaveRequestDays.requestId, requestId), isNull(leaveRequestDays.cancelledAt)))
      .orderBy(asc(leaveRequestDays.day), asc(leaveRequestDays.half));
  }
}

function groupByTypeYear<T extends { leaveTypeId: string; day: string; amount: number }>(
  days: T[],
) {
  const groups = new Map<string, T[]>();
  for (const d of days) {
    const key = `${d.leaveTypeId}:${d.day.slice(0, 4)}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return groups;
}
