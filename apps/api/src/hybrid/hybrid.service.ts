import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import {
  type ChangeLine,
  type PersonSummary,
  type SeatAvailability,
  type SeatInput,
  type SeatView,
  type WeekDayView,
  type WeekPlanInput,
  type WeekPlanView,
  type WorkMode,
  type WorkPolicyInput,
  type WorkPolicyView,
} from '@ipro/shared';
import { z } from 'zod';
import { ShiftsService, type PersonCalendar } from '../attendance/shifts.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { leaveRequestDays, leaveRequests } from '../leave/leave.schema.js';
import { locations, locationVersions } from '../org/org.schema.js';
import { inForce } from '../people/people.queries.js';
import { assignments, engagements } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { appliesToMatches } from '../workflow/checklist-rules.js';
import { WorkflowActions } from '../workflow/actions.js';
import { notify, userOfPerson } from '../workflow/lookups.js';
import { notifications } from '../workflow/workflow.schema.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import {
  beforeCutoff,
  cutoffOf,
  dayLabel,
  isoWeekday,
  mondayOf,
  weekFit,
  type FitDay,
} from './hybrid-rules.js';
import {
  hybridExceptions,
  seats,
  teamAnchorDays,
  workBookings,
  workPolicies,
} from './hybrid.schema.js';

type PolicyRow = typeof workPolicies.$inferSelect;
type BookingRow = typeof workBookings.$inferSelect;
type ExceptionRow = typeof hybridExceptions.$inferSelect;
type Place = WeekPlanView['places'][number];

const payloadSchema = z.object({ exceptionId: z.uuid() });
const WORKING = ['active', 'on_notice'] as const;
const LIVE = ['confirmed', 'pending', 'rejected'] as const;
const modeWords: Record<WorkMode, string> = {
  office: 'Office',
  wfh: 'WFH',
  client_site: 'Client site',
};

/** The spec's proposed policies, confirmed by the owner (decision #78); editable afterwards. */
export const defaultWorkPolicies: WorkPolicyInput[] = [
  {
    code: 'ONSITE',
    name: 'Client on-site',
    requiredMode: 'client_site',
    requiredDays: 5,
    anchorDayRequired: false,
    allowedModes: ['client_site'],
    appliesTo: {},
    locationTypes: ['client_site'],
    priority: 10,
    active: true,
  },
  {
    code: 'REMOTE',
    name: 'Remote-first',
    requiredMode: 'office',
    requiredDays: 0,
    anchorDayRequired: false,
    allowedModes: ['wfh', 'office', 'client_site'],
    appliesTo: { engagementTypes: ['retainer', 'consultant'] },
    locationTypes: [],
    priority: 20,
    active: true,
  },
  {
    code: 'HYBRID',
    name: 'Hybrid: 3 office days',
    requiredMode: 'office',
    requiredDays: 3,
    anchorDayRequired: true,
    allowedModes: ['office', 'wfh', 'client_site'],
    appliesTo: {},
    locationTypes: [],
    priority: 30,
    active: true,
  },
];

function policyView(row: PolicyRow): WorkPolicyView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    requiredMode: row.requiredMode,
    requiredDays: row.requiredDays,
    anchorDayRequired: row.anchorDayRequired,
    allowedModes: row.allowedModes,
    appliesTo: row.appliesTo,
    locationTypes: row.locationTypes,
    priority: row.priority,
    active: row.active,
  };
}

interface Planned {
  date: string;
  mode: WorkMode;
  locationId: string | null;
  seatId: string | null;
}

export interface Context {
  summary: PersonSummary;
  engagementId: string;
  policy: PolicyRow | null;
  calendar: PersonCalendar;
  anchorWeekday: number | null;
  homeLocationId: string | null;
  places: Place[];
}

/**
 * The hybrid planner (slice 8a; spec workflow 6; decision #78). The employee plans a week; a week
 * within their policy is confirmed at once, one below it (too few office days, the team's anchor
 * day missed, or an office day when the office is full) goes to their manager with a reason. A
 * day can be changed until 18:00 the day before. A named seat is optional and held by one person
 * a day.
 */
