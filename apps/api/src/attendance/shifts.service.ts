import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type {
  AllocateShiftInput,
  PersonSummary,
  ShiftAllocationView,
  ShiftInput,
  ShiftView,
  WorkingDayView,
} from '@ipro/shared';
import { AuditService, diffFields } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { addDays, planChange, rowAt } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { appUsers } from '../identity/identity.schema.js';
import { engagements } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { shiftAssignments, shifts } from './attendance.schema.js';
import { workingDayRule, type WorkingDayRule } from './working-days.js';

type ShiftRow = typeof shifts.$inferSelect;

/** The spec's proposed default week (Mon–Fri) if a tenant has no default shift configured. */
const FALLBACK_WEEKLY_OFFS = [6, 7];
const LIVE = ['offered', 'pre_joining', 'active', 'on_notice'] as const;
const MAX_CALENDAR_DAYS = 370;

const toView = (row: ShiftRow): ShiftView => ({
  id: row.id,
  code: row.code,
  name: row.name,
  startTime: row.startTime.slice(0, 5),
  endTime: row.endTime.slice(0, 5),
  breakMinutes: row.breakMinutes,
  graceMinutes: row.graceMinutes,
  halfDayMinutes: row.halfDayMinutes,
  weeklyOffs: [...row.weeklyOffs].sort(),
  isDefault: row.isDefault,
});

/** A person's day on a date: their shift, and the hours they work (own times or the shift's). */
export interface WorkDay {
  shift: ShiftRow | null;
  startTime: string;
  endTime: string;
  customTimes: boolean;
}

/** A person's working calendar: which shift and hours apply on a date, and whether it is a working day. */
export interface PersonCalendar {
  isWorking: WorkingDayRule;
  dayOn: (isoDate: string) => WorkDay;
}

const hhmm = (time: string | null | undefined) => (time ?? '').slice(0, 5);

/** Own times on the allocation win over the shift's (decision #46). */
function workDay(
  shift: ShiftRow | null,
  allocation?: { startTime: string | null; endTime: string | null },
): WorkDay {
  const custom = Boolean(allocation?.startTime && allocation.endTime);
  return {
    shift,
    startTime: hhmm(custom ? allocation!.startTime : shift?.startTime),
    endTime: hhmm(custom ? allocation!.endTime : shift?.endTime),
    customTimes: custom,
  };
}

/**
 * Shifts (configuration, screen A2) and who works which shift when (decision #46). Shift allocations
 * are dated per engagement, so people can move between project teams' working weeks.
 */
