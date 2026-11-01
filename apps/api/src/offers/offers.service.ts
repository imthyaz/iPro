import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type {
  BandCheck,
  ChangeLine,
  CreateOfferInput,
  OfferStatus,
  OfferView,
  PersonSummary,
} from '@ipro/shared';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { appUsers, roleAssignments } from '../identity/identity.schema.js';
import { GUEST_INVITES, type GuestInvites } from '../invites/guest-invites.js';
import { JourneyService } from '../journey/journey.service.js';
import { letters, letterTemplates } from '../letters/letters.schema.js';
import { LettersService } from '../letters/letters.service.js';
import { designations, grades } from '../org/org.schema.js';
import { compensations, engagements, persons } from '../people/people.schema.js';
import { linkUsersToPerson, PeopleService } from '../people/people.service.js';
import { SettingsService } from '../people/settings.service.js';
import { ChecklistsService } from '../workflow/checklists.service.js';
import { WorkflowActions, type ActionInstance } from '../workflow/actions.js';
import { managerUserOfPerson, notify, roleHolders } from '../workflow/lookups.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { offers } from './offers.schema.js';

type OfferRow = typeof offers.$inferSelect;

const releasePayload = z.object({ offerId: z.uuid(), needsHrHead: z.boolean() });

const bandWords: Record<BandCheck, string> = {
  within: 'Within the grade band',
  above: 'Above the grade band',
  no_band: 'No band to check (unpaid, or the grade has no band)',
  not_comparable: 'Day or hour rate: not comparable with the annual band',
};

const closingEvents = {
  declined: { eventType: 'offer_declined', title: 'Offer declined' },
  withdrawn: { eventType: 'offer_withdrawn', title: 'Offer withdrawn' },
  no_show: { eventType: 'no_show', title: 'Did not join' },
} as const;

/** HR head approves pay above the band, and rates that can't be compared with it (decision #54). */
export const needsHrHead = (check: BandCheck) => check === 'above' || check === 'not_comparable';

/** Annual pay against the grade's band maximum; pay is integer paise. */
export function checkBand(
  pay: { amount: string; rateUnit: string } | undefined,
  bandMax: bigint | null,
): BandCheck {
  if (!pay || bandMax === null) return 'no_band';
  const perYear = { year: 1n, month: 12n }[pay.rateUnit];
  if (!perYear) return 'not_comparable';
  return BigInt(pay.amount) * perYear > bandMax ? 'above' : 'within';
}

/**
 * Offer to joining (spec workflow 1; decision #54): HR drafts an offer, the hiring manager (and HR head
 * above band) approve, the candidate signs, onboarding starts, and HR marks the joining.
 */
