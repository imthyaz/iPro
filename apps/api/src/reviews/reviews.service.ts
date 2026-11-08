import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  outcomesByKind,
  type ChangeLine,
  type ProbationDashboard,
  type ReviewOutcome,
  type ReviewView,
  type SubmitReviewInput,
} from '@ipro/shared';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext, type Actor } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { JourneyService } from '../journey/journey.service.js';
import { letterTemplates } from '../letters/letters.schema.js';
import { ExitService } from '../exit/exit.service.js';
import { LettersService } from '../letters/letters.service.js';
import { designations } from '../org/org.schema.js';
import { noticePeriodDays } from '../people/hr-settings.js';
import { inForce } from '../people/people.queries.js';
import { assignments, engagements } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { SettingsService } from '../people/settings.service.js';
import { WorkflowActions, type ActionInstance } from '../workflow/actions.js';
import {
  managerUserOfPerson,
  managerUserOfUser,
  notify,
  roleHolders,
  userName,
  userOfPerson,
} from '../workflow/lookups.js';
import { PayConversionsService } from '../changes/pay-conversions.service.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { CheckInsService, checkInWords } from './check-ins.service.js';
import { reviews } from './reviews.schema.js';

type ReviewRow = typeof reviews.$inferSelect;

const decidePayload = z.object({ reviewId: z.uuid(), needsHrHead: z.boolean() });

/**
 * Days before the end date a review opens, and when the manager is reminded: probation per the spec;
 * internships 14 days ahead with a reminder at 7 (decision #65, open question).
 */
const OPENS_DAYS_BEFORE = { probation: 30, internship: 14 } as const;
const REMINDERS = { probation: [14, 7], internship: [7] } as const;
const kindWords = { probation: 'probation review', internship: 'internship assessment' } as const;
const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

const outcomeWords: Record<ReviewOutcome, string> = {
  confirm: 'Confirm',
  extend: 'Extend',
  terminate: 'End employment',
  convert: 'Convert to employee',
  end: 'End the internship',
  break: 'Break',
};

/** The letter each outcome produces, by template type (decision #60). */
const letterTypes = {
  confirm: 'confirmation',
  extend: 'extension',
  terminate: 'termination',
} as const;

/**
 * Probation (spec workflow 3; decision #60): the daily sweep opens reviews 30 days before the end
 * date, reminds at 14 and 7, and escalates daily when overdue. The manager recommends; HR decides
 * (HR head for a termination); the decision writes the letter and the journey event.
 */
