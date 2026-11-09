import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import {
  toDays,
  toHundredths,
  type ChangeLine,
  type CompOffRequestInput,
  type CompOffRequestView,
} from '@ipro/shared';
import { z } from 'zod';
import { attendanceDays } from '../attendance/attendance.schema.js';
import { ShiftsService } from '../attendance/shifts.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { JourneyService } from '../journey/journey.service.js';
import { engagements } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { SettingsService } from '../people/settings.service.js';
import { appliesToMatches } from '../workflow/checklist-rules.js';
import { WorkflowActions } from '../workflow/actions.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { expiryNote, heldByGrant, shortDate, validUntil } from './comp-off-rules.js';
import { compOffRequests, leaveLedger } from './leave.schema.js';
import { LeaveService } from './leave.service.js';

type Row = typeof compOffRequests.$inferSelect;

const payloadSchema = z.object({ compOffRequestId: z.uuid() });
const OPEN = ['applied', 'returned'] as const;
const WORKING = ['active', 'on_notice'] as const;
const WEEKLY_OFF = 'Weekly off';

const daysWord = (hundredths: number) =>
  `${toDays(hundredths)} ${hundredths === 100 ? 'day' : 'days'}`;
const dayWords = (row: Pick<Row, 'workedOn' | 'dayKind'>) =>
  `${shortDate(row.workedOn)} (${row.dayKind === WEEKLY_OFF ? 'weekly off' : `holiday: ${row.dayKind}`})`;
const timeIndia = (at: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);

/**
 * Comp-off (decisions #71, #73, #76). The employee asks for a weekly off or holiday they worked,
 * within the window; their manager approves on a card that shows the day's attendance; the day or
 * half day is granted, usable for the type's expiry days. The daily job expires what is left.
 */
