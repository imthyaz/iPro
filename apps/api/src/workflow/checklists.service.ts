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
  appliesToSchema,
  templateTaskSchema,
  type ChecklistRunView,
  type ChecklistTaskView,
  type ChecklistTemplateInput,
  type MyTaskView,
  type TaskOwner,
} from '@ipro/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { businessDate } from '../common/effective-dating.js';
import { requireContext, type Actor } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { appUsers } from '../identity/identity.schema.js';
import { documents } from '../people/documents.schema.js';
import { assignments, engagements } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { inForce } from '../people/people.queries.js';
import { appliesToMatches, runIsComplete, taskDueOn } from './checklist-rules.js';
import { checklistRuns, checklistTasks, checklistTemplates } from './checklists.schema.js';
import {
  managerUserOfPerson,
  notify,
  personName,
  roleHolders,
  roleLabel,
  userName,
  userOfPerson,
} from './lookups.js';

type TaskRow = typeof checklistTasks.$inferSelect;
type RunRow = typeof checklistRuns.$inferSelect;

const storedTasks = z.array(templateTaskSchema);

const ownerLabel = (owner: TaskOwner) =>
  owner.kind === 'employee'
    ? 'Employee'
    : owner.kind === 'manager'
      ? 'Manager'
      : owner.kind === 'role'
        ? roleLabel(owner.role)
        : owner.label;

/**
 * Checklists (workflow 2; screens A3, H5, E11): templates as versioned configuration, runs per
 * engagement with owners and due dates, tasks done by their owner (or HR) and waived only by HR.
 */