@Injectable()
export class ReviewsService implements OnModuleInit {
  private readonly logger = new Logger('Reviews');

  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(JourneyService) private readonly journey: JourneyService,
    @Inject(LettersService) private readonly letters: LettersService,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(WorkflowActions) private readonly actions: WorkflowActions,
    @Inject(CheckInsService) private readonly checkIns: CheckInsService,
    @Inject(PayConversionsService) private readonly payConversions: PayConversionsService,
    @Inject(ExitService) private readonly exits: ExitService,
  ) {}

  onModuleInit(): void {
    this.actions.register('review.decide', {
      validate: (payload) => {
        const parsed = decidePayload.safeParse(payload);
        if (!parsed.success) throw new BadRequestException({ message: 'Invalid review decision' });
        return parsed.data;
      },
      describe: (tx, instance) => this.describe(tx, instance),
      apply: (tx, instance) => this.decide(tx, decidePayload.parse(instance.payload).reviewId),
      onStatus: async (tx, instance, status) => {
        const { reviewId } = decidePayload.parse(instance.payload);
        const [review] = await tx.select().from(reviews).where(eq(reviews.id, reviewId));
        // Returned or withdrawn: back to the manager, unless a later submission replaced it.
        if (
          review?.status === 'submitted' &&
          review.requestId === instance.id &&
          (status === 'returned' || status === 'withdrawn')
        ) {
          await this.setStatus(tx, review, 'due');
        }
      },
    });
  }

  // ---- The daily sweep ----

  /** Daily at 06:00 IST: opens due reviews, sends reminders, escalates overdue ones. */
  async sweep(now = new Date()): Promise<{
    opened: number;
    reminded: number;
    escalated: number;
    checkIns: { opened: number; reminded: number };
  }> {
    const today = businessDate(now);
    return this.db.tx(async (tx) => {
      let opened = 0;
      let reminded = 0;
      let escalated = 0;

      // Open: confirmed people have a confirmation date; extended ones get a new end date to review.
      const probation = await tx
        .select()
        .from(engagements)
        .where(
          and(
            eq(engagements.status, 'active'),
            isNull(engagements.confirmationDate),
            lte(engagements.probationEndDate, addDays(today, OPENS_DAYS_BEFORE.probation)),
          ),
        );
      // Interns: assessed before the internship ends (an extension moves the end date).
      const internships = await tx
        .select()
        .from(engagements)
        .where(
          and(
            eq(engagements.status, 'active'),
            eq(engagements.type, 'intern'),
            lte(engagements.contractEndDate, addDays(today, OPENS_DAYS_BEFORE.internship)),
          ),
        );
      const due = [
        ...probation.map((e) => ({
          engagement: e,
          kind: 'probation' as const,
          dueOn: e.probationEndDate!,
        })),
        ...internships.map((e) => ({
          engagement: e,
          kind: 'internship' as const,
          dueOn: e.contractEndDate!,
        })),
      ];
      for (const { engagement, kind, dueOn } of due) {
        const [existing] = await tx
          .select({ id: reviews.id })
          .from(reviews)
          .where(
            and(
              eq(reviews.engagementId, engagement.id),
              eq(reviews.kind, kind),
              eq(reviews.dueOn, dueOn),
            ),
          );
        if (existing) continue;
        const reviewer = await managerUserOfPerson(tx, engagement.personId, today);
        const [review] = await tx
          .insert(reviews)
          .values({
            tenantId: requireContext().tenantId,
            engagementId: engagement.id,
            personId: engagement.personId,
            kind,
            status: 'due',
            dueOn,
            reviewerUserId: reviewer,
            remindedFor: REMINDERS[kind].filter((d) => daysBetween(today, dueOn) <= d),
          })
          .returning();
        await this.audit.record(tx, {
          action: 'create',
          table: 'review',
          recordId: review!.id,
          subjectPersonId: engagement.personId,
        });
        await notify(
          tx,
          await this.reviewerUsers(tx, review!, engagement.legalEntityId),
          `${kind}_review_due`,
          `${kind === 'probation' ? 'Probation review' : 'Internship assessment'} due by ${review!.dueOn}: ${await this.nameOf(engagement.personId)}`,
          `/reviews/${review!.id}`,
        );
        opened++;
      }

      // Remind at 14 and 7 days; escalate every day once overdue.
      const open = await tx
        .select({ review: reviews, legalEntityId: engagements.legalEntityId })
        .from(reviews)
        .innerJoin(engagements, eq(engagements.id, reviews.engagementId))
        .where(eq(reviews.status, 'due'));
      for (const { review, legalEntityId } of open) {
        const left = daysBetween(today, review.dueOn);
        const name = await this.nameOf(review.personId);
        const pending = REMINDERS[review.kind].filter(
          (d) => left <= d && !review.remindedFor.includes(d),
        );
        if (left >= 0 && pending.length > 0) {
          await tx
            .update(reviews)
            .set({ remindedFor: [...review.remindedFor, ...pending] })
            .where(eq(reviews.id, review.id));
          await notify(
            tx,
            await this.reviewerUsers(tx, review, legalEntityId),
            `${review.kind}_review_reminder`,
            `Reminder: ${kindWords[review.kind]} for ${name} is due in ${left} days`,
            `/reviews/${review.id}`,
          );
          reminded++;
        }
        if (left < 0 && review.lastEscalatedOn !== today) {
          const above = review.reviewerUserId
            ? await managerUserOfUser(tx, review.reviewerUserId, today)
            : null;
          const to = [
            ...(await this.reviewerUsers(tx, review, legalEntityId)),
            ...(above ? [above] : []),
            ...(await roleHolders(tx, 'hr', legalEntityId)),
          ];
          await notify(
            tx,
            [...new Set(to)],
            `${review.kind}_review_overdue`,
            `Overdue: ${kindWords[review.kind]} for ${name} was due ${review.dueOn}`,
            `/reviews/${review.id}`,
          );
          await tx
            .update(reviews)
            .set({ lastEscalatedOn: today, escalationCount: review.escalationCount + 1 })
            .where(eq(reviews.id, review.id));
          escalated++;
        }
      }
      const checkIns = await this.checkIns.sweepIn(tx, today);
      return { opened, reminded, escalated, checkIns };
    });
  }

  // ---- The manager's review (M5) ----

  async submit(reviewId: string, input: SubmitReviewInput, now = new Date()): Promise<ReviewView> {
    const actor = requireContext().actor!;
    const review = await this.loadFor(reviewId);
    if (!(await this.canSubmit(actor, review))) throw new ForbiddenException();
    if (review.status !== 'due') {
      throw new ConflictException({ message: 'This review has already been sent' });
    }
    const today = businessDate(now);
    const summary = await this.people.summary(review.personId);
    const competencies = await this.db.tx((tx) => this.settings.get(tx, 'review_competencies'));
    const missing = competencies.filter((c) => !input.ratings[c]);
    if (missing.length > 0) {
      throw new BadRequestException({ message: 'Rate every area', problems: missing });
    }
    if (!outcomesByKind[review.kind].includes(input.recommendation)) {
      throw new BadRequestException({
        message: `An ${kindWords[review.kind]} can recommend: ${outcomesByKind[review.kind].join(', ')}`,
      });
    }
    await this.db.tx(async (tx) => {
      if (input.recommendation === 'extend')
        await this.checkExtension(tx, review, input.newEndDate!);
      if (input.lastWorkingDate && input.lastWorkingDate < today) {
        throw new BadRequestException({ message: 'The last working day has passed' });
      }
      if (review.requestId) {
        // A returned decision: replace it with this submission.
        const previous = review.requestId;
        await tx.update(reviews).set({ requestId: null }).where(eq(reviews.id, review.id));
        await this.workflows.cancelIn(tx, previous);
      }
      const requestId = await this.workflows.submit(tx, {
        key: review.kind === 'probation' ? 'probation_decision' : 'internship_decision',
        subjectPersonId: review.personId,
        title: `${review.kind === 'probation' ? 'Probation' : 'Internship'}: ${summary.preferredName ?? summary.legalName}, ${outcomeWords[input.recommendation].toLowerCase()}`,
        payload: { reviewId, needsHrHead: input.recommendation === 'terminate' },
      });
      await tx
        .update(reviews)
        .set({
          status: 'submitted',
          recommendation: input.recommendation,
          ratings: Object.fromEntries(competencies.map((c) => [c, input.ratings[c]!])),
          strengths: input.strengths ?? null,
          improvements: input.improvements ?? null,
          comments: input.comments,
          newEndDate: input.recommendation === 'extend' ? input.newEndDate! : null,
          lastWorkingDate: ['terminate', 'end', 'break'].includes(input.recommendation)
            ? input.lastWorkingDate!
            : null,
          convertTo: input.recommendation === 'convert' ? input.convertTo! : null,
          convertProbation: input.recommendation === 'convert' ? input.convertProbation! : null,
          returnBy: input.recommendation === 'break' ? (input.returnBy ?? null) : null,
          submittedAt: new Date(),
          submittedBy: actor.userId,
          requestId,
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(reviews.id, review.id));
      await this.audit.record(tx, {
        action: 'update',
        table: 'review',
        recordId: review.id,
        subjectPersonId: review.personId,
        fieldChanges: [
          { field: 'status', from: 'due', to: 'submitted' },
          { field: 'recommendation', to: input.recommendation },
        ],
      });
    });
    return this.get(reviewId);
  }

  // ---- Reading ----

  /** Reviews the signed-in user writes or may read (M5 list; HR sees everyone's). */
  async list(status?: ReviewRow['status']): Promise<ReviewView[]> {
    const actor = requireContext().actor!;
    const rows = await this.db.tx((tx) =>
      tx
        .select()
        .from(reviews)
        .where(status ? eq(reviews.status, status) : undefined)
        .orderBy(asc(reviews.dueOn)),
    );
    const views: ReviewView[] = [];
    for (const row of rows) {
      if (row.personId === actor.personId) continue;
      if (await this.mayRead(actor, row)) views.push(await this.view(row));
    }
    return views;
  }

  async get(reviewId: string): Promise<ReviewView> {
    return this.view(await this.loadFor(reviewId));
  }

  /** H7: overdue reviews, decisions waiting, probations ending within 30 days, and extensions. */
  async dashboard(now = new Date()): Promise<ProbationDashboard> {
    const actor = requireContext().actor!;
    const today = businessDate(now);
    const reviewsSeen = await this.list();
    const ending = await this.db.tx((tx) =>
      tx
        .select({
          personId: engagements.personId,
          legalEntityId: engagements.legalEntityId,
          probationEndDate: engagements.probationEndDate,
        })
        .from(engagements)
        .where(
          and(
            eq(engagements.status, 'active'),
            isNull(engagements.confirmationDate),
            gte(engagements.probationEndDate, today),
            lte(engagements.probationEndDate, addDays(today, OPENS_DAYS_BEFORE.probation)),
          ),
        )
        .orderBy(asc(engagements.probationEndDate)),
    );
    const extendedRows = await this.db.tx((tx) =>
      tx
        .selectDistinct({
          personId: engagements.personId,
          legalEntityId: engagements.legalEntityId,
          probationEndDate: engagements.probationEndDate,
        })
        .from(reviews)
        .innerJoin(engagements, eq(engagements.id, reviews.engagementId))
        .where(
          and(
            eq(reviews.decision, 'extend'),
            eq(engagements.status, 'active'),
            isNull(engagements.confirmationDate),
          ),
        ),
    );
    const visible = async <T extends { personId: string; legalEntityId: string }>(rows: T[]) => {
      const out: T[] = [];
      for (const row of rows) {
        const decision = await this.authz.check(actor, 'read', {
          area: 'probation_review',
          subjectPersonId: row.personId,
          legalEntityId: row.legalEntityId,
        });
        if (decision.allowed && row.personId !== actor.personId) out.push(row);
      }
      return out;
    };
    const open = reviewsSeen.filter((r) => r.kind === 'probation');
    return {
      checkInsOverdue: (await this.checkIns.list({ open: true })).filter((c) => c.overdue),
      internships: reviewsSeen.filter((r) => r.kind === 'internship' && r.status !== 'decided'),
      overdue: open.filter((r) => r.status === 'due' && r.overdue),
      awaitingDecision: open.filter((r) => r.status === 'submitted'),
      dueSoon: await Promise.all(
        (await visible(ending)).map(async (e) => ({
          personId: e.personId,
          name: await this.nameOf(e.personId),
          probationEndDate: e.probationEndDate!,
          reviewId:
            open.find((r) => r.person.personId === e.personId && r.status !== 'decided')?.id ??
            null,
        })),
      ),
      extended: await Promise.all(
        (await visible(extendedRows)).map(async (e) => ({
          personId: e.personId,
          name: await this.nameOf(e.personId),
          probationEndDate: e.probationEndDate!,
        })),
      ),
    };
  }

  // ---- The decision (workflow action) ----

  private async describe(tx: Tx, instance: ActionInstance): Promise<ChangeLine[]> {
    const { reviewId } = decidePayload.parse(instance.payload);
    const [review] = await tx.select().from(reviews).where(eq(reviews.id, reviewId));
    if (!review?.recommendation) return [];
    const [engagement] = await tx
      .select({
        probationEndDate: engagements.probationEndDate,
        contractEndDate: engagements.contractEndDate,
      })
      .from(engagements)
      .where(eq(engagements.id, review.engagementId));
    const lines: ChangeLine[] = [
      { label: 'Recommendation', from: null, to: outcomeWords[review.recommendation] },
      {
        label: 'Ratings',
        from: null,
        // In the form's order (stored JSON doesn't keep it).
        to: (await this.settings.get(tx, 'review_competencies'))
          .filter((area) => review.ratings[area])
          .map((area) => `${area} ${review.ratings[area]}/5`)
          .join(', '),
      },
    ];
    if (review.newEndDate) {
      lines.push(
        review.kind === 'probation'
          ? {
              label: 'Probation ends',
              from: engagement?.probationEndDate ?? null,
              to: review.newEndDate,
            }
          : {
              label: 'Internship ends',
              from: engagement?.contractEndDate ?? null,
              to: review.newEndDate,
            },
      );
    }
    if (review.convertTo) {
      lines.push({
        label: 'Becomes',
        from: 'intern',
        to: `${review.convertTo.replace('_', '-')}, ${review.convertProbation === 'policy' ? 'serves probation' : 'no probation'}`,
      });
    }
    if (review.returnBy) lines.push({ label: 'Expected back by', from: null, to: review.returnBy });
    if (review.kind === 'probation') {
      // Monthly check-ins, so HR decides with the whole probation in view (decision #63).
      const checkIns = await this.checkIns.forEngagementIn(tx, review.engagementId);
      if (checkIns.length > 0) {
        lines.push({
          label: 'Check-ins',
          from: null,
          to: checkIns
            .map(
              (c) => `Month ${c.month}: ${c.progress ? checkInWords[c.progress] : 'not recorded'}`,
            )
            .join('; '),
        });
      }
    }
    if (review.lastWorkingDate) {
      lines.push({ label: 'Last working day', from: null, to: review.lastWorkingDate });
    }
    lines.push({ label: 'Manager’s comments', from: null, to: review.comments });
    return lines;
  }

  /** Final approval: the outcome applies, with its letter and journey event, in one transaction. */
  private async decide(tx: Tx, reviewId: string): Promise<void> {
    const [review] = await tx.select().from(reviews).where(eq(reviews.id, reviewId));
    if (!review || review.status !== 'submitted' || !review.recommendation) {
      throw new ConflictException({ message: 'This review is no longer waiting for a decision' });
    }
    const outcome = review.recommendation;
    const [engagement] = await tx
      .select()
      .from(engagements)
      .where(eq(engagements.id, review.engagementId));
    if (review.kind === 'internship') {
      await this.decideInternship(tx, review, engagement!);
      return;
    }
    const today = businessDate(new Date());
    const by = { updatedAt: new Date(), updatedBy: requireContext().actor?.userId ?? null };
    let journey: {
      eventType: string;
      title: string;
      occurredOn: string;
      sensitivity: 'public' | 'manager' | 'hr';
      detail: Record<string, unknown>;
    };

    if (outcome === 'confirm') {
      const confirmedOn = addDays(engagement!.probationEndDate ?? today, 1);
      const notice = noticePeriodDays(
        false,
        await this.designationBand(tx, engagement!.id, today),
        await this.settings.get(tx, 'notice_days'),
      );
      await tx
        .update(engagements)
        .set({ confirmationDate: confirmedOn, noticePeriodDays: notice, ...by })
        .where(eq(engagements.id, engagement!.id));
      journey = {
        eventType: 'probation_confirmed',
        title: 'Probation confirmed',
        occurredOn: confirmedOn,
        sensitivity: 'public',
        detail: { probationEndDate: engagement!.probationEndDate },
      };
    } else if (outcome === 'extend') {
      await this.checkExtension(tx, review, review.newEndDate!);
      await tx
        .update(engagements)
        .set({ probationEndDate: review.newEndDate, ...by })
        .where(eq(engagements.id, engagement!.id));
      journey = {
        eventType: 'probation_extended',
        title: 'Probation extended',
        occurredOn: today,
        sensitivity: 'manager',
        detail: { from: engagement!.probationEndDate, to: review.newEndDate },
      };
    } else {
      // Decision #83: through the exit workflow, so the exit checklist, access and Exited follow.
      await this.exits.beginIn(tx, engagement!, {
        kind: 'termination',
        lastWorkingDate: review.lastWorkingDate!,
        exitReason: 'probation_terminated',
        reason: 'Probation not confirmed',
      });
      journey = {
        eventType: 'probation_terminated',
        title: 'Employment ended after probation',
        occurredOn: today,
        sensitivity: 'hr',
        detail: { lastWorkingDate: review.lastWorkingDate },
      };
    }
    await this.audit.record(tx, {
      action: 'update',
      table: 'engagement',
      recordId: engagement!.id,
      subjectPersonId: review.personId,
      fieldChanges: [{ field: 'probation_outcome', to: outcome }],
    });
    await tx
      .update(reviews)
      .set({ status: 'decided', decision: outcome, decidedAt: new Date(), ...by })
      .where(eq(reviews.id, review.id));
    await this.journey.record(tx, {
      engagementId: engagement!.id,
      personId: review.personId,
      category: 'lifecycle',
      sourceTable: 'review',
      sourceId: review.id,
      ...journey,
    });
    // Probation outcomes only reach here (internships return above).
    await this.outcomeLetter(
      tx,
      review,
      outcome as keyof typeof letterTypes,
      engagement!.legalEntityId,
    );
    const employee = await userOfPerson(tx, review.personId);
    if (employee && outcome !== 'terminate') {
      await notify(
        tx,
        [employee],
        `probation_${outcome}`,
        outcome === 'confirm'
          ? 'Your probation is confirmed'
          : `Your probation is extended to ${review.newEndDate}`,
        '/me',
      );
    }
  }

  /**
   * The outcome's letter, from the active template of its type; sent for signature when the template
   * is signed. A letter that can't be made never undoes the decision: HR is told instead.
   */
  private async outcomeLetter(
    tx: Tx,
    review: ReviewRow,
    outcome: keyof typeof letterTypes,
    legalEntityId: string,
  ): Promise<void> {
    const [template] = await tx
      .select({ key: letterTemplates.key, signature: letterTemplates.signature })
      .from(letterTemplates)
      .where(and(eq(letterTemplates.type, letterTypes[outcome]), eq(letterTemplates.active, true)))
      .orderBy(asc(letterTemplates.name))
      .limit(1);
    const hr = await roleHolders(tx, 'hr', legalEntityId);
    const name = await this.nameOf(review.personId);
    if (!template) {
      await notify(
        tx,
        hr,
        'letter_needed',
        `No ${letterTypes[outcome]} letter template: make ${name}’s letter from their record`,
        `/people/${review.personId}`,
      );
      return;
    }
    try {
      const summary = await this.people.summary(review.personId);
      const letterId = await this.letters.generateIn(tx, summary, {
        templateKey: template.key,
        extra: {},
        approval: false,
      });
      if (template.signature === 'employee') await this.letters.sendIn(tx, letterId);
    } catch (error) {
      this.logger.warn(
        `Outcome letter for review ${review.id} not made: ${(error as Error).message}`,
      );
      await notify(
        tx,
        hr,
        'letter_needed',
        `Couldn’t make ${name}’s ${letterTypes[outcome]} letter; make it from their record`,
        `/people/${review.personId}`,
      );
    }
  }

  // ---- Internals ----

  /**
   * An intern's assessment, decided (decision #65): convert starts a conversion request (HR head, then
   * CXO); extend moves the end date; end and break finish the internship on the agreed day, rehire
   * eligible (the exit itself comes with slice 9). One journey event says what was decided.
   */
  private async decideInternship(
    tx: Tx,
    review: ReviewRow,
    engagement: typeof engagements.$inferSelect,
  ): Promise<void> {
    const outcome = review.recommendation!;
    const today = businessDate(new Date());
    const by = { updatedAt: new Date(), updatedBy: requireContext().actor?.userId ?? null };
    let detail: Record<string, unknown>;
    if (outcome === 'convert') {
      const from =
        engagement.contractEndDate && engagement.contractEndDate >= today
          ? addDays(engagement.contractEndDate, 1)
          : today;
      const result = await this.payConversions.requestConversion(review.personId, {
        effectiveFrom: from,
        type: review.convertTo!,
        probation: review.convertProbation!,
        reason: 'Internship assessment',
      });
      detail = { convertTo: review.convertTo, from, ...result };
    } else if (outcome === 'extend') {
      await tx
        .update(engagements)
        .set({ contractEndDate: review.newEndDate, ...by })
        .where(eq(engagements.id, engagement.id));
      detail = { from: engagement.contractEndDate, to: review.newEndDate };
    } else {
      // Decision #83: the internship ends through the exit workflow (checklist, access, Exited).
      await this.exits.beginIn(tx, engagement, {
        kind: 'end_of_term',
        lastWorkingDate: review.lastWorkingDate!,
        exitReason: outcome === 'break' ? 'internship_break' : 'internship_completed',
        rehireEligible: true,
      });
      await tx
        .update(engagements)
        .set({ rehireEligible: true, ...by })
        .where(eq(engagements.id, engagement.id));
      detail = { lastWorkingDate: review.lastWorkingDate, returnBy: review.returnBy };
    }
    await this.audit.record(tx, {
      action: 'update',
      table: 'engagement',
      recordId: engagement.id,
      subjectPersonId: review.personId,
      fieldChanges: [{ field: 'internship_outcome', to: outcome }],
    });
    await tx
      .update(reviews)
      .set({ status: 'decided', decision: outcome, decidedAt: new Date(), ...by })
      .where(eq(reviews.id, review.id));
    const titles = {
      convert: 'Internship: converting to employee',
      extend: 'Internship extended',
      end: 'Internship completed',
      break: 'Internship paused for a break',
    } as Record<string, string>;
    await this.journey.record(tx, {
      engagementId: engagement.id,
      personId: review.personId,
      eventType: `internship_${outcome}`,
      category: 'lifecycle',
      occurredOn: today,
      title: titles[outcome]!,
      detail,
      sensitivity: 'manager',
      sourceTable: 'review',
      sourceId: review.id,
    });
    const employee = await userOfPerson(tx, review.personId);
    if (employee) {
      await notify(tx, [employee], `internship_${outcome}`, titles[outcome]!, '/me');
    }
  }

  /** Policy: at most N extensions, each up to M months past the current end date. */
  private async checkExtension(tx: Tx, review: ReviewRow, newEndDate: string): Promise<void> {
    if (review.kind === 'internship') {
      if (newEndDate <= review.dueOn) {
        throw new BadRequestException({
          message: `The new end date must be after ${review.dueOn}`,
        });
      }
      return;
    }
    const policy = await this.settings.get(tx, 'probation_extension');
    const [{ used }] = (await tx
      .select({ used: sql<number>`count(*)::int` })
      .from(reviews)
      .where(
        and(eq(reviews.engagementId, review.engagementId), eq(reviews.decision, 'extend')),
      )) as [{ used: number }];
    if (used >= policy.max_count) {
      throw new BadRequestException({
        message: `Probation can be extended ${policy.max_count} time(s); it already has been`,
      });
    }
    const [engagement] = await tx
      .select({ probationEndDate: engagements.probationEndDate })
      .from(engagements)
      .where(eq(engagements.id, review.engagementId));
    const current = engagement!.probationEndDate!;
    const limit = new Date(`${current}T00:00:00Z`);
    limit.setUTCMonth(limit.getUTCMonth() + policy.max_months);
    if (newEndDate <= current || newEndDate > limit.toISOString().slice(0, 10)) {
      throw new BadRequestException({
        message: `The new end date must be after ${current} and within ${policy.max_months} months of it`,
      });
    }
  }

  private async designationBand(tx: Tx, engagementId: string, day: string): Promise<string> {
    const [row] = await tx
      .select({ band: designations.designationBand })
      .from(assignments)
      .innerJoin(designations, eq(designations.id, assignments.designationId))
      .where(
        and(
          eq(assignments.engagementId, engagementId),
          inForce(assignments.effectiveFrom, assignments.effectiveTo, day),
        ),
      );
    return row?.band ?? 'associate';
  }

  private async reviewerUsers(tx: Tx, review: ReviewRow, legalEntityId: string): Promise<string[]> {
    return review.reviewerUserId ? [review.reviewerUserId] : roleHolders(tx, 'hr', legalEntityId);
  }

  /** The reviewer, or a manager of the person (e.g. after a change of manager); HR when nobody is. */
  private async canSubmit(actor: Actor, review: ReviewRow): Promise<boolean> {
    if (review.reviewerUserId === actor.userId) return true;
    const summary = await this.people.summary(review.personId);
    const decision = await this.authz.check(actor, 'create', {
      area: 'probation_review',
      subjectPersonId: review.personId,
      legalEntityId: summary.legalEntityId,
    });
    if (decision.allowed) return true;
    return review.reviewerUserId === null && actor.roles.some((g) => g.role === 'hr');
  }

  private async mayRead(actor: Actor, review: ReviewRow): Promise<boolean> {
    if (review.reviewerUserId === actor.userId) return true;
    const summary = await this.people.summary(review.personId);
    const decision = await this.authz.check(actor, 'read', {
      area: 'probation_review',
      subjectPersonId: review.personId,
      legalEntityId: summary.legalEntityId,
      attributes: { decided: review.status === 'decided' },
    });
    return decision.allowed;
  }

  private async loadFor(reviewId: string): Promise<ReviewRow> {
    const [review] = await this.db.tx((tx) =>
      tx.select().from(reviews).where(eq(reviews.id, reviewId)),
    );
    if (!review || !(await this.mayRead(requireContext().actor!, review))) {
      throw new NotFoundException();
    }
    return review;
  }

  private async setStatus(tx: Tx, review: ReviewRow, status: ReviewRow['status']): Promise<void> {
    await tx
      .update(reviews)
      .set({ status, updatedAt: new Date() })
      .where(eq(reviews.id, review.id));
    await this.audit.record(tx, {
      action: 'update',
      table: 'review',
      recordId: review.id,
      subjectPersonId: review.personId,
      fieldChanges: [{ field: 'status', from: review.status, to: status }],
    });
  }

  private async nameOf(personId: string): Promise<string> {
    const summary = await this.people.summary(personId);
    return summary.preferredName ?? summary.legalName;
  }

  private async view(review: ReviewRow): Promise<ReviewView> {
    const actor = requireContext().actor!;
    const summary = await this.people.summary(review.personId);
    const today = businessDate(new Date());
    return this.db.tx(async (tx) => {
      const policy = await this.settings.get(tx, 'probation_extension');
      const [{ used }] = (await tx
        .select({ used: sql<number>`count(*)::int` })
        .from(reviews)
        .where(
          and(eq(reviews.engagementId, review.engagementId), inArray(reviews.decision, ['extend'])),
        )) as [{ used: number }];
      return {
        id: review.id,
        kind: review.kind,
        status: review.status,
        person: { personId: review.personId, name: summary.preferredName ?? summary.legalName },
        employeeCode: summary.employeeCode,
        designation: summary.designation?.title ?? null,
        joiningDate: summary.joiningDate,
        dueOn: review.dueOn,
        overdue: review.status === 'due' && review.dueOn < today,
        reviewer: review.reviewerUserId ? await userName(tx, review.reviewerUserId) : 'HR',
        competencies: await this.settings.get(tx, 'review_competencies'),
        outcomes: [...outcomesByKind[review.kind]],
        recommendation: review.recommendation,
        ratings: review.ratings,
        strengths: review.strengths,
        improvements: review.improvements,
        comments: review.comments,
        newEndDate: review.newEndDate,
        lastWorkingDate: review.lastWorkingDate,
        convertTo: review.convertTo,
        convertProbation: review.convertProbation,
        returnBy: review.returnBy,
        submittedAt: review.submittedAt?.toISOString() ?? null,
        decision: review.decision,
        decidedAt: review.decidedAt?.toISOString() ?? null,
        requestId: review.requestId,
        extensions: { used, max: policy.max_count, maxMonths: policy.max_months },
        checkIns:
          review.kind === 'probation'
            ? await Promise.all(
                (await this.checkIns.forEngagementIn(tx, review.engagementId)).map((c) =>
                  this.checkIns.view(c),
                ),
              )
            : [],
        canSubmit: review.status === 'due' && (await this.canSubmit(actor, review)),
      };
    });
  }
}
