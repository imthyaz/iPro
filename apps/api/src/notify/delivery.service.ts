import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { requireContext, runWithContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import { appUsers } from '../identity/identity.schema.js';
import { UsersService } from '../identity/users.service.js';
import { approvals, notifications, workflowInstances } from '../workflow/workflow.schema.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import {
  MAIL_CHANNEL,
  TEAMS_CHANNEL,
  Unreachable,
  type MailChannel,
  type TeamsChannel,
} from './channels.js';
import { nextAttempt } from './delivery-rules.js';
import { notificationDeliveries, teamsConversations } from './notify.schema.js';
import { approvalCard, noticeCard, type AdaptiveCard } from './teams-cards.js';

/** How long a claimed delivery is held before another run may try it (a crashed run's lease). */
const LEASE_MINUTES = 10;
const BATCH = 50;

/**
 * Workflows whose approval cards can be decided inside Teams (spec: Integrations, Microsoft Teams):
 * leave, comp-off, regularisation, hybrid exceptions and probation reviews. Anything else (pay,
 * exits, offers, letters) arrives in Teams as a notice that opens iPro, so no pay figure is sent there.
 */
export const TEAMS_ACTIONABLE = [
  'leave_request',
  'comp_off_request',
  'attendance_regularisation',
  'hybrid_exception',
  'probation_decision',
] as const;

interface Claimed {
  id: string;
  channel: 'teams' | 'email';
  attempts: number;
  recipientUserId: string;
  notificationId: string;
  title: string;
  link: string | null;
  approvalId: string | null;
}

/**
 * Sends the notification outbox (decision #87): every minute, due Teams and email rows are claimed,
 * sent outside the database transaction, and recorded. A failure retries with a back-off; Teams that
 * can't reach someone (no app installed, app removed, Teams not set up) hands over to email.
 */
