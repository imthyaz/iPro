import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import type {
  AttendanceCorrectionInput,
  AttendanceExceptionView,
  AttendanceFlag,
  ChangeLine,
  RegularisationAllowance,
  RegularisationInput,
  RegularisationView,
} from '@ipro/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { JourneyService } from '../journey/journey.service.js';
import { engagements, persons } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { SettingsService } from '../people/settings.service.js';
import { WorkflowActions } from '../workflow/actions.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { attendanceDays, attendanceRegularisations } from './attendance.schema.js';
import { lastDayOf } from './attendance.service.js';
import { ShiftsService } from './shifts.service.js';

type Row = typeof attendanceRegularisations.$inferSelect;
type Corrected = Pick<Row, 'engagementId' | 'personId' | 'day' | 'status' | 'firstIn' | 'lastOut'>;

const payloadSchema = z.object({ regularisationId: z.uuid() });
const OPEN = ['pending', 'returned'] as const;

const reasonWords: Record<NonNullable<Row['reasonCode']>, string> = {
  forgot_to_punch: 'Forgot to punch',
  on_duty: 'On duty elsewhere',
  client_site: 'At a client site',
  system_issue: 'System or device issue',
};
const statusWords: Record<string, string> = {
  present: 'Present',
  absent: 'Absent',
  half_day: 'Half day',
  wfh: 'WFH',
  client_site: 'Client site',
};
const modeOf = {
  present: 'office',
  wfh: 'wfh',
  client_site: 'client_site',
  half_day: null,
} as const;

/** A time of day in India on a business date, as an instant. */
const atIndia = (day: string, time: string | undefined) =>
  time ? new Date(`${day}T${time}:00+05:30`) : null;
const timeIndia = (at: Date | null) =>
  at
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(at)
    : null;
const span = (a: Date | null, b: Date | null) =>
  a || b ? `${timeIndia(a) ?? '—'}–${timeIndia(b) ?? '—'}` : null;

/**
 * Attendance regularisation (spec workflow 5; decision #69). The employee asks, within the window and
 * the monthly limit, to correct an absent day, a half day or a missing punch; their manager approves.
 * HR corrects days directly, with a reason. Either way the day is set and marked regularised.
 */