@Injectable()
export class OffersService implements OnModuleInit {
  private readonly logger = new Logger('Offers');

  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(JourneyService) private readonly journey: JourneyService,
    @Inject(LettersService) private readonly letters: LettersService,
    @Inject(ChecklistsService) private readonly checklists: ChecklistsService,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(WorkflowActions) private readonly actions: WorkflowActions,
    @Inject(GUEST_INVITES) private readonly invites: GuestInvites,
  ) {}

  onModuleInit(): void {
    this.actions.register('offer.release', {
      validate: (payload) => {
        const parsed = releasePayload.safeParse(payload);
        if (!parsed.success) throw new BadRequestException({ message: 'Invalid offer request' });
        return parsed.data;
      },
      describe: (tx, instance) => this.describe(tx, instance),
      apply: (tx, instance) => this.release(tx, releasePayload.parse(instance.payload).offerId),
      onStatus: (tx, instance, status) =>
        this.onRequestStatus(
          tx,
          releasePayload.parse(instance.payload).offerId,
          instance.id,
          status,
        ),
    });
    this.letters.onSettled(async (tx, letter) => {
      const [offer] = await tx
        .select()
        .from(offers)
        .where(and(eq(offers.letterId, letter.letterId), eq(offers.status, 'offered')));
      if (!offer) return;
      if (letter.state === 'signed') await this.acceptIn(tx, offer);
      else if (letter.state === 'declined')
        await this.closeIn(tx, offer, 'declined', 'Declined at signing');
      else await this.closeIn(tx, offer, 'withdrawn', 'Signing request cancelled at the provider');
    });
  }

  // ---- HR actions ----

  /** H3: the candidate, role, pay and letter template, saved as a draft offer. */
  async create(input: CreateOfferInput, now = new Date()): Promise<OfferView> {
    const { actor, tenantId } = requireContext();
    const legalEntityId = input.engagement.legalEntityId;
    await this.authz.assert(actor!, 'create', { area: 'assignment_history', legalEntityId });
    if (input.compensation) {
      await this.authz.assert(actor!, 'create', { area: 'compensation', legalEntityId });
    }
    const offerId = await this.db.tx(async (tx) => {
      await this.assertOfferTemplate(tx, input.letterTemplateKey);
      const [band] = await tx
        .select({ bandMax: grades.bandMax })
        .from(designations)
        .innerJoin(grades, eq(grades.id, designations.gradeId))
        .where(eq(designations.id, input.assignment.designationId));
      const bandCheck = checkBand(input.compensation, band?.bandMax ?? null);
      const created = await this.people.createIn(
        tx,
        {
          person: input.person,
          engagement: {
            legalEntityId,
            type: input.engagement.type,
            joiningDate: input.engagement.joiningDate,
            contractEndDate: input.engagement.endDate ?? null,
          },
          assignment: input.assignment,
          compensation: input.compensation,
        },
        now,
        { offer: true },
      );
      const [offer] = await tx
        .insert(offers)
        .values({
          tenantId,
          personId: created.personId,
          engagementId: created.engagementId,
          status: 'draft',
          bandCheck,
          letterTemplateKey: input.letterTemplateKey,
          extra: input.extra ?? {},
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        })
        .returning({ id: offers.id });
      await this.audit.record(tx, {
        action: 'create',
        table: 'offer',
        recordId: offer!.id,
        subjectPersonId: created.personId,
      });
      return offer!.id;
    });
    return this.get(offerId);
  }

  /** Generates the offer letter and sends the offer for approval (again, after a return). */
  async submit(offerId: string): Promise<OfferView> {
    const offer = await this.loadFor(offerId, 'update');
    if (offer.status !== 'draft') {
      throw new ConflictException({ message: 'Only a draft offer can be sent for approval' });
    }
    const summary = await this.people.summary(offer.personId);
    await this.db.tx(async (tx) => {
      if (offer.approvalRequestId) {
        // Detach the returned request first, so withdrawing it leaves the offer alone.
        const previous = offer.approvalRequestId;
        await tx.update(offers).set({ approvalRequestId: null }).where(eq(offers.id, offerId));
        await this.workflows.cancelIn(tx, previous);
      }
      let letterId = offer.letterId;
      if (letterId) {
        const [letter] = await tx.select().from(letters).where(eq(letters.id, letterId));
        if (letter?.status !== 'ready') letterId = null;
      }
      letterId ??= await this.letters.generateIn(tx, summary, {
        templateKey: offer.letterTemplateKey,
        extra: offer.extra,
        approval: false,
      });
      const requestId = await this.workflows.submit(tx, {
        key: 'offer_approval',
        subjectPersonId: offer.personId,
        title:
          `Offer: ${summary.preferredName ?? summary.legalName}, ${summary.designation?.title ?? ''}`.replace(
            /, $/,
            '',
          ),
        payload: { offerId, needsHrHead: needsHrHead(offer.bandCheck) },
      });
      await this.setStatus(tx, offer, 'pending_approval', {
        letterId,
        approvalRequestId: requestId,
      });
    });
    return this.get(offerId);
  }

  /** The candidate told HR they won't take it. */
  async decline(offerId: string, reason: string): Promise<OfferView> {
    const offer = await this.loadFor(offerId, 'update');
    if (offer.status !== 'offered') {
      throw new ConflictException({ message: 'Only an offer out for signature can be declined' });
    }
    await this.db.tx((tx) => this.closeIn(tx, offer, 'declined', reason));
    return this.get(offerId);
  }

  /** The company takes the offer back, at any point before joining. */
  async withdraw(offerId: string, reason: string): Promise<OfferView> {
    const offer = await this.loadFor(offerId, 'update');
    if (!['draft', 'pending_approval', 'offered', 'accepted'].includes(offer.status)) {
      throw new ConflictException({ message: 'This offer is already closed' });
    }
    await this.db.tx((tx) => this.closeIn(tx, offer, 'withdrawn', reason));
    return this.get(offerId);
  }

  /** An accepted joiner who didn't turn up. */
  async noShow(offerId: string, reason: string): Promise<OfferView> {
    const offer = await this.loadFor(offerId, 'update');
    if (offer.status !== 'accepted') {
      throw new ConflictException({ message: 'Only an accepted offer can be a no-show' });
    }
    await this.db.tx((tx) => this.closeIn(tx, offer, 'no_show', reason));
    return this.get(offerId);
  }

  /**
   * Day 1: on or after the joining date, once the mandatory onboarding tasks due by then are done or
   * waived. The engagement becomes active and the Joined event is written.
   */
  async join(offerId: string, workEmail: string, now = new Date()): Promise<OfferView> {
    const offer = await this.loadFor(offerId, 'update');
    if (offer.status !== 'accepted') {
      throw new ConflictException({ message: 'Only an accepted offer can be marked joined' });
    }
    const summary = await this.people.summary(offer.personId);
    const today = businessDate(now);
    if (summary.joiningDate > today) {
      throw new ConflictException({ message: 'The joining date hasn’t come yet' });
    }
    await this.db.tx(async (tx) => {
      const open = await this.checklists.openMandatoryDueBy(
        tx,
        offer.engagementId,
        summary.joiningDate,
      );
      if (open.length > 0) {
        throw new ConflictException({
          message: 'Day-1 tasks are still open; finish or waive them first',
          problems: open,
        });
      }
      const [taken] = await tx
        .select({ id: engagements.id })
        .from(engagements)
        .where(
          and(
            sql`lower(${engagements.workEmail}) = lower(${workEmail})`,
            ne(engagements.id, offer.engagementId),
            inArray(engagements.status, ['offered', 'pre_joining', 'active', 'on_notice']),
          ),
        );
      if (taken)
        throw new ConflictException({ message: 'That work email belongs to someone else' });
      const actor = requireContext().actor!;
      await tx
        .update(engagements)
        .set({ status: 'active', workEmail, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(engagements.id, offer.engagementId));
      await this.audit.record(tx, {
        action: 'update',
        table: 'engagement',
        recordId: offer.engagementId,
        subjectPersonId: offer.personId,
        fieldChanges: [{ field: 'status', from: 'pre_joining', to: 'active' }],
      });
      await this.journey.record(tx, {
        engagementId: offer.engagementId,
        personId: offer.personId,
        eventType: 'joined',
        category: 'lifecycle',
        occurredOn: summary.joiningDate,
        title: `Joined as ${summary.designation?.title ?? summary.engagementType}`,
        detail: {
          employeeCode: summary.employeeCode,
          designationId: summary.designation?.id ?? null,
          departmentName: summary.department?.name ?? null,
          engagementType: summary.engagementType,
          viaOfferFlow: true,
        },
        sensitivity: 'public',
        sourceTable: 'engagement',
        sourceId: offer.engagementId,
      });
      await linkUsersToPerson(tx, workEmail, offer.personId);
      await this.retireGuestIn(tx, offer);
      await this.setStatus(tx, offer, 'joined');
    });
    return this.get(offerId);
  }

  /** HR sends the sign-in invitation again (e.g. the joiner lost the email, or it failed). */
  async invite(offerId: string): Promise<OfferView> {
    const offer = await this.loadFor(offerId, 'update');
    if (offer.status !== 'accepted') {
      throw new ConflictException({ message: 'Only an accepted offer’s joiner can be invited' });
    }
    await this.db.tx((tx) => this.inviteIn(tx, offer));
    return this.get(offerId);
  }

  /** Every 30 minutes: retries invitations that failed. */
  async retryInvites(): Promise<{ retried: number }> {
    return this.db.tx(async (tx) => {
      const failed = await tx
        .select()
        .from(offers)
        .where(and(eq(offers.status, 'accepted'), eq(offers.guestStatus, 'failed')));
      for (const offer of failed) await this.inviteIn(tx, offer);
      return { retried: failed.length };
    });
  }

  /** Daily: offers out for signature past their expiry date count as declined. */
  async expireDue(now = new Date()): Promise<{ expired: number }> {
    const today = businessDate(now);
    return this.db.tx(async (tx) => {
      const due = await tx
        .select()
        .from(offers)
        .where(and(eq(offers.status, 'offered'), lt(offers.expiresOn, today)));
      for (const offer of due) await this.closeIn(tx, offer, 'declined', 'Offer expired');
      return { expired: due.length };
    });
  }

  // ---- Reading ----

  /** H4 offers pipeline: offers for people the viewer may see, newest first. */
  async list(status?: OfferStatus): Promise<OfferView[]> {
    const actor = requireContext().actor!;
    const rows = await this.db.tx((tx) =>
      tx
        .select()
        .from(offers)
        .where(status ? eq(offers.status, status) : undefined)
        .orderBy(desc(offers.createdAt)),
    );
    const views: OfferView[] = [];
    for (const row of rows) {
      // An offer is HR's record (band check, approvals): never shown to the candidate themselves.
      if (row.personId === actor.personId) continue;
      const summary = await this.people.summary(row.personId);
      const decision = await this.authz.check(actor, 'read', {
        area: 'assignment_history',
        subjectPersonId: row.personId,
        legalEntityId: summary.legalEntityId,
      });
      if (decision.allowed) views.push(await this.view(row, summary));
    }
    return views;
  }

  async get(offerId: string): Promise<OfferView> {
    const offer = await this.loadFor(offerId, 'read');
    return this.view(offer, await this.people.summary(offer.personId));
  }

  // ---- Workflow and signing ----

  private async describe(tx: Tx, instance: ActionInstance): Promise<ChangeLine[]> {
    const { offerId } = releasePayload.parse(instance.payload);
    const [offer] = await tx.select().from(offers).where(eq(offers.id, offerId));
    if (!offer) return [];
    const summary = await this.people.summary(offer.personId);
    const [engagement] = await tx
      .select({ contractEndDate: engagements.contractEndDate })
      .from(engagements)
      .where(eq(engagements.id, offer.engagementId));
    const lines: ChangeLine[] = [
      { label: 'Role', from: null, to: summary.designation?.title ?? null },
      { label: 'Department', from: null, to: summary.department?.name ?? null },
      { label: 'Location', from: null, to: summary.location?.name ?? null },
      { label: 'Reports to', from: null, to: summary.manager?.name ?? null },
      { label: 'Engagement', from: null, to: summary.engagementType.replace('_', '-') },
      { label: 'Joining', from: null, to: summary.joiningDate },
    ];
    if (engagement?.contractEndDate) {
      lines.push({ label: 'Ends', from: null, to: engagement.contractEndDate });
    }
    // The approver sees how pay sits against the band, not the pay itself.
    lines.push({ label: 'Pay', from: null, to: bandWords[offer.bandCheck] });
    return lines;
  }

  /** Final approval: the offer goes out for e-signature, last so a provider failure rolls back. */
  private async release(tx: Tx, offerId: string): Promise<void> {
    const [offer] = await tx.select().from(offers).where(eq(offers.id, offerId));
    if (!offer || offer.status !== 'pending_approval') {
      throw new ConflictException({ message: 'This offer is no longer waiting for approval' });
    }
    const today = businessDate(new Date());
    const expiryDays = await this.settings.get(tx, 'offer_expiry_days');
    await tx
      .update(engagements)
      .set({ offerDate: today, updatedAt: new Date() })
      .where(eq(engagements.id, offer.engagementId));
    await this.setStatus(tx, offer, 'offered', {
      offeredAt: new Date(),
      expiresOn: addDays(today, expiryDays),
    });
    await this.letters.sendIn(tx, offer.letterId!);
  }

  /** Keeps the offer in step when its approval request is returned, sent again or withdrawn. */
  private async onRequestStatus(
    tx: Tx,
    offerId: string,
    requestId: string,
    status: 'pending' | 'returned' | 'withdrawn' | 'approved',
  ): Promise<void> {
    const [offer] = await tx.select().from(offers).where(eq(offers.id, offerId));
    // A request replaced by a resubmission no longer speaks for the offer.
    if (!offer || offer.approvalRequestId !== requestId) return;
    if (status === 'returned' && offer.status === 'pending_approval') {
      await this.setStatus(tx, offer, 'draft');
    } else if (status === 'pending' && offer.status === 'draft') {
      await this.setStatus(tx, offer, 'pending_approval');
    } else if (status === 'withdrawn' && ['draft', 'pending_approval'].includes(offer.status)) {
      await this.closeIn(tx, offer, 'withdrawn', 'Approval request withdrawn');
    }
  }

  /**
   * The candidate signed: the engagement becomes pre-joining and the onboarding checklists that apply
   * start from the joining date. Runs from the signing provider's check, without a signed-in user.
   */
  private async acceptIn(tx: Tx, offer: OfferRow): Promise<void> {
    const [engagement] = await tx
      .select()
      .from(engagements)
      .where(eq(engagements.id, offer.engagementId));
    await tx
      .update(engagements)
      .set({ status: 'pre_joining', updatedAt: new Date() })
      .where(eq(engagements.id, offer.engagementId));
    await this.audit.record(tx, {
      action: 'update',
      table: 'engagement',
      recordId: offer.engagementId,
      subjectPersonId: offer.personId,
      fieldChanges: [{ field: 'status', from: 'offered', to: 'pre_joining' }],
    });
    await this.setStatus(tx, offer, 'accepted', { acceptedAt: new Date() });
    const runs = await this.checklists.startApplicable(
      tx,
      offer.engagementId,
      'onboarding',
      engagement!.joiningDate,
    );
    await this.journey.record(tx, {
      engagementId: offer.engagementId,
      personId: offer.personId,
      eventType: 'offer_accepted',
      category: 'lifecycle',
      occurredOn: businessDate(new Date()),
      title: 'Offer accepted',
      detail: { joiningDate: engagement!.joiningDate, onboardingChecklists: runs.length },
      sensitivity: 'manager',
      sourceTable: 'offer',
      sourceId: offer.id,
    });
    const summary = await this.people.summary(offer.personId);
    const name = summary.preferredName ?? summary.legalName;
    const manager = await managerUserOfPerson(tx, offer.personId, businessDate(new Date()));
    await notify(
      tx,
      [...(await roleHolders(tx, 'hr', engagement!.legalEntityId)), ...(manager ? [manager] : [])],
      'offer_accepted',
      runs.length
        ? `Offer accepted: ${name}, joining ${engagement!.joiningDate}`
        : `Offer accepted: ${name}; no onboarding checklist applies`,
      `/people/${offer.personId}`,
    );
    await this.inviteIn(tx, offer);
  }

  /**
   * Invites the pre-joiner to sign in (decision #55). A failure is recorded and retried, never undoing
   * the acceptance: HR is told and the job tries again.
   */
  private async inviteIn(tx: Tx, offer: OfferRow): Promise<void> {
    const [person] = await tx
      .select({
        legalName: persons.legalName,
        preferredName: persons.preferredName,
        personalEmail: persons.personalEmail,
      })
      .from(persons)
      .where(eq(persons.id, offer.personId));
    const name = person!.preferredName ?? person!.legalName;
    const [engagement] = await tx
      .select({ legalEntityId: engagements.legalEntityId })
      .from(engagements)
      .where(eq(engagements.id, offer.engagementId));
    try {
      if (!person!.personalEmail) throw new Error('No personal email');
      const { objectId } = await this.invites.invite({
        email: person!.personalEmail,
        displayName: name,
      });
      const guestUserId =
        this.invites.name === 'fake'
          ? await this.devGuestUser(
              tx,
              offer,
              person!.personalEmail,
              name,
              engagement!.legalEntityId,
            )
          : null;
      await tx
        .update(offers)
        .set({
          guestStatus: 'invited',
          guestObjectId: objectId,
          guestUserId,
          guestInvitedAt: new Date(),
        })
        .where(eq(offers.id, offer.id));
      offer.guestStatus = 'invited';
      offer.guestObjectId = objectId;
      offer.guestUserId = guestUserId;
    } catch (error) {
      this.logger.warn(
        `Pre-joiner invitation failed for offer ${offer.id}: ${(error as Error).message}`,
      );
      await tx.update(offers).set({ guestStatus: 'failed' }).where(eq(offers.id, offer.id));
      offer.guestStatus = 'failed';
      await notify(
        tx,
        await roleHolders(tx, 'hr', engagement!.legalEntityId),
        'prejoiner_invite_failed',
        `Couldn’t invite ${name} to sign in; iPro will retry, or send it again from the offer`,
        `/people/${offer.personId}`,
      );
    }
  }

  /**
   * Locally there is no Entra: a dev sign-in user stands in for the guest, linked to the person, so the
   * onboarding portal can be tried end to end. Production refuses the fake provider (config).
   */
  private async devGuestUser(
    tx: Tx,
    offer: OfferRow,
    email: string,
    displayName: string,
    legalEntityId: string,
  ): Promise<string> {
    if (offer.guestUserId) return offer.guestUserId;
    const tenantId = requireContext().tenantId;
    const [user] = await tx
      .insert(appUsers)
      .values({ tenantId, email, displayName, personId: offer.personId })
      .returning({ id: appUsers.id });
    await tx.insert(roleAssignments).values({
      tenantId,
      userId: user!.id,
      role: 'employee',
      legalEntityId,
      source: 'manual',
    });
    return user!.id;
  }

  /** On joining or closing, the pre-joiner's guest sign-in stops working in iPro. */
  private async retireGuestIn(tx: Tx, offer: OfferRow): Promise<void> {
    if (!offer.guestStatus || offer.guestStatus === 'retired') return;
    const users = [
      ...(offer.guestUserId ? [eq(appUsers.id, offer.guestUserId)] : []),
      ...(offer.guestObjectId ? [eq(appUsers.entraObjectId, offer.guestObjectId)] : []),
    ];
    if (users.length > 0) {
      await tx
        .update(appUsers)
        .set({ status: 'disabled', updatedAt: new Date() })
        .where(or(...users));
    }
    await tx.update(offers).set({ guestStatus: 'retired' }).where(eq(offers.id, offer.id));
    offer.guestStatus = 'retired';
  }

  /** Declined, withdrawn or no-show: the engagement closes as withdrawn, with one journey event. */
  private async closeIn(
    tx: Tx,
    offer: OfferRow,
    status: 'declined' | 'withdrawn' | 'no_show',
    reason: string,
  ): Promise<void> {
    // Close first, so the approval request's own withdrawal (below) finds nothing left to do.
    await this.setStatus(tx, offer, status, { closedAt: new Date(), closeReason: reason });
    await this.retireGuestIn(tx, offer);
    if (offer.approvalRequestId) await this.workflows.cancelIn(tx, offer.approvalRequestId);
    await this.checklists.cancelOpenIn(tx, offer.engagementId, reason);
    await tx
      .update(engagements)
      .set({ status: 'withdrawn', exitReason: status, updatedAt: new Date() })
      .where(eq(engagements.id, offer.engagementId));
    await this.audit.record(tx, {
      action: 'update',
      table: 'engagement',
      recordId: offer.engagementId,
      subjectPersonId: offer.personId,
      fieldChanges: [{ field: 'status', to: 'withdrawn' }],
    });
    await this.journey.record(tx, {
      engagementId: offer.engagementId,
      personId: offer.personId,
      ...closingEvents[status],
      category: 'lifecycle',
      occurredOn: businessDate(new Date()),
      detail: { reason },
      sensitivity: 'hr',
      sourceTable: 'offer',
      sourceId: offer.id,
    });
    const [engagement] = await tx
      .select({ legalEntityId: engagements.legalEntityId })
      .from(engagements)
      .where(eq(engagements.id, offer.engagementId));
    await notify(
      tx,
      await roleHolders(tx, 'hr', engagement!.legalEntityId),
      `offer_${status}`,
      `${closingEvents[status].title}: ${reason}`,
      `/people/${offer.personId}`,
    );
    // The provider call comes last, so nothing above is lost if it fails.
    if (offer.letterId) await this.letters.cancelIn(tx, offer.letterId);
  }

  // ---- Internals ----

  private async setStatus(
    tx: Tx,
    offer: OfferRow,
    status: OfferStatus,
    changes: Partial<typeof offers.$inferInsert> = {},
  ): Promise<void> {
    const actor = requireContext().actor;
    await tx
      .update(offers)
      .set({ ...changes, status, updatedAt: new Date(), updatedBy: actor?.userId ?? null })
      .where(eq(offers.id, offer.id));
    await this.audit.record(tx, {
      action: 'update',
      table: 'offer',
      recordId: offer.id,
      subjectPersonId: offer.personId,
      fieldChanges: [{ field: 'status', from: offer.status, to: status }],
    });
    offer.status = status;
  }

  /** The offer letter must be a template the candidate signs: signing is how they accept. */
  private async assertOfferTemplate(tx: Tx, key: string): Promise<void> {
    const [template] = await tx
      .select({ signature: letterTemplates.signature })
      .from(letterTemplates)
      .where(and(eq(letterTemplates.key, key), eq(letterTemplates.active, true)));
    if (!template) throw new BadRequestException({ message: `No letter template "${key}"` });
    if (template.signature !== 'employee') {
      throw new BadRequestException({
        message: 'The offer letter template must be signed by the candidate',
      });
    }
  }

  private async loadFor(offerId: string, action: 'read' | 'update'): Promise<OfferRow> {
    const [offer] = await this.db.tx((tx) =>
      tx.select().from(offers).where(eq(offers.id, offerId)),
    );
    const actor = requireContext().actor!;
    if (!offer || offer.personId === actor.personId) throw new NotFoundException();
    const summary = await this.people.summary(offer.personId);
    const decision = await this.authz.check(actor, action, {
      area: 'assignment_history',
      subjectPersonId: offer.personId,
      legalEntityId: summary.legalEntityId,
    });
    if (!decision.allowed) throw new NotFoundException();
    return offer;
  }

  private async view(offer: OfferRow, summary: PersonSummary): Promise<OfferView> {
    return this.db.tx(async (tx) => {
      const [engagement] = await tx
        .select({ contractEndDate: engagements.contractEndDate })
        .from(engagements)
        .where(eq(engagements.id, offer.engagementId));
      const [pay] = await tx
        .select({ id: compensations.id })
        .from(compensations)
        .where(eq(compensations.engagementId, offer.engagementId))
        .limit(1);
      const [letter] = offer.letterId
        ? await tx
            .select({ id: letters.id, status: letters.status })
            .from(letters)
            .where(eq(letters.id, offer.letterId))
        : [];
      return {
        id: offer.id,
        status: offer.status,
        person: { personId: offer.personId, name: summary.preferredName ?? summary.legalName },
        engagementId: offer.engagementId,
        employeeCode: summary.employeeCode,
        engagementType: summary.engagementType,
        joiningDate: summary.joiningDate,
        endDate: engagement?.contractEndDate ?? null,
        paid: Boolean(pay),
        designation: summary.designation?.title ?? null,
        department: summary.department?.name ?? null,
        hiringManager: summary.manager?.name ?? null,
        bandCheck: offer.bandCheck,
        needsHrHead: needsHrHead(offer.bandCheck),
        letter: letter ?? null,
        approvalRequestId: offer.approvalRequestId,
        offeredAt: offer.offeredAt?.toISOString() ?? null,
        expiresOn: offer.expiresOn,
        acceptedAt: offer.acceptedAt?.toISOString() ?? null,
        closedAt: offer.closedAt?.toISOString() ?? null,
        closeReason: offer.closeReason,
        guest: offer.guestStatus
          ? { status: offer.guestStatus, invitedAt: offer.guestInvitedAt?.toISOString() ?? null }
          : null,
        createdAt: offer.createdAt.toISOString(),
      };
    });
  }
}