@Injectable()
export class DeliveryService {
  private readonly log = new Logger('Delivery');

  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TEAMS_CHANNEL) private readonly teams: TeamsChannel,
    @Inject(MAIL_CHANNEL) private readonly mail: MailChannel,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
  ) {}

  /** Sends what is due; returns counts for the job log (ids and numbers only). */
  async run(now = new Date()): Promise<{ sent: number; retrying: number; handedOver: number }> {
    let sent = 0;
    let retrying = 0;
    let handedOver = 0;
    for (;;) {
      // Never earlier than the clock, so email handed over during this run goes out in it too.
      const batch = await this.claim(new Date(Math.max(now.getTime(), Date.now())));
      let handed = 0;
      for (const item of batch) {
        const outcome = await this.deliver(item);
        if (outcome === 'sent') sent += 1;
        else if (outcome === 'retry') retrying += 1;
        else if (outcome === 'unreachable' && item.channel === 'teams') handed += 1;
      }
      handedOver += handed;
      if (batch.length < BATCH && handed === 0) break;
    }
    if (sent || retrying || handedOver) {
      this.log.log(`Delivered ${sent}; retrying ${retrying}; Teams unreachable ${handedOver}`);
    }
    return { sent, retrying, handedOver };
  }

  /** Claims due rows with a lease, so two runs never send the same one. */
  private claim(now: Date): Promise<Claimed[]> {
    return this.db.tx(async (tx) => {
      const due = await tx
        .select({
          id: notificationDeliveries.id,
          channel: notificationDeliveries.channel,
          attempts: notificationDeliveries.attempts,
          recipientUserId: notificationDeliveries.recipientUserId,
          notificationId: notificationDeliveries.notificationId,
          title: notifications.title,
          link: notifications.link,
          approvalId: notifications.approvalId,
        })
        .from(notificationDeliveries)
        .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
        .where(
          and(
            eq(notificationDeliveries.status, 'pending'),
            lte(notificationDeliveries.nextAttemptAt, now),
          ),
        )
        .orderBy(notificationDeliveries.nextAttemptAt)
        .limit(BATCH)
        .for('update', { of: notificationDeliveries, skipLocked: true });
      if (due.length > 0) {
        await tx
          .update(notificationDeliveries)
          .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MINUTES * 60_000) })
          .where(
            inArray(
              notificationDeliveries.id,
              due.map((d) => d.id),
            ),
          );
      }
      return due;
    });
  }

  private async deliver(item: Claimed): Promise<'sent' | 'retry' | 'failed' | 'unreachable'> {
    try {
      if (item.channel === 'teams') await this.sendTeams(item);
      else await this.sendEmail(item);
      await this.record(item.id, {
        status: 'sent',
        sentAt: new Date(),
        attempts: item.attempts + 1,
      });
      return 'sent';
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : 'Unknown error';
      if (error instanceof Unreachable) {
        await this.db.tx(async (tx) => {
          await this.record(
            item.id,
            { status: 'unreachable', lastError: reason, attempts: item.attempts + 1 },
            tx,
          );
          if (item.channel === 'teams') {
            await tx
              .insert(notificationDeliveries)
              .values({
                tenantId: requireContext().tenantId,
                notificationId: item.notificationId,
                recipientUserId: item.recipientUserId,
                channel: 'email',
                nextAttemptAt: new Date(),
              })
              .onConflictDoNothing();
          }
        });
        return 'unreachable';
      }
      const attempts = item.attempts + 1;
      const next = nextAttempt(attempts, new Date());
      await this.record(
        item.id,
        next
          ? { attempts, lastError: reason, nextAttemptAt: next }
          : { attempts, lastError: reason, status: 'failed' },
      );
      this.log.warn(`Delivery ${item.id} (${item.channel}) attempt ${attempts} failed`);
      return next ? 'retry' : 'failed';
    }
  }

  private async sendTeams(item: Claimed): Promise<void> {
    const [address] = await this.db.tx((tx) =>
      tx
        .select({
          serviceUrl: teamsConversations.serviceUrl,
          conversationId: teamsConversations.conversationId,
        })
        .from(teamsConversations)
        .where(
          and(
            eq(teamsConversations.userId, item.recipientUserId),
            isNull(teamsConversations.removedAt),
          ),
        ),
    );
    if (!address) throw new Unreachable('No Teams conversation for this person');
    await this.teams.send(address, await this.cardFor(item));
  }

  /**
   * An actionable card for an open approval of a Teams-decidable workflow, built as the recipient
   * would see it in their inbox (so reads are the recipient's); otherwise a notice with a link.
   */
  private async cardFor(item: Claimed): Promise<AdaptiveCard> {
    const appUrl = this.config.APP_URL;
    if (item.approvalId) {
      const { tenantId } = requireContext();
      const key = await this.db.tx(async (tx) => {
        const [row] = await tx
          .select({ key: workflowInstances.key })
          .from(approvals)
          .innerJoin(workflowInstances, eq(workflowInstances.id, approvals.instanceId))
          .where(eq(approvals.id, item.approvalId!));
        return row?.key ?? null;
      });
      if (key && (TEAMS_ACTIONABLE as readonly string[]).includes(key)) {
        const actor = await this.db.tx((tx) =>
          this.users.loadActor(tx, tenantId, item.recipientUserId),
        );
        if (actor) {
          const card = await runWithContext({ tenantId, actor }, () =>
            this.db.tx((tx) => this.workflows.approvalCardFor(tx, item.approvalId!, actor)),
          );
          if (card) return approvalCard(card, appUrl);
        }
      }
    }
    return noticeCard(item.title, item.link, appUrl);
  }

  private async sendEmail(item: Claimed): Promise<void> {
    const [user] = await this.db.tx((tx) =>
      tx
        .select({ email: appUsers.email, status: appUsers.status })
        .from(appUsers)
        .where(eq(appUsers.id, item.recipientUserId)),
    );
    if (!user || user.status !== 'active') throw new Unreachable('No active account');
    const url = new URL(item.link ?? '/', this.config.APP_URL).toString();
    const settings = new URL('/notifications', this.config.APP_URL).toString();
    await this.mail.send({
      to: user.email,
      subject: item.title,
      html: [
        `<p>${escapeHtml(item.title)}</p>`,
        `<p><a href="${escapeHtml(url)}">Open in iPro</a></p>`,
        `<p style="color:#5a6476;font-size:12px">Sent by iPro. Choose what you hear about: `,
        `<a href="${escapeHtml(settings)}">notification settings</a>.</p>`,
      ].join(''),
    });
  }

  private async record(
    id: string,
    set: Partial<typeof notificationDeliveries.$inferInsert>,
    tx?: Parameters<Parameters<TenantDb['tx']>[0]>[0],
  ): Promise<void> {
    const write = (t: NonNullable<typeof tx>) =>
      t
        .update(notificationDeliveries)
        .set({ ...set, updatedAt: sql`now()` })
        .where(eq(notificationDeliveries.id, id));
    if (tx) await write(tx);
    else await this.db.tx((t) => write(t));
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