@Injectable()
export class RegularisationService implements OnModuleInit {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ShiftsService) private readonly shifts: ShiftsService,
    @Inject(JourneyService) private readonly journey: JourneyService,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(WorkflowActions) private readonly actions: WorkflowActions,
  ) {}

  onModuleInit(): void {
    this.actions.register('attendance.regularise', {
      bulk: true,
      validate: (payload) => {
        const parsed = payloadSchema.safeParse(payload);
        if (!parsed.success) throw new BadRequestException({ message: 'Invalid regularisation' });
        return parsed.data;
      },
      describe: (tx, instance) => this.describe(tx, payloadSchema.parse(instance.payload)),
      apply: async (tx, instance) => {
        const row = await this.load(tx, payloadSchema.parse(instance.payload).regularisationId);
        await this.applyToDay(tx, row);
        await tx
          .update(attendanceRegularisations)
          .set({ state: 'approved', decidedAt: new Date(), updatedAt: new Date() })
          .where(eq(attendanceRegularisations.id, row.id));
      },
      onStatus: async (tx, instance, status) => {
        if (status === 'approved') return;
        await tx
          .update(attendanceRegularisations)
          .set({ state: status, updatedAt: new Date() })
          .where(
            eq(
              attendanceRegularisations.id,
              payloadSchema.parse(instance.payload).regularisationId,
            ),
          );
      },
    });
  }

  // ---- The employee's request (E3) ----

  async request(input: RegularisationInput, now = new Date()): Promise<RegularisationView> {
    const actor = requireContext().actor!;
    if (!actor.personId) throw new ForbiddenException();
    const summary = await this.people.summary(actor.personId);
    await this.authz.assert(actor, 'regularise', {
      area: 'attendance',
      subjectPersonId: summary.personId,
      legalEntityId: summary.legalEntityId,
    });
    const today = businessDate(now);
    const date = input.date;
    return this.db.tx(async (tx) => {
      const window = await this.settings.get(tx, 'regularisation_window_days');
      const max = await this.settings.get(tx, 'regularisation_max_per_month');
      if (date >= today)
        throw new BadRequestException({ message: 'Only a past day can be regularised' });
      if (addDays(date, window) < today) {
        throw new BadRequestException({
          message: `A day can be regularised up to ${window} days after it; ask HR for older days`,
        });
      }
      const [engagement] = await tx
        .select()
        .from(engagements)
        .where(eq(engagements.id, summary.engagementId));
      if (!engagement || date < engagement.joiningDate) {
        throw new BadRequestException({ message: 'That day is before you joined' });
      }
      const [day] = await tx
        .select()
        .from(attendanceDays)
        .where(and(eq(attendanceDays.engagementId, engagement.id), eq(attendanceDays.day, date)));
      if (day?.regularised)
        throw new ConflictException({ message: 'This day is already regularised' });
      const calendar = await this.shifts.calendarForEngagement(tx, engagement.id);
      const eligible = day
        ? day.status === 'absent' ||
          day.status === 'half_day' ||
          day.flags.includes('missing_check_out')
        : calendar.isWorking(date);
      if (!eligible) {
        throw new BadRequestException({
          message:
            'Only an absent day, a half day or a day with a missing punch can be regularised',
        });
      }
      const [open] = await tx
        .select({ id: attendanceRegularisations.id })
        .from(attendanceRegularisations)
        .where(
          and(
            eq(attendanceRegularisations.engagementId, engagement.id),
            eq(attendanceRegularisations.day, date),
            inArray(attendanceRegularisations.state, [...OPEN]),
          ),
        );
      if (open) throw new ConflictException({ message: 'There is already a request for this day' });
      const used = await this.used(tx, summary.personId, date.slice(0, 7));
      if (used >= max) {
        throw new BadRequestException({
          message: `You have used all ${max} regularisations for this month; ask HR`,
        });
      }
      const [row] = await tx
        .insert(attendanceRegularisations)
        .values({
          tenantId: requireContext().tenantId,
          engagementId: engagement.id,
          personId: summary.personId,
          day: date,
          source: 'employee',
          reasonCode: input.reason,
          note: input.note ?? null,
          status: input.status,
          firstIn: atIndia(date, input.firstIn),
          lastOut: atIndia(date, input.lastOut),
          state: 'pending',
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning();
      const instanceId = await this.workflows.submit(tx, {
        key: 'attendance_regularisation',
        subjectPersonId: summary.personId,
        title: `Regularise ${date}: ${summary.preferredName ?? summary.legalName}`,
        payload: { regularisationId: row!.id },
      });
      await tx
        .update(attendanceRegularisations)
        .set({ workflowInstanceId: instanceId })
        .where(eq(attendanceRegularisations.id, row!.id));
      return view(await this.load(tx, row!.id));
    });
  }

  /** E3: my requests for a month and how many are left. */
  async mine(
    month: string,
  ): Promise<{ allowance: RegularisationAllowance; items: RegularisationView[] }> {
    const actor = requireContext().actor!;
    if (!actor.personId) throw new ForbiddenException();
    const summary = await this.people.summary(actor.personId);
    await this.authz.assert(actor, 'read', {
      area: 'attendance',
      subjectPersonId: summary.personId,
      legalEntityId: summary.legalEntityId,
    });
    return this.db.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(attendanceRegularisations)
        .where(
          and(
            eq(attendanceRegularisations.personId, summary.personId),
            gte(attendanceRegularisations.day, `${month}-01`),
            lte(attendanceRegularisations.day, lastDayOf(month)),
          ),
        )
        .orderBy(asc(attendanceRegularisations.day), asc(attendanceRegularisations.createdAt));
      return {
        allowance: {
          month,
          used: await this.used(tx, summary.personId, month),
          max: await this.settings.get(tx, 'regularisation_max_per_month'),
          windowDays: await this.settings.get(tx, 'regularisation_window_days'),
        },
        items: rows.map(view),
      };
    });
  }

  // ---- HR (H9) ----

  /** HR corrects days directly with a reason (no approval: HR holds attendance update). */
  async correct(input: AttendanceCorrectionInput): Promise<{ corrected: number }> {
    const actor = requireContext().actor!;
    const personIds = [...new Set(input.days.map((d) => d.personId))];
    const summaries = new Map<string, Awaited<ReturnType<PeopleService['summary']>>>();
    for (const personId of personIds) {
      const summary = await this.people.summary(personId);
      await this.authz.assert(actor, 'update', {
        area: 'attendance',
        subjectPersonId: personId,
        legalEntityId: summary.legalEntityId,
      });
      summaries.set(personId, summary);
    }
    const today = businessDate(new Date());
    return this.db.tx(async (tx) => {
      let corrected = 0;
      for (const { personId, date } of input.days) {
        const summary = summaries.get(personId)!;
        const [engagement] = await tx
          .select()
          .from(engagements)
          .where(eq(engagements.id, summary.engagementId));
        if (
          !engagement ||
          date > today ||
          date < engagement.joiningDate ||
          (engagement.lastWorkingDate !== null && date > engagement.lastWorkingDate)
        ) {
          throw new BadRequestException({
            message: `${date} is outside ${summary.employeeCode}'s employment or in the future`,
          });
        }
        // An open employee request for the day is overtaken by HR's correction.
        const open = await tx
          .select()
          .from(attendanceRegularisations)
          .where(
            and(
              eq(attendanceRegularisations.engagementId, engagement.id),
              eq(attendanceRegularisations.day, date),
              inArray(attendanceRegularisations.state, [...OPEN]),
            ),
          );
        for (const row of open) {
          if (row.workflowInstanceId) await this.workflows.cancelIn(tx, row.workflowInstanceId);
          await tx
            .update(attendanceRegularisations)
            .set({ state: 'withdrawn', updatedAt: new Date() })
            .where(eq(attendanceRegularisations.id, row.id));
        }
        const [row] = await tx
          .insert(attendanceRegularisations)
          .values({
            tenantId: requireContext().tenantId,
            engagementId: engagement.id,
            personId,
            day: date,
            source: 'hr',
            note: input.reason,
            status: input.status,
            firstIn: atIndia(date, input.firstIn),
            lastOut: atIndia(date, input.lastOut),
            state: 'approved',
            decidedAt: new Date(),
            createdBy: actor.userId,
            updatedBy: actor.userId,
          })
          .returning();
        await this.applyToDay(tx, row!);
        await this.journey.record(tx, {
          engagementId: engagement.id,
          personId,
          eventType: 'attendance_regularised',
          category: 'attendance',
          occurredOn: today,
          title: `Attendance corrected for ${date}`,
          detail: { date, status: input.status, by: 'hr' },
          sensitivity: 'manager',
          sourceTable: 'attendance_regularisation',
          sourceId: row!.id,
        });
        corrected++;
      }
      return { corrected };
    });
  }

  /** H9: days that need a look (absent, half day or flagged, not yet regularised), for people I may see. */
  async exceptions(from: string, to: string): Promise<AttendanceExceptionView[]> {
    if (to < from || addDays(from, 62) < to) {
      throw new BadRequestException({ message: 'Choose a range of up to two months' });
    }
    const actor = requireContext().actor!;
    const rows = await this.db.tx((tx) =>
      tx
        .select({
          day: attendanceDays,
          legalName: persons.legalName,
          preferredName: persons.preferredName,
          employeeCode: engagements.employeeCode,
          legalEntityId: engagements.legalEntityId,
        })
        .from(attendanceDays)
        .innerJoin(engagements, eq(engagements.id, attendanceDays.engagementId))
        .innerJoin(persons, eq(persons.id, attendanceDays.personId))
        .where(
          and(
            gte(attendanceDays.day, from),
            lte(attendanceDays.day, to),
            eq(attendanceDays.regularised, false),
            sql`(${attendanceDays.status} in ('absent', 'half_day') or cardinality(${attendanceDays.flags}) > 0)`,
          ),
        )
        .orderBy(asc(attendanceDays.day), asc(engagements.employeeCode)),
    );
    // Per person, the same check as their record: team for managers, entity for HR; never CXO rows.
    const allowed = new Map<string, boolean>();
    for (const r of rows) {
      if (allowed.has(r.day.personId)) continue;
      const decision = await this.authz.check(actor, 'read', {
        area: 'attendance',
        subjectPersonId: r.day.personId,
        legalEntityId: r.legalEntityId,
      });
      allowed.set(
        r.day.personId,
        decision.allowed &&
          !decision.obligations.has('aggregates_only') &&
          r.day.personId !== actor.personId,
      );
    }
    const visible = rows.filter((r) => allowed.get(r.day.personId));
    const pending = visible.length
      ? await this.db.tx((tx) =>
          tx
            .select({
              engagementId: attendanceRegularisations.engagementId,
              day: attendanceRegularisations.day,
            })
            .from(attendanceRegularisations)
            .where(
              and(
                gte(attendanceRegularisations.day, from),
                lte(attendanceRegularisations.day, to),
                inArray(attendanceRegularisations.state, [...OPEN]),
              ),
            ),
        )
      : [];
    const open = new Set(pending.map((p) => `${p.engagementId}:${p.day}`));
    return visible.map((r) => ({
      personId: r.day.personId,
      name: r.preferredName ?? r.legalName,
      employeeCode: r.employeeCode,
      date: r.day.day,
      status: r.day.status,
      flags: r.day.flags as AttendanceFlag[],
      firstIn: r.day.firstIn?.toISOString() ?? null,
      lastOut: r.day.lastOut?.toISOString() ?? null,
      pendingRegularisation: open.has(`${r.day.engagementId}:${r.day.day}`),
    }));
  }

  // ---- Internals ----

  /** Employee requests that count towards the month's limit (all but withdrawn ones). */
  private async used(tx: Tx, personId: string, month: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(attendanceRegularisations)
      .where(
        and(
          eq(attendanceRegularisations.personId, personId),
          eq(attendanceRegularisations.source, 'employee'),
          ne(attendanceRegularisations.state, 'withdrawn'),
          gte(attendanceRegularisations.day, `${month}-01`),
          lte(attendanceRegularisations.day, lastDayOf(month)),
        ),
      );
    return row?.n ?? 0;
  }

  private async load(tx: Tx, id: string): Promise<Row> {
    const [row] = await tx
      .select()
      .from(attendanceRegularisations)
      .where(eq(attendanceRegularisations.id, id));
    if (!row) throw new NotFoundException();
    return row;
  }

  /**
   * Sets the day as corrected; the build leaves a regularised day alone from then on. A time not
   * given keeps the one recorded (e.g. only the missing check-out is supplied).
   */
  private async applyToDay(tx: Tx, row: Corrected): Promise<void> {
    const calendar = await this.shifts.calendarForEngagement(tx, row.engagementId);
    const breakMinutes = calendar.dayOn(row.day).shift?.breakMinutes ?? 0;
    const [existing] = await tx
      .select({ firstIn: attendanceDays.firstIn, lastOut: attendanceDays.lastOut })
      .from(attendanceDays)
      .where(
        and(eq(attendanceDays.engagementId, row.engagementId), eq(attendanceDays.day, row.day)),
      );
    const firstIn = row.firstIn ?? existing?.firstIn ?? null;
    const lastOut = row.lastOut ?? existing?.lastOut ?? null;
    const minutes =
      firstIn && lastOut && firstIn < lastOut
        ? Math.round((lastOut.getTime() - firstIn.getTime()) / 60_000)
        : null;
    const workedMinutes =
      minutes === null ? null : minutes > breakMinutes * 2 ? minutes - breakMinutes : minutes;
    const now = new Date();
    const values = {
      status: row.status,
      firstIn,
      lastOut,
      workedMinutes,
      mode: modeOf[row.status],
      flags: [] as string[],
      regularised: true,
      builtAt: now,
      updatedAt: now,
      updatedBy: requireContext().actor?.userId ?? null,
    };
    const [day] = await tx
      .insert(attendanceDays)
      .values({
        tenantId: requireContext().tenantId,
        engagementId: row.engagementId,
        personId: row.personId,
        day: row.day,
        ...values,
      })
      .onConflictDoUpdate({
        target: [attendanceDays.tenantId, attendanceDays.engagementId, attendanceDays.day],
        set: values,
      })
      .returning({ id: attendanceDays.id });
    await this.audit.record(tx, {
      action: 'update',
      table: 'attendance_day',
      recordId: day!.id,
      subjectPersonId: row.personId,
      fieldChanges: [{ field: 'status', to: row.status }],
    });
  }

  /** The approval card: the day as it is and as asked, the reason, and the month's count. */
  private async describe(tx: Tx, payload: z.infer<typeof payloadSchema>): Promise<ChangeLine[]> {
    const [row] = await tx
      .select()
      .from(attendanceRegularisations)
      .where(eq(attendanceRegularisations.id, payload.regularisationId));
    if (!row) return [];
    const [day] = await tx
      .select()
      .from(attendanceDays)
      .where(
        and(eq(attendanceDays.engagementId, row.engagementId), eq(attendanceDays.day, row.day)),
      );
    const used = await this.used(tx, row.personId, row.day.slice(0, 7));
    const max = await this.settings.get(tx, 'regularisation_max_per_month');
    const lines: ChangeLine[] = [
      { label: 'Day', from: null, to: row.day },
      {
        label: 'Status',
        from: day ? (statusWords[day.status] ?? day.status) : 'Absent',
        to: statusWords[row.status] ?? row.status,
      },
    ];
    const asked = span(row.firstIn, row.lastOut);
    if (asked)
      lines.push({
        label: 'Times',
        from: span(day?.firstIn ?? null, day?.lastOut ?? null),
        to: asked,
      });
    lines.push({
      label: 'Reason',
      from: null,
      to: [row.reasonCode ? reasonWords[row.reasonCode] : null, row.note]
        .filter(Boolean)
        .join(': '),
    });
    lines.push({ label: 'Regularisations this month', from: null, to: `${used} of ${max}` });
    return lines;
  }
}

function view(row: Row): RegularisationView {
  return {
    id: row.id,
    date: row.day,
    reason: row.reasonCode,
    status: row.status,
    firstIn: row.firstIn?.toISOString() ?? null,
    lastOut: row.lastOut?.toISOString() ?? null,
    note: row.note,
    source: row.source,
    state: row.state,
    requestId: row.workflowInstanceId,
  };
}
