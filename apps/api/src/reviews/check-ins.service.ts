import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import type { CheckInProgress, CheckInView } from '@ipro/shared';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext, type Actor } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { engagements } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { managerUserOfPerson, notify, roleHolders, userName } from '../workflow/lookups.js';
import { probationCheckIns } from './reviews.schema.js';

type CheckInRow = typeof probationCheckIns.$inferSelect;

/** A check-in not recorded this many days after its date gets one reminder, and counts as overdue. */
const GRACE_DAYS = 7;

/** The date `months` months after `iso`, clamped to the month's last day (31 Jan + 1 → 28/29 Feb). */
export function addMonths(iso: string, months: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString().slice(0, 10);
}

/**
 * Monthly probation check-ins (decision #63): on each monthly date from joining until probation
 * ends, the manager records how the month went. They show on the probation decision card and H7.
 */
@Injectable()
export class CheckInsService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PeopleService) private readonly people: PeopleService,
  ) {}

  /**
   * Part of the daily probation sweep: opens this month's check-in for each person on probation (only
   * the latest month, so going live doesn't create a backlog) and reminds once after a week.
   */
  async sweepIn(tx: Tx, today: string): Promise<{ opened: number; reminded: number }> {
    let opened = 0;
    let reminded = 0;
    const onProbation = await tx
      .select()
      .from(engagements)
      .where(and(eq(engagements.status, 'active'), isNull(engagements.confirmationDate)));
    for (const engagement of onProbation) {
      if (!engagement.probationEndDate) continue;
      let month = 0;
      while (addMonths(engagement.joiningDate, month + 1) <= today) month++;
      if (month === 0) continue;
      const dueOn = addMonths(engagement.joiningDate, month);
      // Not the month the probation ends in: the review covers that.
      if (dueOn > addDays(engagement.probationEndDate, -1) || dueOn < addDays(today, -GRACE_DAYS)) {
        continue;
      }
      const reviewer = await managerUserOfPerson(tx, engagement.personId, today);
      const [created] = await tx
        .insert(probationCheckIns)
        .values({
          tenantId: requireContext().tenantId,
          engagementId: engagement.id,
          personId: engagement.personId,
          month,
          dueOn,
          reviewerUserId: reviewer,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) continue;
      const name = await this.nameOf(engagement.personId);
      await notify(
        tx,
        reviewer ? [reviewer] : await roleHolders(tx, 'hr', engagement.legalEntityId),
        'probation_check_in_due',
        `Month ${month} probation check-in: ${name}`,
        '/',
      );
      opened++;
    }

    const late = await tx
      .select({ checkIn: probationCheckIns, legalEntityId: engagements.legalEntityId })
      .from(probationCheckIns)
      .innerJoin(engagements, eq(engagements.id, probationCheckIns.engagementId))
      .where(
        and(
          isNull(probationCheckIns.recordedAt),
          isNull(probationCheckIns.remindedAt),
          lte(probationCheckIns.dueOn, addDays(today, -GRACE_DAYS)),
        ),
      );
    for (const { checkIn, legalEntityId } of late) {
      await notify(
        tx,
        checkIn.reviewerUserId
          ? [checkIn.reviewerUserId]
          : await roleHolders(tx, 'hr', legalEntityId),
        'probation_check_in_reminder',
        `Reminder: month ${checkIn.month} check-in for ${await this.nameOf(checkIn.personId)}`,
        '/',
      );
      await tx
        .update(probationCheckIns)
        .set({ remindedAt: new Date() })
        .where(eq(probationCheckIns.id, checkIn.id));
      reminded++;
    }
    return { opened, reminded };
  }

  /** The manager records how the month went. */
  async record(checkInId: string, progress: CheckInProgress, notes: string): Promise<CheckInView> {
    const actor = requireContext().actor!;
    const checkIn = await this.load(checkInId);
    if (!(await this.canRecord(actor, checkIn))) throw new ForbiddenException();
    if (checkIn.recordedAt) throw new ConflictException({ message: 'Already recorded' });
    await this.db.tx(async (tx) => {
      await tx
        .update(probationCheckIns)
        .set({
          progress,
          notes,
          recordedAt: new Date(),
          recordedBy: actor.userId,
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(probationCheckIns.id, checkIn.id));
      await this.audit.record(tx, {
        action: 'update',
        table: 'probation_check_in',
        recordId: checkIn.id,
        subjectPersonId: checkIn.personId,
        fieldChanges: [{ field: 'progress', to: progress }],
      });
    });
    return this.view((await this.load(checkInId))!);
  }

  /** Check-ins the signed-in user may see: theirs to record, or their team's / everyone's (HR). */
  async list(filter: { open?: boolean; personId?: string } = {}): Promise<CheckInView[]> {
    const actor = requireContext().actor!;
    const rows = await this.db.tx((tx) =>
      tx
        .select()
        .from(probationCheckIns)
        .where(
          and(
            filter.open ? isNull(probationCheckIns.recordedAt) : undefined,
            filter.personId ? eq(probationCheckIns.personId, filter.personId) : undefined,
          ),
        )
        .orderBy(asc(probationCheckIns.dueOn)),
    );
    const views: CheckInView[] = [];
    for (const row of rows) {
      if (row.personId === actor.personId) continue;
      if (await this.mayRead(actor, row)) views.push(await this.view(row));
    }
    return views;
  }

  /** Check-ins of one engagement, oldest first, for the probation decision (read in its transaction). */
  async forEngagementIn(tx: Tx, engagementId: string) {
    return tx
      .select()
      .from(probationCheckIns)
      .where(eq(probationCheckIns.engagementId, engagementId))
      .orderBy(asc(probationCheckIns.month));
  }

  private async canRecord(actor: Actor, checkIn: CheckInRow): Promise<boolean> {
    if (checkIn.reviewerUserId === actor.userId) return true;
    const summary = await this.people.summary(checkIn.personId);
    const decision = await this.authz.check(actor, 'create', {
      area: 'probation_review',
      subjectPersonId: checkIn.personId,
      legalEntityId: summary.legalEntityId,
    });
    return decision.allowed;
  }

  private async mayRead(actor: Actor, checkIn: CheckInRow): Promise<boolean> {
    if (checkIn.reviewerUserId === actor.userId) return true;
    const summary = await this.people.summary(checkIn.personId);
    return (
      await this.authz.check(actor, 'read', {
        area: 'probation_review',
        subjectPersonId: checkIn.personId,
        legalEntityId: summary.legalEntityId,
        attributes: { decided: false },
      })
    ).allowed;
  }

  private async load(checkInId: string): Promise<CheckInRow> {
    const [row] = await this.db.tx((tx) =>
      tx.select().from(probationCheckIns).where(eq(probationCheckIns.id, checkInId)),
    );
    if (!row || !(await this.mayRead(requireContext().actor!, row))) throw new NotFoundException();
    return row;
  }

  private async nameOf(personId: string): Promise<string> {
    const summary = await this.people.summary(personId);
    return summary.preferredName ?? summary.legalName;
  }

  async view(row: CheckInRow): Promise<CheckInView> {
    const actor = requireContext().actor;
    const today = businessDate(new Date());
    return {
      id: row.id,
      person: { personId: row.personId, name: await this.nameOf(row.personId) },
      month: row.month,
      dueOn: row.dueOn,
      overdue: !row.recordedAt && row.dueOn <= addDays(today, -GRACE_DAYS),
      status: row.recordedAt ? 'done' : 'due',
      progress: row.progress,
      notes: row.notes,
      recordedAt: row.recordedAt?.toISOString() ?? null,
      recordedBy: row.recordedBy ? await this.db.tx((tx) => userName(tx, row.recordedBy!)) : null,
      canRecord: !row.recordedAt && actor ? await this.canRecord(actor, row) : false,
    };
  }
}

export const checkInWords: Record<CheckInProgress, string> = {
  on_track: 'on track',
  needs_support: 'needs support',
  at_risk: 'at risk',
};
