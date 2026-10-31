import { BadRequestException, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  allocateShiftSchema,
  profileChangeSchema,
  describeWorkingWeek,
  type AllocateShiftInput,
  type ChangeLine,
  type PersonSummary,
  type ProfileChange,
} from '@ipro/shared';
import { shifts } from '../attendance/attendance.schema.js';
import { ShiftsService } from '../attendance/shifts.service.js';
import { AuditService, diffFields } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { persons } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { WorkflowActions } from './actions.js';
import { WorkflowService } from './workflow.service.js';

const profileLabels: Record<keyof ProfileChange, string> = {
  preferredName: 'Preferred name',
  personalEmail: 'Personal email',
  phone: 'Phone',
  nationality: 'Nationality',
  gender: 'Gender',
};

function parseOr400<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException({ message: 'Invalid request' });
  return result.data as T;
}

/**
 * The workflows people start themselves: profile changes (employees) and shift change requests
 * (managers, decision #47). Each registers the action that runs on approval.
 */
@Injectable()
export class RequestsService implements OnModuleInit {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(ShiftsService) private readonly shiftsService: ShiftsService,
    @Inject(WorkflowActions) private readonly actions: WorkflowActions,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
  ) {}

  onModuleInit(): void {
    this.actions.register('profile.apply', {
      validate: (payload) => parseOr400<ProfileChange>(profileChangeSchema, payload),
      describe: (tx, instance) =>
        this.describeProfile(tx, instance.subjectPersonId, instance.payload),
      apply: async (tx, instance) => {
        await this.applyProfile(tx, instance.subjectPersonId, instance.payload as ProfileChange);
      },
    });
    this.actions.register('shift.allocate', {
      validate: (payload) => {
        const input = parseOr400<AllocateShiftInput>(allocateShiftSchema, payload);
        if (input.personIds.length !== 1)
          throw new BadRequestException({ message: 'One person per request' });
        return input;
      },
      describe: (tx, instance) => this.describeShift(tx, instance.payload as AllocateShiftInput),
      apply: async (tx, instance, approver) => {
        const input = instance.payload as AllocateShiftInput;
        const target = await this.people.summary(input.personIds[0]!);
        await this.shiftsService.applyAllocation(
          tx,
          input,
          [target],
          approver.userId,
          requireContext().tenantId,
        );
      },
    });
  }

  /**
   * Profile update: HR and HR head change it directly; an employee's own change becomes a request for
   * HR (the permissions table's "U via request").
   */
  async changeProfile(
    personId: string,
    changes: ProfileChange,
  ): Promise<{ applied: true } | { requestId: string }> {
    const actor = requireContext().actor!;
    const summary = await this.people.summary(personId);
    const obligations = await this.authz.assert(actor, 'update', {
      area: 'profile',
      subjectPersonId: personId,
      legalEntityId: summary.legalEntityId,
    });
    if (!obligations.has('via_change_request')) {
      await this.db.tx((tx) => this.applyProfile(tx, personId, changes));
      return { applied: true };
    }
    const requestId = await this.db.tx((tx) =>
      this.workflows.submit(tx, {
        key: 'profile_change',
        subjectPersonId: personId,
        title: `Profile change: ${summary.preferredName ?? summary.legalName}`,
        payload: changes,
      }),
    );
    return { requestId };
  }

  /** A manager asks for team members' shifts to change; one request per person, HR approves. */
  async requestShiftChange(input: AllocateShiftInput): Promise<{ requestIds: string[] }> {
    const actor = requireContext().actor!;
    const people: PersonSummary[] = [];
    for (const personId of new Set(input.personIds)) {
      const summary = await this.people.summary(personId);
      // Managers act on attendance for their team (permissions table: attendance A for team).
      await this.authz.assert(actor, 'approve', {
        area: 'attendance',
        subjectPersonId: personId,
        legalEntityId: summary.legalEntityId,
      });
      people.push(summary);
    }
    const requestIds = await this.db.tx(async (tx) => {
      const [shift] = await tx
        .select({ name: shifts.name })
        .from(shifts)
        .where(eq(shifts.id, input.shiftId));
      if (!shift) throw new BadRequestException({ message: 'Unknown shift' });
      const ids = [];
      for (const person of people) {
        ids.push(
          await this.workflows.submit(tx, {
            key: 'shift_change',
            subjectPersonId: person.personId,
            title: `Shift change: ${person.preferredName ?? person.legalName} → ${shift.name}`,
            payload: { ...input, personIds: [person.personId] },
          }),
        );
      }
      return ids;
    });
    return { requestIds };
  }

  private async applyProfile(tx: Tx, personId: string, changes: ProfileChange) {
    const [before] = await tx.select().from(persons).where(eq(persons.id, personId));
    if (!before) throw new BadRequestException({ message: 'Unknown person' });
    const actor = requireContext().actor;
    await tx
      .update(persons)
      .set({ ...changes, updatedAt: new Date(), updatedBy: actor?.userId ?? null })
      .where(eq(persons.id, personId));
    await this.audit.record(tx, {
      action: 'update',
      table: 'person',
      recordId: personId,
      subjectPersonId: personId,
      fieldChanges: diffFields(before as Record<string, unknown>, changes),
    });
  }

  private async describeProfile(
    tx: Tx,
    personId: string,
    payload: Record<string, unknown>,
  ): Promise<ChangeLine[]> {
    const [person] = await tx.select().from(persons).where(eq(persons.id, personId));
    return (Object.keys(profileLabels) as (keyof ProfileChange)[])
      .filter((field) => field in payload)
      .map((field) => ({
        label: profileLabels[field],
        from: (person?.[field] as string | null | undefined) ?? null,
        to: (payload[field] as string | null) ?? null,
      }));
  }

  private async describeShift(tx: Tx, input: AllocateShiftInput): Promise<ChangeLine[]> {
    const target = await this.people.summary(input.personIds[0]!);
    const calendar = await this.shiftsService.calendarForEngagement(tx, target.engagementId);
    const now = calendar.dayOn(input.effectiveFrom);
    const [shift] = await tx.select().from(shifts).where(eq(shifts.id, input.shiftId));
    const hours = (start?: string, end?: string) => (start && end ? `${start}–${end}` : null);
    return [
      {
        label: 'Shift',
        from: now.shift ? `${now.shift.name}` : null,
        to: shift ? `${shift.name}` : null,
      },
      {
        label: 'Working week',
        from: now.shift ? describeWorkingWeek(now.shift.weeklyOffs) : null,
        to: shift ? describeWorkingWeek(shift.weeklyOffs) : null,
      },
      {
        label: 'Hours',
        from: hours(now.startTime, now.endTime),
        to:
          hours(input.startTime, input.endTime) ??
          hours(shift?.startTime.slice(0, 5), shift?.endTime.slice(0, 5)),
      },
      { label: 'From', from: null, to: input.effectiveFrom },
      ...(input.effectiveTo ? [{ label: 'Until', from: null, to: input.effectiveTo }] : []),
      { label: 'Reason', from: null, to: input.reason },
    ];
  }
}