@Injectable()
export class ShiftsService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PeopleService) private readonly people: PeopleService,
  ) {}

  async list(): Promise<ShiftView[]> {
    await this.assertConfig('read');
    const rows = await this.db.tx((tx) =>
      tx.select().from(shifts).where(isNull(shifts.deletedAt)).orderBy(asc(shifts.code)),
    );
    return rows.map(toView);
  }

  async create(input: ShiftInput): Promise<ShiftView> {
    await this.assertConfig('create');
    const { tenantId, actor } = requireContext();
    return this.db.tx(async (tx) => {
      if (input.isDefault) await this.clearDefault(tx);
      const [row] = await tx
        .insert(shifts)
        .values({ ...input, tenantId, createdBy: actor!.userId, updatedBy: actor!.userId })
        .returning();
      await this.audit.record(tx, { action: 'create', table: 'shift', recordId: row!.id });
      return toView(row!);
    });
  }

  async update(id: string, input: Partial<ShiftInput>): Promise<ShiftView> {
    await this.assertConfig('update');
    const { actor } = requireContext();
    return this.db.tx(async (tx) => {
      const [before] = await tx.select().from(shifts).where(eq(shifts.id, id));
      if (!before || before.deletedAt) throw new NotFoundException();
      if (input.isDefault === false && before.isDefault) {
        throw new BadRequestException({ message: 'Make another shift the default instead' });
      }
      if (input.isDefault) await this.clearDefault(tx);
      const [row] = await tx
        .update(shifts)
        .set({ ...input, updatedAt: new Date(), updatedBy: actor!.userId })
        .where(eq(shifts.id, id))
        .returning();
      await this.audit.record(tx, {
        action: 'update',
        table: 'shift',
        recordId: id,
        fieldChanges: diffFields(toView(before) as unknown as Record<string, unknown>, input),
      });
      return toView(row!);
    });
  }

  /**
   * Puts people on a shift from a date (e.g. a project team moving to Sun–Thu). With an end date, the
   * shift they were on before resumes the day after.
   */
  async allocate(input: AllocateShiftInput): Promise<{ allocated: number }> {
    const { actor, tenantId } = requireContext();
    const targets: PersonSummary[] = [];
    for (const personId of new Set(input.personIds)) {
      const summary = await this.people.summary(personId);
      await this.authz.assert(actor!, 'update', {
        area: 'assignment_history',
        subjectPersonId: personId,
        legalEntityId: summary.legalEntityId,
      });
      targets.push(summary);
    }
    await this.db.tx((tx) => this.applyAllocation(tx, input, targets, actor!.userId, tenantId));
    return { allocated: targets.length };
  }

  /**
   * The allocation itself, in the caller's transaction. Callers have already checked permission:
   * `allocate` (HR directly) or an approved shift change request (decision #47).
   */
  async applyAllocation(
    tx: Tx,
    input: AllocateShiftInput,
    targets: PersonSummary[],
    userId: string,
    tenantId: string,
  ): Promise<void> {
    const by = { createdBy: userId, updatedBy: userId };
    const [shift] = await tx
      .select()
      .from(shifts)
      .where(and(eq(shifts.id, input.shiftId), isNull(shifts.deletedAt)));
    if (!shift) throw new BadRequestException({ message: 'Unknown shift' });

    for (const target of targets) {
      const history = await tx
        .select()
        .from(shiftAssignments)
        .where(eq(shiftAssignments.engagementId, target.engagementId))
        .orderBy(asc(shiftAssignments.effectiveFrom));
      const plan = planChange(history, input.effectiveFrom);
      if (!plan.ok) {
        throw new ConflictException({ message: `${target.employeeCode}: ${plan.problem}` });
      }
      const covering = history.find((row) => row.id === plan.basedOn);
      let newTo = plan.newRow.effectiveTo;
      if (input.effectiveTo) {
        const startsInside = history.some(
          (row) =>
            row.effectiveFrom > input.effectiveFrom && row.effectiveFrom <= input.effectiveTo!,
        );
        if (startsInside) {
          throw new ConflictException({
            message: `${target.employeeCode}: another shift change is planned within these dates`,
          });
        }
        newTo = input.effectiveTo;
      }

      if (plan.close) {
        await tx
          .update(shiftAssignments)
          .set({
            effectiveTo: plan.close.effectiveTo,
            updatedAt: new Date(),
            updatedBy: userId,
          })
          .where(eq(shiftAssignments.id, plan.close.id));
      }
      const [row] = await tx
        .insert(shiftAssignments)
        .values({
          tenantId,
          engagementId: target.engagementId,
          shiftId: shift.id,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: newTo,
          startTime: input.startTime ?? null,
          endTime: input.endTime ?? null,
          reason: input.reason,
          ...by,
        })
        .returning({ id: shiftAssignments.id });
      // The shift they were on before resumes after a bounded allocation.
      if (
        input.effectiveTo &&
        covering &&
        (covering.effectiveTo === null || covering.effectiveTo > input.effectiveTo)
      ) {
        await tx.insert(shiftAssignments).values({
          tenantId,
          engagementId: target.engagementId,
          shiftId: covering.shiftId,
          effectiveFrom: addDays(input.effectiveTo, 1),
          effectiveTo: covering.effectiveTo,
          startTime: covering.startTime,
          endTime: covering.endTime,
          reason: covering.reason,
          ...by,
        });
      }
      await this.audit.record(tx, {
        action: 'create',
        table: 'shift_assignment',
        recordId: row!.id,
        subjectPersonId: target.personId,
        fieldChanges: [
          { field: 'shift', from: covering?.shiftId ?? null, to: shift.id },
          { field: 'effective_from', to: input.effectiveFrom },
          ...(input.effectiveTo ? [{ field: 'effective_to', to: input.effectiveTo }] : []),
          ...(input.startTime
            ? [{ field: 'day_times', to: `${input.startTime}–${input.endTime}` }]
            : []),
        ],
      });
    }
  }

  async history(personId: string): Promise<ShiftAllocationView[]> {
    const summary = await this.people.summary(personId);
    await this.authz.assert(requireContext().actor!, 'read', {
      area: 'assignment_history',
      subjectPersonId: personId,
      legalEntityId: summary.legalEntityId,
    });
    const rows = await this.db.tx((tx) =>
      tx
        .select({ allocation: shiftAssignments, shift: shifts })
        .from(shiftAssignments)
        .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
        .innerJoin(engagements, eq(engagements.id, shiftAssignments.engagementId))
        .where(eq(engagements.personId, personId))
        .orderBy(asc(shiftAssignments.effectiveFrom)),
    );
    return rows.map(({ allocation, shift }) => {
      const day = workDay(shift, allocation);
      return {
        id: allocation.id,
        shiftId: shift.id,
        shiftName: shift.name,
        weeklyOffs: [...shift.weeklyOffs].sort(),
        effectiveFrom: allocation.effectiveFrom,
        effectiveTo: allocation.effectiveTo,
        startTime: day.startTime,
        endTime: day.endTime,
        customTimes: day.customTimes,
        reason: allocation.reason,
      };
    });
  }

  /** Working days for a person over a date range (attendance calendar, slice 6, and checks). */
  async workingDays(personId: string, from: string, to: string): Promise<WorkingDayView[]> {
    if (to < from || addDays(from, MAX_CALENDAR_DAYS) < to) {
      throw new BadRequestException({
        message: `Choose a range of up to ${MAX_CALENDAR_DAYS} days`,
      });
    }
    const summary = await this.people.summary(personId);
    await this.authz.assert(requireContext().actor!, 'read', {
      area: 'attendance',
      subjectPersonId: personId,
      legalEntityId: summary.legalEntityId,
    });
    return this.db.tx(async (tx) => {
      const calendar = await this.calendarForEngagement(tx, summary.engagementId);
      const days: WorkingDayView[] = [];
      for (let date = from; date <= to; date = addDays(date, 1)) {
        const day = calendar.dayOn(date);
        days.push({
          date,
          working: calendar.isWorking(date),
          shiftCode: day.shift?.code ?? '',
          startTime: day.startTime,
          endTime: day.endTime,
        });
      }
      return days;
    });
  }

  /** The working calendar of an engagement (null = someone with no engagement: the default shift). */
  async calendarForEngagement(tx: Tx, engagementId: string | null): Promise<PersonCalendar> {
    const allShifts = await tx.select().from(shifts);
    const byId = new Map(allShifts.map((s) => [s.id, s]));
    const fallback = allShifts.find((s) => s.isDefault && !s.deletedAt) ?? null;
    const allocations = engagementId
      ? await tx
          .select()
          .from(shiftAssignments)
          .where(eq(shiftAssignments.engagementId, engagementId))
      : [];
    const dayOn = (date: string): WorkDay => {
      const allocation = rowAt(allocations, date);
      const shift = (allocation ? byId.get(allocation.shiftId) : undefined) ?? fallback;
      return workDay(shift, allocation);
    };
    return {
      dayOn,
      isWorking: workingDayRule((date) => dayOn(date).shift?.weeklyOffs ?? FALLBACK_WEEKLY_OFFS),
    };
  }

  /** The working calendar of a sign-in user, via their person's current engagement. */
  async calendarForUser(tx: Tx, userId: string): Promise<PersonCalendar> {
    const [user] = await tx
      .select({ personId: appUsers.personId })
      .from(appUsers)
      .where(eq(appUsers.id, userId));
    const [engagement] = user?.personId
      ? await tx
          .select({ id: engagements.id })
          .from(engagements)
          .where(
            and(eq(engagements.personId, user.personId), inArray(engagements.status, [...LIVE])),
          )
      : [];
    return this.calendarForEngagement(tx, engagement?.id ?? null);
  }

  private async clearDefault(tx: Tx) {
    await tx.update(shifts).set({ isDefault: false }).where(eq(shifts.isDefault, true));
  }

  private assertConfig(action: 'read' | 'create' | 'update') {
    return this.authz.assert(requireContext().actor!, action, { area: 'org_config' });
  }
}
