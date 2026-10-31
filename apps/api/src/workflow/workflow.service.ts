import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  workflowDefinitionSchema,
  type ApprovalCard,
  type NotificationView,
  type WorkflowDefinition,
  type WorkflowView,
} from '@ipro/shared';
import { addWorkingDays } from '../attendance/working-days.js';
import { ShiftsService } from '../attendance/shifts.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import {
  actions as knownActions,
  dataAreas,
  type Action,
  type DataArea,
} from '../authz/permissions.js';
import { businessDate } from '../common/effective-dating.js';
import { requireContext, type Actor } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { approvalDelegations } from '../identity/identity.schema.js';
import { UsersService } from '../identity/users.service.js';
import { JourneyService } from '../journey/journey.service.js';
import { PeopleService } from '../people/people.service.js';
import { SettingsService } from '../people/settings.service.js';
import { WorkflowActions } from './actions.js';
import {
  managerUserOfPerson,
  managerUserOfUser,
  notify,
  personName,
  roleHolders,
  roleLabel,
  userName,
} from './lookups.js';
import { builtInDefinitions } from './built-in-definitions.js';
import { decisionCapacity, nextStepIndex } from './engine-rules.js';
import {
  approvals,
  notifications,
  workflowComments,
  workflowDefinitions,
  workflowInstances,
} from './workflow.schema.js';

type Instance = typeof workflowInstances.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

/**
 * The workflow engine (slice 3): items move through configured approval steps; a rejection returns
 * the item to its submitter with a comment; overdue steps escalate to the approver's manager; final
 * approval runs the definition's action in the same transaction and writes audit and journey records.
 */