@Injectable()
export class CompOffService implements OnModuleInit {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ShiftsService) private readonly shifts: ShiftsService,
    @Inject(LeaveService) private readonly leave: LeaveService,
    @Inject(JourneyService) private readonly journey: JourneyService,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(WorkflowActions) private readonly actions: WorkflowActions,
  ) {}

  onModuleInit(): void {
    this.actions.register('leave.grant_comp_off', {
      bulk: true,
      records: ['comp_off_granted'],
      validate: (payload) => {
        const parsed = payloadSchema.safeParse(payload);
        if (!parsed.success) throw new BadRequestException({ message: 'Invalid comp-off request' });
        return parsed.data;
      },
      describe: (tx, instance) =>
        this.describe(tx, payloadSchema.parse(instance.payload).compOffRequestId),
      apply: (tx, instance) =>
        this.grant(tx, payloadSchema.parse(instance.payload).compOffRequestId),
      onStatus: async (tx, instance, status) => {
        if (status === 'approved') return;
        await tx
          .update(compOffRequests)
          .set({ status: status === 'pending' ? 'applied' : status, updatedAt: new Date() })
          .where(eq(compOffRequests.id, payloadSchema.parse(instance.payload).compOffRequestId));
      },
    });
  }

  // ---- The employee ----

  async request(input: CompOffRequestInput, now = new Date()): Promise<CompOffRequestView> {
    const actor = requireContext().actor!;
    if (!actor.personId) throw new ForbiddenException();
    const summary = await this.people.summary(actor.personId);
    await this.authz.assert(actor, 'create', {
      area: 'leave',
      subjectPersonId: summary.personId,
      legalEntityId: summary.legalEntityId,
    });
    const today = businessDate(now);
    const day = input.workedOn;
    return this.db.tx(async (tx) => {
      const type = (await this.leave.ensureTypes(tx)).find(
        (t) =>
          t.kind === 'granted' &&
          t.active &&
          appliesToMatches(t.appliesTo, {
            legalEntityId: summary.legalEntityId,
            engagementType: summary.engagementType,
            departmentId: summary.department?.id ?? null,
            locationId: summary.location?.id ?? null,
          }),
      );
      if (!type) throw new BadRequestException({ message: 'Comp-off doesn’t apply to you' });
      const [engagement] = await tx
        .select()
        .from(engagements)
        .where(eq(engagements.id, summary.engagementId));
      if (!engagement || !WORKING.includes(engagement.status as (typeof WORKING)[number])) {
        throw new BadRequestException({ message: 'Comp-off is for people currently employed' });
      }
      if (day > today) {
        throw new BadRequestException({ message: 'Ask for comp-off after the day you worked' });
      }
      if (day < engagement.joiningDate) {
        throw new BadRequestException({ message: 'That day is before you joined' });
      }
      const window = await this.settings.get(tx, 'comp_off_request_window_days');
      if (addDays(day, window) < today) {
        throw new BadRequestException({
          message: `Comp-off can be asked for up to ${window} days after the day worked; ask HR for older days`,
        });
      }
      const calendar = await this.shifts.calendarForEngagement(tx, engagement.id);
      if (calendar.isWorking(day)) {
        throw new BadRequestException({
          message: 'Comp-off is for a weekly off or holiday you worked',
        });
      }
      const holiday = calendar.dayOn(day).holiday;
      const [taken] = await tx
        .select({ id: compOffRequests.id })
        .from(compOffRequests)
        .where(
          and(
            eq(compOffRequests.engagementId, engagement.id),
            eq(compOffRequests.workedOn, day),
            inArray(compOffRequests.status, ['applied', 'returned', 'approved']),
          ),
        );
      if (taken) {
        throw new ConflictException({
          message: 'There is already a comp-off request for this day',
        });
      }
      const [row] = await tx
        .insert(compOffRequests)
        .values({
          tenantId: requireContext().tenantId,
          engagementId: engagement.id,
          personId: summary.personId,
          leaveTypeId: type.id,
          workedOn: day,
          dayKind: holiday && !holiday.optional ? holiday.name : WEEKLY_OFF,
          amount: toHundredths(input.days),
          reason: input.reason || null,
          status: 'applied',
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning();
      const instanceId = await this.workflows.submit(tx, {
        key: 'comp_off_request',
        subjectPersonId: summary.personId,
        title: `Comp-off: ${summary.preferredName ?? summary.legalName}, worked ${shortDate(day)}`,
        payload: { compOffRequestId: row!.id },
      });
      await tx
        .update(compOffRequests)
        .set({ workflowInstanceId: instanceId })
        .where(eq(compOffRequests.id, row!.id));
      return view((await this.load(tx, row!.id))!, actor.personId);
    });
  }

  /** E5: my comp-off requests worked in a year, and grants from earlier still valid in it. */
  async mine(year: number): Promise<CompOffRequestView[]> {
    const actor = requireContext().actor!;
    if (!actor.personId) throw new ForbiddenException();
    const summary = await this.people.summary(actor.personId);
    await this.authz.assert(actor, 'read', {
      area: 'leave',
      subjectPersonId: summary.personId,
      legalEntityId: summary.legalEntityId,
    });
    return this.db.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(compOffRequests)
        .where(
          and(
            eq(compOffRequests.personId, summary.personId),
            or(
              and(
                gte(compOffRequests.workedOn, `${year}-01-01`),
                lt(compOffRequests.workedOn, `${year + 1}-01-01`),
              ),
              gte(compOffRequests.validUntil, `${year}-01-01`),
            ),
          ),
        )
        .orderBy(asc(compOffRequests.workedOn), asc(compOffRequests.createdAt));
      return rows.reverse().map((r) => view(r, actor.personId));
    });
  }

  /** The employee withdraws a request not yet decided. */
  async cancel(id: string): Promise<CompOffRequestView> {
    const actor = requireContext().actor!;
    return this.db.tx(async (tx) => {
      const row = await this.load(tx, id);
      if (!row) throw new NotFoundException();
      const summary = await this.people.summary(row.personId);
      await this.authz.assert(actor, 'cancel', {
        area: 'leave',
        subjectPersonId: row.personId,
        legalEntityId: summary.legalEntityId,
      });
      if (actor.personId !== row.personId) throw new ForbiddenException();
      if (!OPEN.includes(row.status as (typeof OPEN)[number]) || !row.workflowInstanceId) {
        throw new BadRequestException({
          message: 'Only a request not yet decided can be withdrawn',
        });
      }
      await this.workflows.cancelIn(tx, row.workflowInstanceId);
      return view((await this.load(tx, id))!, actor.personId);
    });
  }

  // ---- The daily job ----

  /**
   * Expires grants whose last day is before `today`: what is left of each (the latest-expiring
   * grants keep the balance, undecided leave counted as used) leaves the balance. Safe to run again.
   */
  async expire(today: string): Promise<{ expired: number; days: number }> {
    return this.db.tx(async (tx) => {
      const due = await tx
        .select()
        .from(compOffRequests)
        .where(
          and(
            eq(compOffRequests.status, 'approved'),
            isNull(compOffRequests.expiredAt),
            lt(compOffRequests.validUntil, today),
          ),
        )
        .orderBy(asc(compOffRequests.validUntil), asc(compOffRequests.createdAt));
      let expired = 0;
      let total = 0;
      const groups = new Map<string, Row[]>();
      for (const row of due) {
        const key = `${row.engagementId}:${row.leaveTypeId}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      for (const rows of groups.values()) {
        const { engagementId, leaveTypeId, personId } = rows[0]!;
        const position = await this.leave.grantPosition(tx, engagementId, leaveTypeId);
        let balance =
          position.balance - (await this.leave.pendingDays(tx, engagementId, leaveTypeId));
        let grants = position.grants;
        for (const row of rows) {
          const left = heldByGrant(grants, balance).get(row.id) ?? 0;
          grants = grants.filter((g) => g.id !== row.id);
          const marked = await tx
            .update(compOffRequests)
            .set({ expiredAt: new Date(), expiredAmount: left, updatedAt: new Date() })
            .where(and(eq(compOffRequests.id, row.id), isNull(compOffRequests.expiredAt)))
            .returning({ id: compOffRequests.id });
          if (marked.length === 0 || left === 0) continue;
          const on = addDays(row.validUntil!, 1);
          await tx.insert(leaveLedger).values({
            tenantId: requireContext().tenantId,
            engagementId,
            personId,
            leaveTypeId,
            year: Number(on.slice(0, 4)),
            entryDate: on,
            kind: 'expiry',
            amount: -left,
            note: expiryNote(row.workedOn, row.validUntil!, row.amount, left),
            sourceTable: 'comp_off_request',
            sourceId: row.id,
          });
          balance -= left;
          expired++;
          total += left;
        }
      }
      return { expired, days: toDays(total) };
    });
  }

  // ---- Internals ----

  /** On approval: credit the day, usable for the type's expiry days, and write the journey. */
  private async grant(tx: Tx, id: string): Promise<void> {
    const row = await this.load(tx, id);
    if (!row || row.status !== 'applied') return;
    const type = (await this.leave.ensureTypes(tx)).find((t) => t.id === row.leaveTypeId)!;
    const grantedOn = businessDate(new Date());
    const until = validUntil(grantedOn, type.expiresAfterDays);
    await tx.insert(leaveLedger).values({
      tenantId: requireContext().tenantId,
      engagementId: row.engagementId,
      personId: row.personId,
      leaveTypeId: type.id,
      year: Number(grantedOn.slice(0, 4)),
      entryDate: grantedOn,
      kind: 'grant',
      amount: row.amount,
      note: `Worked ${dayWords(row)}${until ? `; usable until ${shortDate(until)}` : ''}`,
      sourceTable: 'comp_off_request',
      sourceId: row.id,
    });
    await tx
      .update(compOffRequests)
      .set({ status: 'approved', grantedOn, validUntil: until, updatedAt: new Date() })
      .where(eq(compOffRequests.id, id));
    await this.journey.record(tx, {
      engagementId: row.engagementId,
      personId: row.personId,
      eventType: 'comp_off_granted',
      category: 'leave',
      occurredOn: grantedOn,
      title: `Comp-off granted: ${daysWord(row.amount)} for ${dayWords(row)}`,
      detail: { workedOn: row.workedOn, days: toDays(row.amount), validUntil: until },
      sensitivity: 'manager',
      sourceTable: 'comp_off_request',
      sourceId: row.id,
    });
  }

  /** The card: the day and what it was, the attendance recorded, what is granted, the balance. */
  private async describe(tx: Tx, id: string): Promise<ChangeLine[]> {
    const row = await this.load(tx, id);
    if (!row) return [];
    const type = (await this.leave.ensureTypes(tx)).find((t) => t.id === row.leaveTypeId)!;
    const [day] = await tx
      .select()
      .from(attendanceDays)
      .where(
        and(
          eq(attendanceDays.engagementId, row.engagementId),
          eq(attendanceDays.day, row.workedOn),
        ),
      );
    let attendance = 'No check-in recorded';
    if (day?.firstIn) {
      const worked =
        day.workedMinutes === null
          ? 'no check-out'
          : `${Math.floor(day.workedMinutes / 60)}h ${day.workedMinutes % 60}m worked`;
      attendance = `Checked in ${timeIndia(day.firstIn)}${
        day.lastOut ? `–${timeIndia(day.lastOut)}` : ''
      }, ${worked}`;
    }
    const { balance } = await this.leave.grantPosition(tx, row.engagementId, type.id);
    const lines: ChangeLine[] = [
      { label: 'Worked on', from: null, to: dayWords(row) },
      { label: 'Attendance', from: null, to: attendance },
      {
        label: 'Comp-off',
        from: null,
        to: `${daysWord(row.amount)}, ${
          type.expiresAfterDays === null
            ? 'doesn’t expire'
            : `usable for ${type.expiresAfterDays} days after approval`
        }`,
      },
      {
        label: `${type.name} balance`,
        from: String(toDays(balance)),
        to: String(toDays(balance + row.amount)),
      },
    ];
    if (row.reason) lines.push({ label: 'Reason', from: null, to: row.reason });
    return lines;
  }

  private async load(tx: Tx, id: string): Promise<Row | undefined> {
    const [row] = await tx.select().from(compOffRequests).where(eq(compOffRequests.id, id));
    return row;
  }
}

function view(row: Row, actorPersonId: string | null | undefined): CompOffRequestView {
  return {
    id: row.id,
    workedOn: row.workedOn,
    dayKind: row.dayKind,
    days: toDays(row.amount),
    reason: row.reason,
    status: row.status,
    grantedOn: row.grantedOn,
    validUntil: row.validUntil,
    expiredDays: row.expiredAmount === null ? null : toDays(row.expiredAmount),
    requestId: row.workflowInstanceId,
    canCancel: actorPersonId === row.personId && OPEN.includes(row.status as (typeof OPEN)[number]),
    createdAt: row.createdAt.toISOString(),
  };
}
