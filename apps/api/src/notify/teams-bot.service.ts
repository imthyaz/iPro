import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import { appUsers } from '../identity/identity.schema.js';
import { UsersService } from '../identity/users.service.js';
import { approvals, workflowInstances } from '../workflow/workflow.schema.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { BOT_KEYS, BotAuthError, verifyBotToken, type BotKeySource } from './bot-auth.js';
import { TEAMS_ACTIONABLE } from './delivery.service.js';
import { teamsConversations } from './notify.schema.js';
import { APPROVE_VERB, outcomeCard, REJECT_VERB, type AdaptiveCard } from './teams-cards.js';

/** The parts of a Bot Framework activity iPro reads. */
export interface TeamsActivity {
  type?: string;
  name?: string;
  action?: string;
  serviceUrl?: string;
  channelId?: string;
  from?: { id?: string; aadObjectId?: string };
  recipient?: { id?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string };
  channelData?: { tenant?: { id?: string } };
  membersAdded?: { id?: string }[];
  value?: { action?: { verb?: string; data?: Record<string, unknown> } };
}

export type InvokeResponse = {
  statusCode: 200;
  type: 'application/vnd.microsoft.card.adaptive';
  value: AdaptiveCard;
};

/** Used when the bot isn't registered yet (fake mode, local only). */
const DEV_BOT_APP_ID = 'ipro-dev-bot';

/**
 * The iPro bot in Teams (decision #87). It learns where to reach each person when the app is
 * installed for them, and turns a card's Approve or Reject into the same WorkflowService call the
 * inbox makes, as that person: same approver check, same permission check, same audit row.
 */
@Injectable()
export class TeamsBotService {
  private readonly log = new Logger('TeamsBot');

  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BOT_KEYS) private readonly keys: BotKeySource,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
  ) {}

  async handle(
    activity: TeamsActivity,
    authorization: string | undefined,
  ): Promise<InvokeResponse | null> {
    if (this.config.TEAMS_PROVIDER === 'none') throw new ServiceUnavailableException();
    await this.authenticate(activity, authorization);
    const userId = await this.userOf(activity);

    if (activity.type === 'installationUpdate' || activity.type === 'conversationUpdate') {
      await this.remember(activity, userId);
      return null;
    }
    if (activity.type === 'invoke' && activity.name === 'adaptiveCard/action') {
      return this.act(activity, userId);
    }
    return null;
  }

  private async authenticate(activity: TeamsActivity, authorization: string | undefined) {
    const appId =
      this.config.TEAMS_BOT_APP_ID ??
      (this.config.TEAMS_PROVIDER === 'fake' ? DEV_BOT_APP_ID : null);
    if (!appId || !activity.serviceUrl) throw new UnauthorizedException();
    try {
      await verifyBotToken(authorization, {
        appId,
        serviceUrl: activity.serviceUrl,
        channelId: activity.channelId,
        keys: this.keys,
      });
    } catch (error) {
      if (error instanceof BotAuthError) {
        this.log.warn(`Refused a Teams activity: ${error.message}`);
        throw new UnauthorizedException();
      }
      throw error;
    }
    // Only Ideassion's own Teams tenant.
    const tenant = activity.conversation?.tenantId ?? activity.channelData?.tenant?.id;
    if (this.config.ENTRA_TENANT_ID && tenant !== this.config.ENTRA_TENANT_ID) {
      throw new ForbiddenException();
    }
  }

  /** The iPro user behind a Teams account, by their Entra object id; null when not linked. */
  private async userOf(activity: TeamsActivity): Promise<string | null> {
    const oid = activity.from?.aadObjectId;
    if (!oid) return null;
    const [user] = await this.db.tx((tx) =>
      tx
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.entraObjectId, oid), eq(appUsers.status, 'active'))),
    );
    return user?.id ?? null;
  }

  /** Saves (or forgets) where to reach this person: personal chats only. */
  private async remember(activity: TeamsActivity, userId: string | null) {
    if (!userId || activity.conversation?.conversationType !== 'personal') return;
    const conversationId = activity.conversation.id;
    if (!conversationId || !activity.serviceUrl) return;
    const removed =
      activity.action === 'remove' ||
      (activity.type === 'conversationUpdate' &&
        !activity.membersAdded?.some((m) => m.id === activity.recipient?.id));
    if (activity.type === 'conversationUpdate' && removed) return;
    const { tenantId } = requireContext();
    await this.db.tx((tx) =>
      tx
        .insert(teamsConversations)
        .values({
          tenantId,
          userId,
          serviceUrl: activity.serviceUrl!,
          conversationId,
          removedAt: removed ? new Date() : null,
          createdBy: userId,
          updatedBy: userId,
        })
        .onConflictDoUpdate({
          target: [teamsConversations.tenantId, teamsConversations.userId],
          set: {
            serviceUrl: activity.serviceUrl!,
            conversationId,
            removedAt: removed ? new Date() : null,
            updatedAt: new Date(),
            updatedBy: userId,
          },
        }),
    );
  }

  /** Approve or reject from a card, answered with a card showing what happened. */
  private async act(activity: TeamsActivity, userId: string | null): Promise<InvokeResponse> {
    const appUrl = this.config.APP_URL;
    const reply = (title: string, outcome: string): InvokeResponse => ({
      statusCode: 200,
      type: 'application/vnd.microsoft.card.adaptive',
      value: outcomeCard(title, outcome, appUrl),
    });
    const verb = activity.value?.action?.verb;
    const data = activity.value?.action?.data ?? {};
    const approvalId = typeof data.approvalId === 'string' ? data.approvalId : null;
    if (!userId) {
      return reply('Not linked to iPro', 'Your Teams account isn’t linked to an iPro account.');
    }
    if (!approvalId || (verb !== APPROVE_VERB && verb !== REJECT_VERB)) {
      return reply('Nothing to do', 'This card has no action iPro knows.');
    }
    const { tenantId } = requireContext();
    const actor = await this.db.tx((tx) => this.users.loadActor(tx, tenantId, userId));
    if (!actor) return reply('Not linked to iPro', 'Your iPro account isn’t active.');
    // From here on the request is this person's, exactly as if they had signed in to iPro.
    requireContext().actor = actor;

    const [item] = await this.db.tx((tx) =>
      tx
        .select({ key: workflowInstances.key, title: workflowInstances.title })
        .from(approvals)
        .innerJoin(workflowInstances, eq(workflowInstances.id, approvals.instanceId))
        .where(eq(approvals.id, approvalId)),
    );
    if (!item || !(TEAMS_ACTIONABLE as readonly string[]).includes(item.key)) {
      return reply('Open it in iPro', 'Decide this one in iPro.');
    }
    try {
      if (verb === APPROVE_VERB) {
        await this.workflows.approve(approvalId);
        return reply(item.title, 'Approved by you.');
      }
      const comment = typeof data.comment === 'string' ? data.comment.trim() : '';
      if (!comment) return reply(item.title, 'Add a comment for the requester to return it.');
      await this.workflows.reject(approvalId, comment.slice(0, 2000));
      return reply(item.title, 'Returned to the requester with your comment.');
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        return reply(item.title, 'You can’t decide this one.');
      }
      if (error instanceof HttpException) {
        const body = error.getResponse();
        const message =
          typeof body === 'object' && body && 'message' in body && typeof body.message === 'string'
            ? body.message
            : error.message;
        return reply(item.title, message);
      }
      throw error;
    }
  }
}