@Injectable()
export class WorkflowService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JourneyService) private readonly journey: JourneyService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ShiftsService) private readonly shifts: ShiftsService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(WorkflowActions) private readonly actions: WorkflowActions,
  ) {}

  // ---- Definitions (configuration) ----

  /** Saves a new version of a workflow definition (admins). Running items keep their version. */
  async saveDefinition(key: string, definition: WorkflowDefinition) {
    await this.authz.assert(requireContext().actor!, 'update', { area: 'org_config' });
    this.checkDefinition(definition);
    const { tenantId, actor } = requireContext();
    return this.db.tx(async (tx) => {
      const [latest] = await tx
        .select({ version: workflowDefinitions.version })
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.key, key))
        .orderBy(desc(workflowDefinitions.version))
        .limit(1);
      await tx
        .update(workflowDefinitions)
        .set({ active: false })
        .where(eq(workflowDefinitions.key, key));
      const [row] = await tx
        .insert(workflowDefinitions)
        .values({
          tenantId,
          key,
          version: (latest?.version ?? 0) + 1,
          name: definition.name,
          definition,
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        })
        .returning();
      await this.audit.record(tx, {
        action: 'create',
        table: 'workflow_definition',
        recordId: row!.id,
      });
      return { key, version: row!.version, definition };
    });
  }

  async listDefinitions() {
    await this.authz.assert(requireContext().actor!, 'read', { area: 'org_config' });
    return this.db.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.active, true))
        .orderBy(asc(workflowDefinitions.key));
      const configured = new Set(rows.map((r) => r.key));
      return [
        ...rows.map((r) => ({
          key: r.key,
          version: r.version,
          definition: r.definition,
          builtIn: false,
        })),
        ...Object.entries(builtInDefinitions)
          .filter(([key]) => !configured.has(key))
          .map(([key, definition]) => ({ key, version: 0, definition, builtIn: true })),
      ];
    });
  }

  // ---- Submitting and moving items ----

  /**
   * Starts an item. Callers check who may submit (each workflow has its own rule); the engine checks
   * approvals. Returns the item id.
   */
  async submit(
    tx: Tx,
    input: {
      key: string;
      subjectPersonId: string;
      title: string;
      payload: Record<string, unknown>;
    },
  ): Promise<string> {
    const { tenantId, actor } = requireContext();
    const { row: definitionRow, definition } = await this.definitionFor(tx, input.key);
    const payload = this.actions.get(definition.onApproved).validate(input.payload);
    const summary = await this.people.summary(input.subjectPersonId);
    const [instance] = await tx
      .insert(workflowInstances)
      .values({
        tenantId,
        definitionId: definitionRow.id,
        key: input.key,
        title: input.title,
        subjectPersonId: input.subjectPersonId,
        legalEntityId: summary.legalEntityId,
        payload,
        status: 'pending',
        submittedBy: actor!.userId,
        createdBy: actor!.userId,
        updatedBy: actor!.userId,
      })
      .returning();
    await this.audit.record(tx, {
      action: 'create',
      table: 'workflow_instance',
      recordId: instance!.id,
      subjectPersonId: input.subjectPersonId,
    });
    await this.startStep(tx, instance!, definition, 0);
    return instance!.id;
  }

  /** Generic start for workflows whose action allows it (e.g. record-only reviews). */
  async submitGeneric(input: {
    key: string;
    subjectPersonId: string;
    title: string;
    payload: Record<string, unknown>;
  }): Promise<WorkflowView> {
    const actor = requireContext().actor!;
    const summary = await this.people.summary(input.subjectPersonId);
    await this.authz.assert(actor, 'read', {
      area: 'profile',
      subjectPersonId: input.subjectPersonId,
      legalEntityId: summary.legalEntityId,
    });
    const id = await this.db.tx(async (tx) => {
      const { definition } = await this.definitionFor(tx, input.key);
      if (!this.actions.get(definition.onApproved).genericSubmit) {
        throw new BadRequestException({ message: 'This workflow has its own request screen' });
      }
      return this.submit(tx, input);
    });
    return this.get(id);
  }

  async approve(approvalId: string, comment?: string): Promise<WorkflowView> {
    return this.decide(approvalId, 'approved', comment);
  }

  /** Returns the item to its submitter; a comment is required (spec: shared workflow rules). */
  async reject(approvalId: string, comment: string): Promise<WorkflowView> {
    if (!comment.trim()) throw new BadRequestException({ message: 'Say why you are returning it' });
    return this.decide(approvalId, 'rejected', comment);
  }

  async withdraw(instanceId: string): Promise<WorkflowView> {
    const { actor } = requireContext();
    await this.db.tx(async (tx) => {
      const instance = await this.loadInstance(tx, instanceId);
      if (instance.submittedBy !== actor!.userId) throw new ForbiddenException();
      if (instance.status !== 'pending' && instance.status !== 'returned') {
        throw new ConflictException({
          message: 'Only a pending or returned request can be withdrawn',
        });
      }
      await this.closeOpenApprovals(tx, instanceId);
      await this.setStatus(tx, instance, 'withdrawn');
    });
    return this.get(instanceId);
  }

  /** After a return: send it again, optionally with changes; approval starts from the first step. */
  async resubmit(instanceId: string, payload?: Record<string, unknown>): Promise<WorkflowView> {
    const { actor } = requireContext();
    await this.db.tx(async (tx) => {
      const instance = await this.loadInstance(tx, instanceId);
      if (instance.submittedBy !== actor!.userId) throw new ForbiddenException();
      if (instance.status !== 'returned') {
        throw new ConflictException({ message: 'Only a returned request can be sent again' });
      }
      const definition = await this.definitionOf(tx, instance);
      const next = payload
        ? this.actions.get(definition.onApproved).validate(payload)
        : instance.payload;
      const [updated] = await tx
        .update(workflowInstances)
        .set({
          payload: next,
          status: 'pending',
          currentStep: 0,
          updatedAt: new Date(),
          updatedBy: actor!.userId,
        })
        .where(eq(workflowInstances.id, instanceId))
        .returning();
      await this.audit.record(tx, {
        action: 'update',
        table: 'workflow_instance',
        recordId: instanceId,
        subjectPersonId: instance.subjectPersonId,
        fieldChanges: [{ field: 'status', from: 'returned', to: 'pending' }],
      });
      await this.startStep(tx, updated!, definition, 0);
    });
    return this.get(instanceId);
  }

  async comment(instanceId: string, body: string): Promise<WorkflowView> {
    const { actor, tenantId } = requireContext();
    await this.db.tx(async (tx) => {
      const instance = await this.loadInstance(tx, instanceId);
      await this.assertCanView(tx, instance);
      await tx.insert(workflowComments).values({
        tenantId,
        instanceId,
        authorUserId: actor!.userId,
        body,
        createdBy: actor!.userId,
        updatedBy: actor!.userId,
      });
      const participants = await this.participants(tx, instance);
      await notify(
        tx,
        participants.filter((id) => id !== actor!.userId),
        'workflow_comment',
        `New comment on: ${instance.title}`,
        `/requests/${instanceId}`,
      );
    });
    return this.get(instanceId);
  }

  // ---- Reading ----

  /** Approval cards waiting on the signed-in user, oldest due first. */
  async myApprovals(): Promise<ApprovalCard[]> {
    const actor = requireContext().actor!;
    const today = businessDate(new Date());
    return this.db.tx(async (tx) => {
      const delegators = await this.delegatorsFor(tx, actor.userId, today);
      const roles = [...new Set(actor.roles.map((g) => g.role))];
      const reach: SQL[] = [
        inArray(approvals.assignedUserId, [actor.userId, ...delegators]),
        eq(approvals.escalatedToUserId, actor.userId),
      ];
      if (roles.length > 0) {
        reach.push(
          inArray(approvals.assignedRole, roles),
          inArray(approvals.escalatedToRole, roles),
        );
      }
      const rows = await tx
        .select({ approval: approvals, instance: workflowInstances })
        .from(approvals)
        .innerJoin(workflowInstances, eq(workflowInstances.id, approvals.instanceId))
        .where(and(isNull(approvals.decision), isNull(approvals.closedAt), or(...reach)))
        .orderBy(asc(approvals.dueOn));
      const cards: ApprovalCard[] = [];
      for (const { approval, instance } of rows) {
        const capacity = decisionCapacity(approval, actor, instance.submittedBy, delegators);
        if (!capacity) continue;
        const definition = await this.definitionOf(tx, instance);
        cards.push({
          approvalId: approval.id,
          instanceId: instance.id,
          key: instance.key,
          title: instance.title,
          stepLabel: approval.stepLabel,
          subject: {
            personId: instance.subjectPersonId,
            name: await personName(tx, instance.subjectPersonId),
          },
          submittedBy: await userName(tx, instance.submittedBy),
          submittedAt: instance.submittedAt.toISOString(),
          dueOn: approval.dueOn,
          overdue: approval.dueOn < today,
          escalated: approval.escalatedAt !== null,
          onBehalfOf: capacity.as === 'delegate' ? await userName(tx, capacity.onBehalfOf) : null,
          changes: await this.actions.get(definition.onApproved).describe(tx, instance),
        });
      }
      return cards;
    });
  }

  /** Requests the signed-in user submitted, newest first. */
  async mySubmissions(): Promise<WorkflowView[]> {
    const actor = requireContext().actor!;
    const ids = await this.db.tx((tx) =>
      tx
        .select({ id: workflowInstances.id })
        .from(workflowInstances)
        .where(eq(workflowInstances.submittedBy, actor.userId))
        .orderBy(desc(workflowInstances.submittedAt)),
    );
    return Promise.all(ids.map(({ id }) => this.get(id)));
  }

  async get(instanceId: string): Promise<WorkflowView> {
    const actor = requireContext().actor!;
    return this.db.tx(async (tx) => {
      const instance = await this.loadInstance(tx, instanceId);
      await this.assertCanView(tx, instance);
      const definition = await this.definitionOf(tx, instance);
      const steps = await tx
        .select()
        .from(approvals)
        .where(eq(approvals.instanceId, instanceId))
        .orderBy(asc(approvals.createdAt));
      const comments = await tx
        .select()
        .from(workflowComments)
        .where(eq(workflowComments.instanceId, instanceId))
        .orderBy(asc(workflowComments.createdAt));
      const mine = instance.submittedBy === actor.userId;
      return {
        id: instance.id,
        key: instance.key,
        title: instance.title,
        status: instance.status,
        subject: {
          personId: instance.subjectPersonId,
          name: await personName(tx, instance.subjectPersonId),
        },
        submittedBy: {
          userId: instance.submittedBy,
          name: await userName(tx, instance.submittedBy),
        },
        submittedAt: instance.submittedAt.toISOString(),
        completedAt: instance.completedAt?.toISOString() ?? null,
        changes: await this.actions.get(definition.onApproved).describe(tx, instance),
        steps: await Promise.all(
          steps.map(async (step) => ({
            approvalId: step.id,
            label: step.stepLabel,
            assignedTo: step.assignedUserId
              ? await userName(tx, step.assignedUserId)
              : roleLabel(step.assignedRole),
            dueOn: step.dueOn,
            escalatedTo: step.escalatedToUserId
              ? await userName(tx, step.escalatedToUserId)
              : step.escalatedToRole
                ? roleLabel(step.escalatedToRole)
                : null,
            decision: step.decision,
            decidedBy: step.decidedBy ? await userName(tx, step.decidedBy) : null,
            onBehalfOf: step.onBehalfOf ? await userName(tx, step.onBehalfOf) : null,
            decidedAt: step.decidedAt?.toISOString() ?? null,
            comment: step.comment,
            closed: step.closedAt !== null,
          })),
        ),
        comments: await Promise.all(
          comments.map(async (c) => ({
            id: c.id,
            author: await userName(tx, c.authorUserId),
            body: c.body,
            at: c.createdAt.toISOString(),
          })),
        ),
        canWithdraw: mine && (instance.status === 'pending' || instance.status === 'returned'),
        canResubmit: mine && instance.status === 'returned',
      };
    });
  }

  async myNotifications(): Promise<NotificationView[]> {
    const actor = requireContext().actor!;
    const rows = await this.db.tx((tx) =>
      tx
        .select()
        .from(notifications)
        .where(eq(notifications.recipientUserId, actor.userId))
        .orderBy(desc(notifications.createdAt))
        .limit(100),
    );
    return rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      link: n.link,
      createdAt: n.createdAt.toISOString(),
      read: n.readAt !== null,
    }));
  }

  async markRead(notificationId: string): Promise<void> {
    const actor = requireContext().actor!;
    await this.db.tx((tx) =>
      tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.id, notificationId),
            eq(notifications.recipientUserId, actor.userId),
          ),
        ),
    );
  }

  // ---- Daily sweep: reminders and escalations ----

  /**
   * Sends reminders and escalates overdue steps to the approver's manager (role queues go to HR head).
   * Runs as the system, daily, and is safe to run more than once a day.
   */
  async sweep(today = businessDate(new Date())): Promise<{ reminded: number; escalated: number }> {
    return this.db.tx(async (tx) => {
      const open = await tx
        .select({ approval: approvals, instance: workflowInstances })
        .from(approvals)
        .innerJoin(workflowInstances, eq(workflowInstances.id, approvals.instanceId))
        .where(
          and(
            isNull(approvals.decision),
            isNull(approvals.closedAt),
            lte(approvals.remindOn, today),
          ),
        );
      let reminded = 0;
      let escalated = 0;
      for (const { approval, instance } of open) {
        if (!approval.remindedAt) {
          await tx
            .update(approvals)
            .set({ remindedAt: new Date() })
            .where(eq(approvals.id, approval.id));
          await notify(
            tx,
            await this.approverUsers(tx, approval),
            'approval_reminder',
            `Reminder: ${instance.title}`,
            `/approvals`,
          );
          reminded += 1;
        }
        if (approval.dueOn < today && !approval.escalatedAt) {
          await this.escalate(tx, approval, instance, today);
          escalated += 1;
        }
      }
      return { reminded, escalated };
    });
  }

  // ---- Internals ----

  private async decide(approvalId: string, decision: 'approved' | 'rejected', comment?: string) {
    const actor = requireContext().actor!;
    const today = businessDate(new Date());
    const instanceId = await this.db.tx(async (tx) => {
      const [approval] = await tx.select().from(approvals).where(eq(approvals.id, approvalId));
      if (!approval) throw new NotFoundException();
      if (approval.decision || approval.closedAt) {
        throw new ConflictException({ message: 'This step has already been decided' });
      }
      const instance = await this.loadInstance(tx, approval.instanceId);
      const definition = await this.definitionOf(tx, instance);
      const step = definition.steps[approval.stepIndex]!;
      const capacity = decisionCapacity(
        approval,
        actor,
        instance.submittedBy,
        await this.delegatorsFor(tx, actor.userId, today),
      );
      if (!capacity) throw new ForbiddenException();
      // A delegate acts with the delegator's rights over the subject (decision #23).
      const principal =
        capacity.as === 'delegate'
          ? await this.users.loadActor(tx, instance.tenantId, capacity.onBehalfOf)
          : actor;
      if (!principal) throw new ForbiddenException();
      await this.authz.assert(principal, step.authorize.action as Action, {
        area: step.authorize.area as DataArea,
        subjectPersonId: instance.subjectPersonId,
        legalEntityId: instance.legalEntityId,
      });

      await tx
        .update(approvals)
        .set({
          decision,
          decidedBy: actor.userId,
          onBehalfOf: capacity.as === 'delegate' ? capacity.onBehalfOf : null,
          decidedAt: new Date(),
          comment: comment?.trim() || null,
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(approvals.id, approvalId));
      await this.audit.record(tx, {
        action: 'update',
        table: 'approval',
        recordId: approvalId,
        subjectPersonId: instance.subjectPersonId,
        fieldChanges: [{ field: 'decision', from: null, to: decision }],
      });

      if (decision === 'rejected') {
        await this.setStatus(tx, instance, 'returned');
        await notify(
          tx,
          [instance.submittedBy],
          'workflow_returned',
          `Returned: ${instance.title}`,
          `/requests/${instance.id}`,
        );
      } else {
        await this.startStep(tx, instance, definition, approval.stepIndex + 1, principal);
      }
      return instance.id;
    });
    return this.get(instanceId);
  }

  /** Opens the next applicable step, or completes the item when none is left. */
  private async startStep(
    tx: Tx,
    instance: Instance,
    definition: WorkflowDefinition,
    from: number,
    lastApprover?: Actor,
  ): Promise<void> {
    const index = nextStepIndex(definition.steps, from, instance.payload);
    if (index === -1) {
      await this.complete(tx, instance, definition, lastApprover);
      return;
    }
    const step = definition.steps[index]!;
    const today = businessDate(new Date());
    const assignee = await this.resolveApprover(tx, step.approver, instance, today);
    // A manager who submitted for their own reportee doesn't approve their own request: next step.
    if (assignee.userId && assignee.userId === instance.submittedBy) {
      await this.startStep(tx, instance, definition, index + 1, lastApprover);
      return;
    }
    const calendar = assignee.userId
      ? await this.shifts.calendarForUser(tx, assignee.userId)
      : await this.shifts.calendarForEngagement(tx, null);
    const escalationDays =
      definition.escalationWorkingDays ?? (await this.settings.get(tx, 'approval_escalation_days'));
    const reminderDays =
      definition.reminderWorkingDays ?? (await this.settings.get(tx, 'approval_reminder_days'));

    await tx
      .update(workflowInstances)
      .set({ currentStep: index, updatedAt: new Date() })
      .where(eq(workflowInstances.id, instance.id));
    const [approval] = await tx
      .insert(approvals)
      .values({
        tenantId: instance.tenantId,
        instanceId: instance.id,
        stepIndex: index,
        stepId: step.id,
        stepLabel: step.label,
        assignedUserId: assignee.userId,
        assignedRole: assignee.role,
        assignedLegalEntityId: instance.legalEntityId,
        assignedOn: today,
        remindOn: addWorkingDays(today, Math.min(reminderDays, escalationDays), calendar.isWorking),
        dueOn: addWorkingDays(today, escalationDays, calendar.isWorking),
      })
      .returning();
    await notify(
      tx,
      await this.approverUsers(tx, approval!),
      'approval_requested',
      `Waiting for you: ${instance.title}`,
      '/approvals',
    );
  }

  private async complete(
    tx: Tx,
    instance: Instance,
    definition: WorkflowDefinition,
    approver?: Actor,
  ) {
    const actor = approver ?? requireContext().actor!;
    await this.actions.get(definition.onApproved).apply(tx, instance, actor);
    await this.setStatus(tx, instance, 'approved');
    if (definition.journey) {
      const summary = await this.people.summary(instance.subjectPersonId);
      await this.journey.record(tx, {
        engagementId: summary.engagementId,
        personId: instance.subjectPersonId,
        eventType: definition.journey.eventType,
        category: definition.journey.category,
        occurredOn: businessDate(new Date()),
        title: definition.journey.title,
        sensitivity: definition.journey.sensitivity,
        sourceTable: 'workflow_instance',
        sourceId: instance.id,
      });
    }
    await notify(
      tx,
      [instance.submittedBy],
      'workflow_approved',
      `Approved: ${instance.title}`,
      `/requests/${instance.id}`,
    );
  }

  private async escalate(tx: Tx, approval: ApprovalRow, instance: Instance, today: string) {
    // The approver's manager; a role queue (or an approver without a manager) goes to HR head.
    const manager = approval.assignedUserId
      ? await managerUserOfUser(tx, approval.assignedUserId, today)
      : null;
    const set = manager
      ? { escalatedToUserId: manager, escalatedAt: new Date() }
      : { escalatedToRole: 'hr_head' as const, escalatedAt: new Date() };
    await tx.update(approvals).set(set).where(eq(approvals.id, approval.id));
    await this.audit.record(tx, {
      action: 'update',
      table: 'approval',
      recordId: approval.id,
      subjectPersonId: instance.subjectPersonId,
      fieldChanges: [{ field: 'escalated_to', to: manager ?? 'role:hr_head' }],
    });
    const recipients = manager
      ? [manager]
      : await roleHolders(tx, 'hr_head', approval.assignedLegalEntityId);
    await notify(
      tx,
      recipients,
      'approval_escalated',
      `Overdue, now with you: ${instance.title}`,
      '/approvals',
    );
  }

  private async resolveApprover(
    tx: Tx,
    approver: WorkflowDefinition['steps'][number]['approver'],
    instance: Instance,
    today: string,
  ): Promise<{
    userId: string | null;
    role: 'hr' | 'hr_head' | 'manager' | 'employee' | 'cxo' | 'admin' | null;
  }> {
    if (approver.kind === 'role') return { userId: null, role: approver.role };
    const manager = await managerUserOfPerson(tx, instance.subjectPersonId, today);
    if (approver.kind === 'manager' && manager) return { userId: manager, role: null };
    if (approver.kind === 'manager_of_manager' && manager) {
      const next = await managerUserOfUser(tx, manager, today);
      if (next) return { userId: next, role: null };
    }
    // No manager with a sign-in: HR takes the step rather than it going nowhere.
    return { userId: null, role: 'hr' };
  }

  private async approverUsers(tx: Tx, approval: ApprovalRow): Promise<string[]> {
    if (approval.escalatedToUserId) return [approval.escalatedToUserId];
    if (approval.assignedUserId) return [approval.assignedUserId];
    return roleHolders(tx, approval.assignedRole!, approval.assignedLegalEntityId);
  }

  private async delegatorsFor(tx: Tx, userId: string, today: string): Promise<string[]> {
    const rows = await tx
      .select({ delegator: approvalDelegations.delegatorUserId })
      .from(approvalDelegations)
      .where(
        and(
          eq(approvalDelegations.delegateUserId, userId),
          isNull(approvalDelegations.revokedAt),
          lte(approvalDelegations.startsOn, today),
          sql`${approvalDelegations.endsOn} >= ${today}`,
        ),
      );
    return rows.map((r) => r.delegator);
  }

  /** Submitter, subject, anyone who is or was an approver on it, or someone who may read the subject's profile. */
  private async assertCanView(tx: Tx, instance: Instance) {
    const actor = requireContext().actor!;
    if (instance.submittedBy === actor.userId || actor.personId === instance.subjectPersonId)
      return;
    if ((await this.participants(tx, instance)).includes(actor.userId)) return;
    const today = businessDate(new Date());
    const steps = await tx.select().from(approvals).where(eq(approvals.instanceId, instance.id));
    const delegators = await this.delegatorsFor(tx, actor.userId, today);
    if (
      steps.some(
        (s) =>
          !s.decision &&
          !s.closedAt &&
          decisionCapacity(s, actor, instance.submittedBy, delegators),
      )
    )
      return;
    await this.authz.assert(actor, 'read', {
      area: 'profile',
      subjectPersonId: instance.subjectPersonId,
      legalEntityId: instance.legalEntityId,
    });
  }

  private async participants(tx: Tx, instance: Instance): Promise<string[]> {
    const steps = await tx.select().from(approvals).where(eq(approvals.instanceId, instance.id));
    const ids = new Set<string>([instance.submittedBy]);
    for (const step of steps) {
      for (const id of [
        step.assignedUserId,
        step.escalatedToUserId,
        step.decidedBy,
        step.onBehalfOf,
      ]) {
        if (id) ids.add(id);
      }
    }
    return [...ids];
  }

  private async setStatus(tx: Tx, instance: Instance, status: Instance['status']) {
    const actor = requireContext().actor;
    const done = status === 'approved' || status === 'withdrawn';
    await tx
      .update(workflowInstances)
      .set({
        status,
        completedAt: done ? new Date() : null,
        updatedAt: new Date(),
        updatedBy: actor?.userId ?? null,
      })
      .where(eq(workflowInstances.id, instance.id));
    await this.audit.record(tx, {
      action: 'update',
      table: 'workflow_instance',
      recordId: instance.id,
      subjectPersonId: instance.subjectPersonId,
      fieldChanges: [{ field: 'status', from: instance.status, to: status }],
    });
  }

  private async closeOpenApprovals(tx: Tx, instanceId: string) {
    await tx
      .update(approvals)
      .set({ closedAt: new Date() })
      .where(
        and(
          eq(approvals.instanceId, instanceId),
          isNull(approvals.decision),
          isNull(approvals.closedAt),
        ),
      );
  }

  private async loadInstance(tx: Tx, id: string): Promise<Instance> {
    const [instance] = await tx
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, id));
    if (!instance) throw new NotFoundException();
    return instance;
  }

  /** The definition version the item started under. */
  private async definitionOf(tx: Tx, instance: Instance): Promise<WorkflowDefinition> {
    const [row] = await tx
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, instance.definitionId));
    return workflowDefinitionSchema.parse(row!.definition);
  }

  /** The active version for a key; a built-in default is stored as version 1 on first use. */
  private async definitionFor(tx: Tx, key: string) {
    const [active] = await tx
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.key, key), eq(workflowDefinitions.active, true)));
    if (active)
      return { row: active, definition: workflowDefinitionSchema.parse(active.definition) };
    const builtIn = builtInDefinitions[key];
    if (!builtIn) throw new NotFoundException({ message: `No workflow "${key}"` });
    const [row] = await tx
      .insert(workflowDefinitions)
      .values({
        tenantId: requireContext().tenantId,
        key,
        version: 1,
        name: builtIn.name,
        definition: builtIn,
      })
      .returning();
    return { row: row!, definition: builtIn };
  }

  /** Steps must name a real permission and approver; the action must exist. */
  private checkDefinition(definition: WorkflowDefinition) {
    if (!this.actions.has(definition.onApproved)) {
      throw new BadRequestException({ message: `Unknown action "${definition.onApproved}"` });
    }
    for (const step of definition.steps) {
      if (
        !dataAreas.includes(step.authorize.area as DataArea) ||
        !knownActions.includes(step.authorize.action as Action)
      ) {
        throw new BadRequestException({ message: `Step "${step.id}": unknown permission` });
      }
    }
  }
}