@Injectable()
export class ChecklistsService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PeopleService) private readonly people: PeopleService,
  ) {}

  // ---- Templates ----

  async saveTemplate(key: string, input: ChecklistTemplateInput) {
    const { actor, tenantId } = requireContext();
    await this.authz.assert(actor!, 'update', { area: 'org_config' });
    return this.db.tx(async (tx) => {
      const userIds = input.tasks.flatMap((t) => (t.owner.kind === 'user' ? [t.owner.userId] : []));
      if (userIds.length > 0) {
        const found = await tx
          .select({ id: appUsers.id })
          .from(appUsers)
          .where(inArray(appUsers.id, userIds));
        if (found.length !== new Set(userIds).size)
          throw new BadRequestException({ message: 'Unknown task owner' });
      }
      const [latest] = await tx
        .select({ version: checklistTemplates.version })
        .from(checklistTemplates)
        .where(eq(checklistTemplates.key, key))
        .orderBy(desc(checklistTemplates.version))
        .limit(1);
      await tx
        .update(checklistTemplates)
        .set({ active: false })
        .where(eq(checklistTemplates.key, key));
      const [row] = await tx
        .insert(checklistTemplates)
        .values({
          tenantId,
          key,
          version: (latest?.version ?? 0) + 1,
          name: input.name,
          stage: input.stage,
          appliesTo: input.appliesTo,
          tasks: input.tasks,
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        })
        .returning();
      await this.audit.record(tx, {
        action: 'create',
        table: 'checklist_template',
        recordId: row!.id,
      });
      return { key, version: row!.version, ...input };
    });
  }

  async listTemplates() {
    await this.authz.assert(requireContext().actor!, 'read', { area: 'org_config' });
    const rows = await this.db.tx((tx) =>
      tx
        .select()
        .from(checklistTemplates)
        .where(eq(checklistTemplates.active, true))
        .orderBy(asc(checklistTemplates.name)),
    );
    return rows.map((r) => ({
      key: r.key,
      version: r.version,
      name: r.name,
      stage: r.stage,
      appliesTo: appliesToSchema.parse(r.appliesTo),
      tasks: storedTasks.parse(r.tasks),
    }));
  }

  // ---- Runs ----

  /** HR starts a checklist for a person; slice 4 starts onboarding ones automatically via `startIn`. */
  async start(
    personId: string,
    input: { templateKey: string; anchorDate: string },
  ): Promise<ChecklistRunView> {
    const summary = await this.people.summary(personId);
    await this.authz.assert(requireContext().actor!, 'update', {
      area: 'assignment_history',
      subjectPersonId: personId,
      legalEntityId: summary.legalEntityId,
    });
    const runId = await this.db.tx((tx) =>
      this.startIn(tx, summary.engagementId, input.templateKey, input.anchorDate),
    );
    return this.runView(runId);
  }

  /** Starts a run in the caller's transaction. Refuses a second open run of the same checklist. */
  async startIn(
    tx: Tx,
    engagementId: string,
    templateKey: string,
    anchorDate: string,
  ): Promise<string> {
    const { actor, tenantId } = requireContext();
    const [template] = await tx
      .select()
      .from(checklistTemplates)
      .where(and(eq(checklistTemplates.key, templateKey), eq(checklistTemplates.active, true)));
    if (!template) throw new NotFoundException({ message: `No checklist "${templateKey}"` });

    const [engagement] = await tx
      .select()
      .from(engagements)
      .where(eq(engagements.id, engagementId));
    if (!engagement) throw new NotFoundException();
    const [assignment] = await tx
      .select({ departmentId: assignments.departmentId, locationId: assignments.locationId })
      .from(assignments)
      .where(
        and(
          eq(assignments.engagementId, engagementId),
          inForce(assignments.effectiveFrom, assignments.effectiveTo, anchorDate),
        ),
      );
    const applies = appliesToMatches(appliesToSchema.parse(template.appliesTo), {
      legalEntityId: engagement.legalEntityId,
      engagementType: engagement.type,
      departmentId: assignment?.departmentId ?? null,
      locationId: assignment?.locationId ?? null,
    });
    if (!applies)
      throw new BadRequestException({ message: 'This checklist doesn’t apply to this person' });

    const open = await tx
      .select({ id: checklistRuns.id })
      .from(checklistRuns)
      .innerJoin(checklistTemplates, eq(checklistTemplates.id, checklistRuns.templateId))
      .where(
        and(
          eq(checklistRuns.engagementId, engagementId),
          eq(checklistRuns.status, 'open'),
          eq(checklistTemplates.key, templateKey),
        ),
      );
    if (open.length > 0)
      throw new ConflictException({ message: 'This checklist is already running' });

    const [run] = await tx
      .insert(checklistRuns)
      .values({
        tenantId,
        templateId: template.id,
        engagementId,
        personId: engagement.personId,
        anchorDate,
        status: 'open',
        createdBy: actor?.userId ?? null,
        updatedBy: actor?.userId ?? null,
      })
      .returning();
    const today = businessDate(new Date());
    const manager = await managerUserOfPerson(tx, engagement.personId, today);
    const tasks = storedTasks.parse(template.tasks);
    const rows = tasks.map((task, position) => {
      const owner = task.owner;
      const assignee =
        owner.kind === 'user'
          ? { assigneeUserId: owner.userId, assigneeRole: null }
          : owner.kind === 'role'
            ? { assigneeUserId: null, assigneeRole: owner.role }
            : owner.kind === 'manager'
              ? // No manager with a sign-in: HR picks it up rather than it going nowhere.
                manager
                ? { assigneeUserId: manager, assigneeRole: null }
                : { assigneeUserId: null, assigneeRole: 'hr' as const }
              : { assigneeUserId: null, assigneeRole: null };
      return {
        tenantId,
        runId: run!.id,
        position,
        title: task.title,
        ownerLabel: ownerLabel(owner),
        ownerKind: owner.kind,
        ...assignee,
        dueOn: taskDueOn(anchorDate, task.dueOffsetDays),
        mandatory: task.mandatory,
        requiresDocument: task.requiresDocument,
      };
    });
    const inserted = await tx.insert(checklistTasks).values(rows).returning();
    await this.audit.record(tx, {
      action: 'create',
      table: 'checklist_run',
      recordId: run!.id,
      subjectPersonId: engagement.personId,
    });
    for (const task of inserted) {
      await notify(
        tx,
        await this.ownerUsers(tx, task, run!, engagement.legalEntityId),
        'checklist_task',
        `New task: ${task.title}`,
        '/tasks',
      );
    }
    return run!.id;
  }

  async runsFor(personId: string): Promise<ChecklistRunView[]> {
    const summary = await this.people.summary(personId);
    await this.authz.assert(requireContext().actor!, 'read', {
      area: 'profile',
      subjectPersonId: personId,
      legalEntityId: summary.legalEntityId,
    });
    const runs = await this.db.tx((tx) =>
      tx
        .select({ id: checklistRuns.id })
        .from(checklistRuns)
        .where(eq(checklistRuns.personId, personId))
        .orderBy(desc(checklistRuns.startedAt)),
    );
    return Promise.all(runs.map((r) => this.runView(r.id)));
  }

  /** Onboarding tracker (H5): open checklists the actor may see, most overdue first. */
  async openRuns(): Promise<ChecklistRunView[]> {
    const actor = requireContext().actor!;
    const runs = await this.db.tx((tx) =>
      tx
        .select({
          id: checklistRuns.id,
          personId: checklistRuns.personId,
          legalEntityId: engagements.legalEntityId,
        })
        .from(checklistRuns)
        .innerJoin(engagements, eq(engagements.id, checklistRuns.engagementId))
        .where(eq(checklistRuns.status, 'open')),
    );
    const views: ChecklistRunView[] = [];
    for (const run of runs) {
      const decision = await this.authz.check(actor, 'read', {
        area: 'assignment_history',
        subjectPersonId: run.personId,
        legalEntityId: run.legalEntityId,
      });
      if (decision.allowed) views.push(await this.runView(run.id));
    }
    return views.sort(
      (a, b) => b.progress.overdue - a.progress.overdue || a.anchorDate.localeCompare(b.anchorDate),
    );
  }

  async cancelRun(runId: string, reason: string): Promise<ChecklistRunView> {
    const actor = requireContext().actor!;
    await this.db.tx(async (tx) => {
      const { run, legalEntityId } = await this.loadRun(tx, runId);
      await this.assertHr(actor, run.personId, legalEntityId);
      if (run.status !== 'open')
        throw new ConflictException({ message: 'Only an open checklist can be cancelled' });
      await tx
        .update(checklistRuns)
        .set({
          status: 'cancelled',
          cancelReason: reason,
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(checklistRuns.id, runId));
      await this.audit.record(tx, {
        action: 'update',
        table: 'checklist_run',
        recordId: runId,
        subjectPersonId: run.personId,
        fieldChanges: [{ field: 'status', from: 'open', to: 'cancelled' }],
      });
    });
    return this.runView(runId);
  }

  /**
   * Starts every active template of a stage that applies to the engagement, e.g. the onboarding
   * checklists of an accepted offer (decision #54). Templates that don't apply, or already run, are
   * skipped; their checks come before anything is written.
   */
  async startApplicable(
    tx: Tx,
    engagementId: string,
    stage: 'onboarding' | 'exit' | 'transfer',
    anchorDate: string,
  ): Promise<string[]> {
    const templates = await tx
      .select({ key: checklistTemplates.key })
      .from(checklistTemplates)
      .where(and(eq(checklistTemplates.active, true), eq(checklistTemplates.stage, stage)))
      .orderBy(asc(checklistTemplates.name));
    const runIds: string[] = [];
    for (const { key } of templates) {
      try {
        runIds.push(await this.startIn(tx, engagementId, key, anchorDate));
      } catch (error) {
        if (error instanceof BadRequestException || error instanceof ConflictException) continue;
        throw error;
      }
    }
    return runIds;
  }

  /** Cancels an engagement's open checklists in the caller's transaction (offer withdrawn, no-show). */
  async cancelOpenIn(tx: Tx, engagementId: string, reason: string): Promise<void> {
    const actor = requireContext().actor;
    const open = await tx
      .select()
      .from(checklistRuns)
      .where(and(eq(checklistRuns.engagementId, engagementId), eq(checklistRuns.status, 'open')));
    for (const run of open) {
      await tx
        .update(checklistRuns)
        .set({
          status: 'cancelled',
          cancelReason: reason,
          updatedAt: new Date(),
          updatedBy: actor?.userId ?? null,
        })
        .where(eq(checklistRuns.id, run.id));
      await this.audit.record(tx, {
        action: 'update',
        table: 'checklist_run',
        recordId: run.id,
        subjectPersonId: run.personId,
        fieldChanges: [{ field: 'status', from: 'open', to: 'cancelled' }],
      });
    }
  }

  /** Mandatory tasks due on or before a day that are still open: Day-1 readiness (decision #54). */
  async openMandatoryDueBy(tx: Tx, engagementId: string, day: string): Promise<string[]> {
    const rows = await tx
      .select({ title: checklistTasks.title })
      .from(checklistTasks)
      .innerJoin(checklistRuns, eq(checklistRuns.id, checklistTasks.runId))
      .where(
        and(
          eq(checklistRuns.engagementId, engagementId),
          eq(checklistRuns.status, 'open'),
          eq(checklistTasks.status, 'open'),
          eq(checklistTasks.mandatory, true),
          lte(checklistTasks.dueOn, day),
        ),
      )
      .orderBy(asc(checklistTasks.dueOn));
    return rows.map((r) => r.title);
  }

  // ---- Tasks ----

  /** Open tasks waiting on the signed-in user, including a new joiner's own tasks. */
  async myTasks(): Promise<MyTaskView[]> {
    const actor = requireContext().actor!;
    const roles = [...new Set(actor.roles.map((g) => g.role))];
    const reach: SQL[] = [eq(checklistTasks.assigneeUserId, actor.userId)];
    if (actor.personId) {
      reach.push(
        and(eq(checklistTasks.ownerKind, 'employee'), eq(checklistRuns.personId, actor.personId))!,
      );
    }
    if (roles.length > 0) reach.push(inArray(checklistTasks.assigneeRole, roles));
    return this.db.tx(async (tx) => {
      const rows = await tx
        .select({
          task: checklistTasks,
          run: checklistRuns,
          template: checklistTemplates,
          legalEntityId: engagements.legalEntityId,
        })
        .from(checklistTasks)
        .innerJoin(checklistRuns, eq(checklistRuns.id, checklistTasks.runId))
        .innerJoin(checklistTemplates, eq(checklistTemplates.id, checklistRuns.templateId))
        .innerJoin(engagements, eq(engagements.id, checklistRuns.engagementId))
        .where(
          and(eq(checklistTasks.status, 'open'), eq(checklistRuns.status, 'open'), or(...reach)),
        )
        .orderBy(asc(checklistTasks.dueOn));
      const today = businessDate(new Date());
      const mine: MyTaskView[] = [];
      for (const { task, run, template, legalEntityId } of rows) {
        // Role tasks only for holders in the run's legal entity.
        if (task.assigneeRole && !task.assigneeUserId && task.ownerKind !== 'employee') {
          const holds = actor.roles.some(
            (g) =>
              g.role === task.assigneeRole &&
              (g.legalEntityId === null || g.legalEntityId === legalEntityId),
          );
          if (!holds) continue;
        }
        mine.push({
          ...(await this.taskView(tx, task, today)),
          runId: run.id,
          checklist: template.name,
          person: { personId: run.personId, name: await personName(tx, run.personId) },
        });
      }
      return mine;
    });
  }

  async completeTask(
    taskId: string,
    input: { evidenceDocumentId?: string; note?: string },
  ): Promise<ChecklistRunView> {
    const actor = requireContext().actor!;
    const runId = await this.db.tx(async (tx) => {
      const { task, run, legalEntityId } = await this.loadTask(tx, taskId);
      if (task.status !== 'open' || run.status !== 'open') {
        throw new ConflictException({ message: 'This task is already closed' });
      }
      if (!this.isOwner(task, run, actor, legalEntityId))
        await this.assertHr(actor, run.personId, legalEntityId);
      if (task.requiresDocument) {
        if (!input.evidenceDocumentId)
          throw new BadRequestException({ message: 'Attach the document for this task' });
        const [doc] = await tx
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.id, input.evidenceDocumentId),
              eq(documents.personId, run.personId),
              isNull(documents.deletedAt),
            ),
          );
        if (!doc)
          throw new BadRequestException({ message: 'That document isn’t on this person’s record' });
      }
      await tx
        .update(checklistTasks)
        .set({
          status: 'done',
          doneBy: actor.userId,
          doneAt: new Date(),
          evidenceDocumentId: input.evidenceDocumentId ?? null,
          note: input.note ?? null,
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(checklistTasks.id, taskId));
      await this.audit.record(tx, {
        action: 'update',
        table: 'checklist_task',
        recordId: taskId,
        subjectPersonId: run.personId,
        fieldChanges: [{ field: 'status', from: 'open', to: 'done' }],
      });
      await this.completeRunIfDone(tx, run, legalEntityId);
      return run.id;
    });
    return this.runView(runId);
  }

  /** HR only, with a reason (spec: workflow 2). */
  async waiveTask(taskId: string, reason: string): Promise<ChecklistRunView> {
    const actor = requireContext().actor!;
    const runId = await this.db.tx(async (tx) => {
      const { task, run, legalEntityId } = await this.loadTask(tx, taskId);
      await this.assertHr(actor, run.personId, legalEntityId);
      if (task.status !== 'open' || run.status !== 'open') {
        throw new ConflictException({ message: 'This task is already closed' });
      }
      await tx
        .update(checklistTasks)
        .set({
          status: 'waived',
          waiveReason: reason,
          doneBy: actor.userId,
          doneAt: new Date(),
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(checklistTasks.id, taskId));
      await this.audit.record(tx, {
        action: 'update',
        table: 'checklist_task',
        recordId: taskId,
        subjectPersonId: run.personId,
        fieldChanges: [
          { field: 'status', from: 'open', to: 'waived' },
          { field: 'waive_reason', to: reason },
        ],
      });
      await this.completeRunIfDone(tx, run, legalEntityId);
      return run.id;
    });
    return this.runView(runId);
  }

  /** Reminds owners on the due date and every day while overdue (spec: notifications table). */
  async sweep(today = businessDate(new Date())): Promise<{ reminded: number }> {
    return this.db.tx(async (tx) => {
      const due = await tx
        .select({
          task: checklistTasks,
          run: checklistRuns,
          legalEntityId: engagements.legalEntityId,
        })
        .from(checklistTasks)
        .innerJoin(checklistRuns, eq(checklistRuns.id, checklistTasks.runId))
        .innerJoin(engagements, eq(engagements.id, checklistRuns.engagementId))
        .where(
          and(
            eq(checklistTasks.status, 'open'),
            eq(checklistRuns.status, 'open'),
            lte(checklistTasks.dueOn, today),
            or(
              isNull(checklistTasks.lastRemindedOn),
              sql`${checklistTasks.lastRemindedOn} < ${today}`,
            ),
          ),
        );
      for (const { task, run, legalEntityId } of due) {
        await tx
          .update(checklistTasks)
          .set({ lastRemindedOn: today })
          .where(eq(checklistTasks.id, task.id));
        const overdue = task.dueOn < today;
        await notify(
          tx,
          await this.ownerUsers(tx, task, run, legalEntityId),
          overdue ? 'checklist_task_overdue' : 'checklist_task_due',
          `${overdue ? 'Overdue' : 'Due today'}: ${task.title}`,
          '/tasks',
        );
      }
      return { reminded: due.length };
    });
  }

  // ---- Internals ----

  private async completeRunIfDone(tx: Tx, run: RunRow, legalEntityId: string) {
    const tasks = await tx.select().from(checklistTasks).where(eq(checklistTasks.runId, run.id));
    if (!runIsComplete(tasks)) return;
    await tx
      .update(checklistRuns)
      .set({ status: 'complete', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(checklistRuns.id, run.id));
    await this.audit.record(tx, {
      action: 'update',
      table: 'checklist_run',
      recordId: run.id,
      subjectPersonId: run.personId,
      fieldChanges: [{ field: 'status', from: 'open', to: 'complete' }],
    });
    await notify(
      tx,
      await roleHolders(tx, 'hr', legalEntityId),
      'checklist_complete',
      'Checklist complete',
      '/checklists',
    );
  }

  private isOwner(task: TaskRow, run: RunRow, actor: Actor, legalEntityId: string): boolean {
    if (task.ownerKind === 'employee') return actor.personId === run.personId;
    if (task.assigneeUserId) return task.assigneeUserId === actor.userId;
    return actor.roles.some(
      (g) =>
        g.role === task.assigneeRole &&
        (g.legalEntityId === null || g.legalEntityId === legalEntityId),
    );
  }

  /** HR and HR head look after checklists in their entity (assignment history update rights). */
  private assertHr(actor: Actor, personId: string, legalEntityId: string) {
    if (!actor.roles.some((g) => g.role === 'hr' || g.role === 'hr_head'))
      throw new ForbiddenException();
    return this.authz.assert(actor, 'update', {
      area: 'assignment_history',
      subjectPersonId: personId,
      legalEntityId,
    });
  }

  private async ownerUsers(
    tx: Tx,
    task: TaskRow,
    run: RunRow,
    legalEntityId: string,
  ): Promise<string[]> {
    if (task.ownerKind === 'employee') {
      const user = await userOfPerson(tx, run.personId);
      return user ? [user] : [];
    }
    if (task.assigneeUserId) return [task.assigneeUserId];
    return task.assigneeRole ? roleHolders(tx, task.assigneeRole, legalEntityId) : [];
  }

  private async loadRun(tx: Tx, runId: string) {
    const [row] = await tx
      .select({ run: checklistRuns, legalEntityId: engagements.legalEntityId })
      .from(checklistRuns)
      .innerJoin(engagements, eq(engagements.id, checklistRuns.engagementId))
      .where(eq(checklistRuns.id, runId));
    if (!row) throw new NotFoundException();
    return row;
  }

  private async loadTask(tx: Tx, taskId: string) {
    const [row] = await tx
      .select({
        task: checklistTasks,
        run: checklistRuns,
        legalEntityId: engagements.legalEntityId,
      })
      .from(checklistTasks)
      .innerJoin(checklistRuns, eq(checklistRuns.id, checklistTasks.runId))
      .innerJoin(engagements, eq(engagements.id, checklistRuns.engagementId))
      .where(eq(checklistTasks.id, taskId));
    if (!row) throw new NotFoundException();
    return row;
  }

  private async taskView(tx: Tx, task: TaskRow, today: string): Promise<ChecklistTaskView> {
    return {
      id: task.id,
      title: task.title,
      owner:
        task.ownerKind === 'manager' && task.assigneeUserId
          ? `Manager (${await userName(tx, task.assigneeUserId)})`
          : task.ownerLabel,
      dueOn: task.dueOn,
      overdue: task.status === 'open' && task.dueOn < today,
      mandatory: task.mandatory,
      requiresDocument: task.requiresDocument,
      status: task.status,
      doneBy: task.doneBy ? await userName(tx, task.doneBy) : null,
      doneAt: task.doneAt?.toISOString() ?? null,
      evidenceDocumentId: task.evidenceDocumentId,
      note: task.note,
      waiveReason: task.waiveReason,
    };
  }

  private runView(runId: string): Promise<ChecklistRunView> {
    return this.db.tx(async (tx) => {
      const { run } = await this.loadRun(tx, runId);
      const [template] = await tx
        .select()
        .from(checklistTemplates)
        .where(eq(checklistTemplates.id, run.templateId));
      const tasks = await tx
        .select()
        .from(checklistTasks)
        .where(eq(checklistTasks.runId, runId))
        .orderBy(asc(checklistTasks.position));
      const today = businessDate(new Date());
      const views = await Promise.all(tasks.map((t) => this.taskView(tx, t, today)));
      return {
        id: run.id,
        templateName: template!.name,
        templateVersion: template!.version,
        stage: template!.stage,
        person: { personId: run.personId, name: await personName(tx, run.personId) },
        anchorDate: run.anchorDate,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
        progress: {
          done: views.filter((t) => t.status !== 'open').length,
          total: views.length,
          overdue: views.filter((t) => t.overdue).length,
        },
        tasks: views,
      };
    });
  }
}