@Injectable()
export class HybridService implements OnModuleInit {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(ShiftsService) private readonly shifts: ShiftsService,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(WorkflowActions) private readonly actions: WorkflowActions,
  ) {}

  onModuleInit(): void {
    this.actions.register('hybrid.approve_exception', {
      bulk: true,
      validate: (payload) => {
        const parsed = payloadSchema.safeParse(payload);
        if (!parsed.success) throw new BadRequestException({ message: 'Invalid hybrid exception' });
        return parsed.data;
      },
      describe: (tx, instance) =>
        this.describe(tx, payloadSchema.parse(instance.payload).exceptionId),
      apply: (tx, instance) =>
        this.decide(tx, payloadSchema.parse(instance.payload).exceptionId, 'approved'),
      onStatus: async (tx, instance, status) => {
        const id = payloadSchema.parse(instance.payload).exceptionId;
        if (status === 'returned' || status === 'withdrawn') await this.decide(tx, id, status);
      },
    });
  }

  // ---- Work policies (A2) ----

  async policies(): Promise<WorkPolicyView[]> {
    return this.db.tx(async (tx) => (await this.ensurePolicies(tx)).map(policyView));
  }

  async createPolicy(input: WorkPolicyInput): Promise<WorkPolicyView> {
    const actor = requireContext().actor!;
    return this.db.tx(async (tx) => {
      await this.ensurePolicies(tx);
      const [exists] = await tx
        .select({ id: workPolicies.id })
        .from(workPolicies)
        .where(eq(workPolicies.code, input.code));
      if (exists) throw new ConflictException({ message: `A policy ${input.code} already exists` });
      const [row] = await tx
        .insert(workPolicies)
        .values({
          tenantId: requireContext().tenantId,
          ...input,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning();
      await this.audit.record(tx, { action: 'create', table: 'work_policy', recordId: row!.id });
      return policyView(row!);
    });
  }

  async updatePolicy(id: string, input: WorkPolicyInput): Promise<WorkPolicyView> {
    const actor = requireContext().actor!;
    return this.db.tx(async (tx) => {
      const [row] = await tx
        .update(workPolicies)
        .set({ ...input, code: undefined, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(workPolicies.id, id))
        .returning();
      if (!row) throw new NotFoundException();
      await this.audit.record(tx, { action: 'update', table: 'work_policy', recordId: id });
      return policyView(row);
    });
  }

  // ---- Seats ----

  async seats(locationId: string): Promise<SeatView[]> {
    return this.db.tx(async (tx) =>
      (
        await tx
          .select()
          .from(seats)
          .where(eq(seats.locationId, locationId))
          .orderBy(asc(seats.label))
      ).map(seatView),
    );
  }

  async addSeat(input: SeatInput): Promise<SeatView> {
    const actor = requireContext().actor!;
    return this.db.tx(async (tx) => {
      const place = (await this.placesOn(tx, businessDate(new Date()))).find(
        (p) => p.id === input.locationId,
      );
      if (!place || place.type !== 'office') {
        throw new BadRequestException({ message: 'Seats are for offices' });
      }
      const [taken] = await tx
        .select({ id: seats.id })
        .from(seats)
        .where(and(eq(seats.locationId, input.locationId), eq(seats.label, input.label)));
      if (taken) throw new ConflictException({ message: `Seat ${input.label} already exists` });
      const [row] = await tx
        .insert(seats)
        .values({
          tenantId: requireContext().tenantId,
          locationId: input.locationId,
          label: input.label,
          zone: input.zone || null,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning();
      await this.audit.record(tx, { action: 'create', table: 'seat', recordId: row!.id });
      return seatView(row!);
    });
  }

  async setSeatActive(id: string, active: boolean): Promise<SeatView> {
    const actor = requireContext().actor!;
    return this.db.tx(async (tx) => {
      const [row] = await tx
        .update(seats)
        .set({ active, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(seats.id, id))
        .returning();
      if (!row) throw new NotFoundException();
      await this.audit.record(tx, {
        action: 'update',
        table: 'seat',
        recordId: id,
        fieldChanges: [{ field: 'active', to: String(active) }],
      });
      return seatView(row);
    });
  }

  /** E6 seat picker: an office's seats and whether each is held that day. */
  async seatAvailability(locationId: string, date: string): Promise<SeatAvailability[]> {
    await this.self('read');
    return this.db.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(seats)
        .where(and(eq(seats.locationId, locationId), eq(seats.active, true)))
        .orderBy(asc(seats.label));
      const held = await tx
        .select({ seatId: workBookings.seatId })
        .from(workBookings)
        .where(
          and(eq(workBookings.date, date), inArray(workBookings.status, ['confirmed', 'pending'])),
        );
      const taken = new Set(held.map((h) => h.seatId));
      return rows.map((s) => ({ ...seatView(s), taken: taken.has(s.id) }));
    });
  }

  // ---- The team's anchor day ----

  /** The anchor day the signed-in manager set for their team. */
  async teamAnchor(): Promise<{ weekday: number | null }> {
    const actor = requireContext().actor!;
    if (!actor.personId) throw new ForbiddenException();
    const summary = await this.people.summary(actor.personId);
    return this.db.tx(async (tx) => {
      const [row] = await tx
        .select({ weekday: teamAnchorDays.weekday })
        .from(teamAnchorDays)
        .where(eq(teamAnchorDays.managerEngagementId, summary.engagementId));
      return { weekday: row?.weekday ?? null };
    });
  }

  async setTeamAnchor(weekday: number | null): Promise<{ weekday: number | null }> {
    const actor = requireContext().actor!;
    if (!actor.personId) throw new ForbiddenException();
    const summary = await this.people.summary(actor.personId);
    return this.db.tx(async (tx) => {
      // Only a manager with someone reporting to them now sets their team's anchor day.
      const [report] = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(
          and(
            eq(assignments.managerEngagementId, summary.engagementId),
            inForce(assignments.effectiveFrom, assignments.effectiveTo, businessDate(new Date())),
          ),
        )
        .limit(1);
      if (!report) throw new ForbiddenException();
      await tx
        .insert(teamAnchorDays)
        .values({
          tenantId: requireContext().tenantId,
          managerEngagementId: summary.engagementId,
          weekday,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .onConflictDoUpdate({
          target: [teamAnchorDays.tenantId, teamAnchorDays.managerEngagementId],
          set: { weekday, updatedAt: new Date(), updatedBy: actor.userId },
        });
      await this.audit.record(tx, {
        action: 'update',
        table: 'team_anchor_day',
        recordId: summary.engagementId,
        fieldChanges: [{ field: 'weekday', to: weekday === null ? null : String(weekday) }],
      });
      return { weekday };
    });
  }

  // ---- E6 Plan my week ----

  async week(weekStart: string, now = new Date()): Promise<WeekPlanView> {
    const summary = await this.self('read');
    assertMonday(weekStart);
    return this.db.tx(async (tx) => {
      const ctx = await this.contextOf(tx, summary, weekStart);
      return this.view(tx, ctx, weekStart, now);
    });
  }

  async savePlan(input: WeekPlanInput, now = new Date()): Promise<WeekPlanView> {
    const summary = await this.self('create');
    const actor = requireContext().actor!;
    const weekStart = input.weekStart;
    assertMonday(weekStart);
    return this.db.tx(async (tx) => {
      const ctx = await this.contextOf(tx, summary, weekStart);
      if (!ctx.policy)
        throw new BadRequestException({ message: 'No hybrid policy applies to you' });
      const existing = await this.bookingsOf(tx, ctx.engagementId, weekStart);
      const leave = await this.leaveIn(tx, ctx.engagementId, weekStart);
      const byDate = new Map(existing.map((b) => [b.date, b]));
      const changes: { date: string; planned: Planned | null }[] = [];
      const seen = new Set<string>();
      for (const d of input.days) {
        if (d.date < weekStart || d.date > addDays(weekStart, 6)) {
          throw new BadRequestException({ message: `${d.date} isn’t in this week` });
        }
        if (seen.has(d.date)) throw new BadRequestException({ message: `${d.date} appears twice` });
        seen.add(d.date);
        if (d.mode && !ctx.policy.allowedModes.includes(d.mode)) {
          throw new BadRequestException({
            message: `${modeWords[d.mode]} isn’t allowed by your policy (${ctx.policy.name})`,
          });
        }
        const planned = d.mode ? this.resolve(ctx, d) : null;
        const before = byDate.get(d.date);
        const same = planned
          ? before &&
            before.mode === planned.mode &&
            before.locationId === planned.locationId &&
            before.seatId === planned.seatId
          : !before;
        if (same) continue;
        // Decision #78: a day is locked at 18:00 the day before (permissions: U before cut-off).
        if (!beforeCutoff(d.date, now)) {
          throw new BadRequestException({
            message: `${dayLabel(d.date)} is past the cut-off (18:00 the day before)`,
          });
        }
        if (planned && !ctx.calendar.isWorking(d.date)) {
          throw new BadRequestException({
            message: `${dayLabel(d.date)} isn’t a working day for you`,
          });
        }
        if (planned && leave.get(d.date) === 'full') {
          throw new BadRequestException({ message: `You’re on leave on ${dayLabel(d.date)}` });
        }
        changes.push({ date: d.date, planned });
      }
      await this.authz.assert(actor, 'update', {
        area: 'hybrid_booking',
        subjectPersonId: summary.personId,
        legalEntityId: summary.legalEntityId,
        attributes: { beforeCutoff: true },
      });

      // The week as it would be.
      const merged = new Map<string, Planned>();
      for (const b of existing) {
        merged.set(b.date, {
          date: b.date,
          mode: b.mode,
          locationId: b.locationId,
          seatId: b.seatId,
        });
      }
      for (const c of changes) {
        if (c.planned) merged.set(c.date, c.planned);
        else merged.delete(c.date);
      }
      const fit = weekFit(
        ctx.policy,
        this.fitDays(ctx, weekStart, leave, merged),
        ctx.anchorWeekday,
      );
      if (fit.notAllowed.length) {
        const mode = merged.get(fit.notAllowed[0]!)!.mode;
        throw new BadRequestException({
          message: `${modeWords[mode]} isn’t allowed by your policy (${ctx.policy.name})`,
        });
      }
      const reasons = [...fit.reasons];
      for (const c of changes) {
        const p = c.planned;
        if (!p || p.mode !== 'office' || !p.locationId) continue;
        if (p.seatId) {
          const [held] = await tx
            .select({ id: workBookings.id })
            .from(workBookings)
            .where(
              and(
                eq(workBookings.seatId, p.seatId),
                eq(workBookings.date, p.date),
                inArray(workBookings.status, ['confirmed', 'pending']),
                ne(workBookings.engagementId, ctx.engagementId),
              ),
            )
            .limit(1);
          if (held) {
            const [seat] = await tx.select().from(seats).where(eq(seats.id, p.seatId));
            throw new ConflictException({
              message: `Seat ${seat!.label} is taken on ${dayLabel(p.date)}`,
            });
          }
        }
        const place = ctx.places.find((x) => x.id === p.locationId)!;
        if (place.seatCount !== null) {
          const others = await tx
            .select({ id: workBookings.id })
            .from(workBookings)
            .where(
              and(
                eq(workBookings.locationId, p.locationId),
                eq(workBookings.date, p.date),
                eq(workBookings.mode, 'office'),
                inArray(workBookings.status, ['confirmed', 'pending']),
                ne(workBookings.engagementId, ctx.engagementId),
              ),
            );
          if (others.length >= place.seatCount) {
            reasons.push(
              `${place.name} is full on ${dayLabel(p.date)} (${others.length} of ${place.seatCount} seats)`,
            );
          }
        }
      }
      if (reasons.length && !input.note?.trim()) {
        throw new BadRequestException({
          message: 'This week is below your policy: say why for your manager',
          problems: reasons,
        });
      }

      // Save: a changed day's row is cancelled and a new one added.
      for (const c of changes) {
        const before = byDate.get(c.date);
        if (before) {
          await tx
            .update(workBookings)
            .set({ status: 'cancelled', updatedAt: now, updatedBy: actor.userId })
            .where(eq(workBookings.id, before.id));
        }
        if (c.planned) {
          await tx.insert(workBookings).values({
            tenantId: requireContext().tenantId,
            engagementId: ctx.engagementId,
            personId: summary.personId,
            date: c.date,
            weekStart,
            mode: c.planned.mode,
            locationId: c.planned.locationId,
            seatId: c.planned.seatId,
            status: 'pending',
            createdBy: actor.userId,
            updatedBy: actor.userId,
          });
        }
      }
      if (changes.length === 0 && reasons.length === 0) return this.view(tx, ctx, weekStart, now);

      // An open exception for the week is replaced by this plan.
      const open = await tx
        .select()
        .from(hybridExceptions)
        .where(
          and(
            eq(hybridExceptions.engagementId, ctx.engagementId),
            eq(hybridExceptions.weekStart, weekStart),
            inArray(hybridExceptions.status, ['pending', 'returned']),
          ),
        );
      for (const x of open) {
        if (x.workflowInstanceId && x.status === 'pending') {
          await this.workflows.cancelIn(tx, x.workflowInstanceId);
        }
        await tx
          .update(hybridExceptions)
          .set({ status: 'withdrawn', updatedAt: now })
          .where(eq(hybridExceptions.id, x.id));
      }
      const live = and(
        eq(workBookings.engagementId, ctx.engagementId),
        eq(workBookings.weekStart, weekStart),
        ne(workBookings.status, 'cancelled'),
      );
      if (reasons.length === 0) {
        await tx
          .update(workBookings)
          .set({ status: 'confirmed', exceptionId: null, updatedAt: now })
          .where(live);
      } else {
        const [exception] = await tx
          .insert(hybridExceptions)
          .values({
            tenantId: requireContext().tenantId,
            engagementId: ctx.engagementId,
            personId: summary.personId,
            weekStart,
            policyId: ctx.policy.id,
            reasons,
            note: input.note!.trim(),
            status: 'pending',
            createdBy: actor.userId,
            updatedBy: actor.userId,
          })
          .returning();
        await tx
          .update(workBookings)
          .set({ status: 'pending', exceptionId: exception!.id, updatedAt: now })
          .where(live);
        const instanceId = await this.workflows.submit(tx, {
          key: 'hybrid_exception',
          subjectPersonId: summary.personId,
          title: `Hybrid week below policy: ${summary.preferredName ?? summary.legalName}, week of ${dayLabel(weekStart)}`,
          payload: { exceptionId: exception!.id },
        });
        await tx
          .update(hybridExceptions)
          .set({ workflowInstanceId: instanceId })
          .where(eq(hybridExceptions.id, exception!.id));
      }
      return this.view(tx, ctx, weekStart, now);
    });
  }

  // ---- The Friday reminder ----

  /**
   * Spec notifications: "Hybrid week below policy", Friday 12:00 for the next week, to each person
   * whose plan is below their policy and not already waiting for approval. Once a week.
   */
  async remindBelowPolicy(now = new Date()): Promise<{ reminded: number }> {
    const week = addDays(mondayOf(businessDate(now)), 7);
    const link = `/hybrid?week=${week}`;
    return this.db.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(engagements)
        .where(
          and(
            inArray(engagements.status, [...WORKING]),
            lte(engagements.joiningDate, addDays(week, 6)),
            or(isNull(engagements.lastWorkingDate), gte(engagements.lastWorkingDate, week)),
          ),
        );
      let reminded = 0;
      for (const engagement of rows) {
        const summary = await this.people.summary(engagement.personId);
        if (summary.engagementId !== engagement.id) continue;
        const ctx = await this.contextOf(tx, summary, week);
        if (!ctx.policy || ctx.policy.requiredDays === 0) continue;
        const [waiting] = await tx
          .select({ id: hybridExceptions.id })
          .from(hybridExceptions)
          .where(
            and(
              eq(hybridExceptions.engagementId, engagement.id),
              eq(hybridExceptions.weekStart, week),
              inArray(hybridExceptions.status, ['pending', 'approved']),
            ),
          )
          .limit(1);
        if (waiting) continue;
        const leave = await this.leaveIn(tx, engagement.id, week);
        const planned = new Map(
          (await this.bookingsOf(tx, engagement.id, week)).map((b) => [
            b.date,
            { date: b.date, mode: b.mode, locationId: b.locationId, seatId: b.seatId },
          ]),
        );
        const fit = weekFit(ctx.policy, this.fitDays(ctx, week, leave, planned), ctx.anchorWeekday);
        if (fit.fits) continue;
        const userId = await userOfPerson(tx, engagement.personId);
        if (!userId) continue;
        const [sent] = await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.recipientUserId, userId),
              eq(notifications.kind, 'hybrid_below_policy'),
              eq(notifications.link, link),
            ),
          )
          .limit(1);
        if (sent) continue;
        await notify(
          tx,
          [userId],
          'hybrid_below_policy',
          `Plan next week: ${fit.reasons[0]}`,
          link,
        );
        reminded++;
      }
      return { reminded };
    });
  }

  // ---- Internals ----

  private async self(action: 'create' | 'read') {
    const actor = requireContext().actor!;
    if (!actor.personId) throw new ForbiddenException();
    const summary = await this.people.summary(actor.personId);
    await this.authz.assert(actor, action, {
      area: 'hybrid_booking',
      subjectPersonId: summary.personId,
      legalEntityId: summary.legalEntityId,
    });
    return summary;
  }

  /** Default policies created on first use (race-safe), like leave types. */
  private async ensurePolicies(tx: Tx): Promise<PolicyRow[]> {
    let rows = await tx.select().from(workPolicies).orderBy(asc(workPolicies.priority));
    if (rows.length === 0) {
      await tx
        .insert(workPolicies)
        .values(defaultWorkPolicies.map((p) => ({ tenantId: requireContext().tenantId, ...p })))
        .onConflictDoNothing();
      rows = await tx.select().from(workPolicies).orderBy(asc(workPolicies.priority));
    }
    return rows;
  }

  /** Who someone is for planning a week: their policy, calendar, anchor day and places. */
  async contextOf(tx: Tx, summary: PersonSummary, weekStart: string): Promise<Context> {
    const places = await this.placesOn(tx, weekStart, summary.legalEntityId);
    const home = summary.location ? places.find((p) => p.id === summary.location!.id) : undefined;
    const facts = {
      legalEntityId: summary.legalEntityId,
      engagementType: summary.engagementType,
      departmentId: summary.department?.id ?? null,
      locationId: summary.location?.id ?? null,
    };
    const homeType = home?.type ?? (summary.location ? 'remote' : null);
    const policy =
      (await this.ensurePolicies(tx)).find(
        (p) =>
          p.active &&
          appliesToMatches(p.appliesTo, facts) &&
          (p.locationTypes.length === 0 ||
            (homeType !== null && p.locationTypes.includes(homeType))),
      ) ?? null;
    let anchorWeekday: number | null = null;
    if (summary.manager) {
      const [anchor] = await tx
        .select({ weekday: teamAnchorDays.weekday })
        .from(teamAnchorDays)
        .where(eq(teamAnchorDays.managerEngagementId, summary.manager.engagementId));
      anchorWeekday = anchor?.weekday ?? null;
    }
    return {
      summary,
      engagementId: summary.engagementId,
      policy,
      calendar: await this.shifts.calendarForEngagement(tx, summary.engagementId),
      anchorWeekday,
      homeLocationId: home?.id ?? null,
      places,
    };
  }

  /** Offices and client sites in force on a day (optionally one legal entity's). */
  private async placesOn(tx: Tx, day: string, legalEntityId?: string): Promise<Place[]> {
    const rows = await tx
      .select({
        id: locations.id,
        legalEntityId: locations.legalEntityId,
        name: locationVersions.name,
        type: locationVersions.type,
        seatCount: locationVersions.seatCount,
      })
      .from(locations)
      .innerJoin(
        locationVersions,
        and(
          eq(locationVersions.locationId, locations.id),
          inForce(locationVersions.effectiveFrom, locationVersions.effectiveTo, day),
        ),
      )
      .where(isNull(locations.deletedAt))
      .orderBy(asc(locationVersions.name));
    return rows
      .filter((r) => r.type !== 'remote' && (!legalEntityId || r.legalEntityId === legalEntityId))
      .map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type as Place['type'],
        seatCount: r.seatCount,
      }));
  }

  /** A day as asked, with the office or client site filled in from the person's own location. */
  private resolve(ctx: Context, d: WeekPlanInput['days'][number]): Planned {
    const mode = d.mode!;
    if (mode === 'wfh') {
      if (d.locationId || d.seatId) {
        throw new BadRequestException({ message: 'A WFH day has no location or seat' });
      }
      return { date: d.date, mode, locationId: null, seatId: null };
    }
    const wanted = mode === 'office' ? 'office' : 'client_site';
    const home = ctx.places.find((p) => p.id === ctx.homeLocationId);
    const locationId = d.locationId ?? (home?.type === wanted ? home.id : null);
    if (locationId) {
      const place = ctx.places.find((p) => p.id === locationId);
      if (!place || place.type !== wanted) {
        throw new BadRequestException({
          message: mode === 'office' ? 'Choose an office' : 'Choose a client site',
        });
      }
    } else if (mode === 'office') {
      throw new BadRequestException({ message: `Choose an office for ${dayLabel(d.date)}` });
    }
    if (d.seatId && mode !== 'office') {
      throw new BadRequestException({ message: 'Seats are for office days' });
    }
    return { date: d.date, mode, locationId, seatId: d.seatId ?? null };
  }

  private fitDays(
    ctx: Context,
    weekStart: string,
    leave: Map<string, 'full' | 'first' | 'second'>,
    planned: Map<string, Planned>,
  ): FitDay[] {
    return Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      return {
        date,
        working: ctx.calendar.isWorking(date),
        onLeave: leave.get(date) === 'full',
        mode: planned.get(date)?.mode ?? null,
      };
    });
  }

  private bookingsOf(tx: Tx, engagementId: string, weekStart: string): Promise<BookingRow[]> {
    return tx
      .select()
      .from(workBookings)
      .where(
        and(
          eq(workBookings.engagementId, engagementId),
          eq(workBookings.weekStart, weekStart),
          inArray(workBookings.status, [...LIVE]),
        ),
      );
  }

  /** Leave in the week, approved or asked for; two halves make a full day. */
  private async leaveIn(tx: Tx, engagementId: string, weekStart: string) {
    const rows = await tx
      .select({ day: leaveRequestDays.day, half: leaveRequestDays.half })
      .from(leaveRequestDays)
      .innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
      .where(
        and(
          eq(leaveRequestDays.engagementId, engagementId),
          isNull(leaveRequestDays.cancelledAt),
          inArray(leaveRequests.status, ['applied', 'returned', 'approved']),
          gte(leaveRequestDays.day, weekStart),
          lte(leaveRequestDays.day, addDays(weekStart, 6)),
        ),
      );
    const out = new Map<string, 'full' | 'first' | 'second'>();
    for (const r of rows) {
      const seen = out.get(r.day);
      out.set(r.day, !seen ? r.half : seen !== r.half || r.half === 'full' ? 'full' : seen);
    }
    return out;
  }

  private async view(tx: Tx, ctx: Context, weekStart: string, now: Date): Promise<WeekPlanView> {
    const bookings = await this.bookingsOf(tx, ctx.engagementId, weekStart);
    const leave = await this.leaveIn(tx, ctx.engagementId, weekStart);
    const seatRows = bookings.some((b) => b.seatId)
      ? await tx
          .select()
          .from(seats)
          .where(
            inArray(
              seats.id,
              bookings.filter((b) => b.seatId).map((b) => b.seatId!),
            ),
          )
      : [];
    const byDate = new Map(bookings.map((b) => [b.date, b]));
    const days: WeekDayView[] = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      const b = byDate.get(date);
      const work = ctx.calendar.dayOn(date);
      return {
        date,
        working: ctx.calendar.isWorking(date),
        holiday: work.holiday && !work.holiday.optional ? work.holiday.name : null,
        leave: leave.get(date) ?? null,
        booking: b
          ? {
              mode: b.mode,
              locationId: b.locationId,
              locationName: ctx.places.find((p) => p.id === b.locationId)?.name ?? null,
              seatId: b.seatId,
              seatLabel: seatRows.find((s) => s.id === b.seatId)?.label ?? null,
              status: b.status as 'confirmed' | 'pending' | 'rejected',
            }
          : null,
        editable: beforeCutoff(date, now),
        cutoffAt: cutoffOf(date).toISOString(),
      };
    });
    const planned = new Map(
      bookings.map((b) => [
        b.date,
        { date: b.date, mode: b.mode, locationId: b.locationId, seatId: b.seatId },
      ]),
    );
    const fit = ctx.policy
      ? weekFit(ctx.policy, this.fitDays(ctx, weekStart, leave, planned), ctx.anchorWeekday)
      : { target: 0, booked: 0, fits: true, reasons: [] };
    const [exception] = await tx
      .select()
      .from(hybridExceptions)
      .where(
        and(
          eq(hybridExceptions.engagementId, ctx.engagementId),
          eq(hybridExceptions.weekStart, weekStart),
          inArray(hybridExceptions.status, ['pending', 'approved', 'returned']),
        ),
      )
      .orderBy(asc(hybridExceptions.createdAt));
    return {
      weekStart,
      policy: ctx.policy
        ? {
            id: ctx.policy.id,
            name: ctx.policy.name,
            requiredMode: ctx.policy.requiredMode,
            requiredDays: ctx.policy.requiredDays,
            anchorDayRequired: ctx.policy.anchorDayRequired,
            allowedModes: ctx.policy.allowedModes,
          }
        : null,
      anchorWeekday: ctx.anchorWeekday,
      days,
      fit: { target: fit.target, booked: fit.booked, fits: fit.fits, reasons: fit.reasons },
      exception: exception
        ? {
            status: exception.status as 'pending' | 'approved' | 'returned',
            note: exception.note,
            requestId: exception.workflowInstanceId,
          }
        : null,
      places: ctx.places,
      homeLocationId: ctx.homeLocationId,
    };
  }

  /** The manager's decision: approved confirms the week's bookings; returned rejects them. */
  private async decide(
    tx: Tx,
    id: string,
    outcome: 'approved' | 'returned' | 'withdrawn',
  ): Promise<void> {
    const now = new Date();
    const [row] = await tx.select().from(hybridExceptions).where(eq(hybridExceptions.id, id));
    if (!row || row.status !== 'pending') return;
    await tx
      .update(hybridExceptions)
      .set({ status: outcome, updatedAt: now })
      .where(eq(hybridExceptions.id, id));
    if (outcome === 'withdrawn') return;
    await tx
      .update(workBookings)
      .set({ status: outcome === 'approved' ? 'confirmed' : 'rejected', updatedAt: now })
      .where(and(eq(workBookings.exceptionId, id), eq(workBookings.status, 'pending')));
  }

  /** The card: the week, the plan day by day, how it falls short and why. */
  private async describe(tx: Tx, id: string): Promise<ChangeLine[]> {
    const [row] = await tx.select().from(hybridExceptions).where(eq(hybridExceptions.id, id));
    if (!row) return [];
    return this.describeRow(tx, row);
  }

  private async describeRow(tx: Tx, row: ExceptionRow): Promise<ChangeLine[]> {
    const [policy] = await tx.select().from(workPolicies).where(eq(workPolicies.id, row.policyId));
    const bookings = await tx
      .select()
      .from(workBookings)
      .where(and(eq(workBookings.exceptionId, row.id), ne(workBookings.status, 'cancelled')))
      .orderBy(asc(workBookings.date));
    const places = await this.placesOn(tx, row.weekStart);
    const plan = bookings
      .map((b) => {
        const where = places.find((p) => p.id === b.locationId)?.name;
        return `${dayLabel(b.date).split(' ')[0]} ${modeWords[b.mode]}${where ? ` (${where})` : ''}`;
      })
      .join(', ');
    const lines: ChangeLine[] = [
      {
        label: 'Week',
        from: null,
        to: `${dayLabel(row.weekStart)} – ${dayLabel(addDays(row.weekStart, 6))}`,
      },
      { label: 'Plan', from: null, to: plan || 'Nothing booked' },
      {
        label: 'Policy fit',
        from: null,
        to: `${policy?.name ?? 'Policy'} · ${row.reasons.join('; ')}`,
      },
    ];
    if (row.note) lines.push({ label: 'Reason', from: null, to: row.note });
    return lines;
  }
}

function seatView(row: typeof seats.$inferSelect): SeatView {
  return {
    id: row.id,
    locationId: row.locationId,
    label: row.label,
    zone: row.zone,
    active: row.active,
  };
}

function assertMonday(day: string) {
  if (isoWeekday(day) !== 1) throw new BadRequestException({ message: 'A week starts on Monday' });
}
