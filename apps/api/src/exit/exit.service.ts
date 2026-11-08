import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  exitReasonWords,
  type ChangeLine,
  type ExitCaseView,
  type ExitInterviewAnswers,
  type ExitInterviewInput,
  type HrAcceptInput,
  type MyExitView,
  type ResignationInput,
  type TerminationInput,
} from '@ipro/shared';
import { z } from 'zod';
import { minutesInIndia } from '../attendance/attendance.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { businessDate } from '../common/effective-dating.js';
import { requireContext, type Actor } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { appUsers } from '../identity/identity.schema.js';
import { JourneyService } from '../journey/journey.service.js';
import { LettersService } from '../letters/letters.service.js';
import { designations } from '../org/org.schema.js';
import { noticePeriodDays } from '../people/hr-settings.js';
import { inForce } from '../people/people.queries.js';
import { assignments, engagements } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { SettingsService } from '../people/settings.service.js';
import {
  checklistRuns,
  checklistTasks,
  checklistTemplates,
} from '../workflow/checklists.schema.js';
import { ChecklistsService } from '../workflow/checklists.service.js';
import { WorkflowActions } from '../workflow/actions.js';
import { notify, roleHolders } from '../workflow/lookups.js';
import { approvals, workflowInstances } from '../workflow/workflow.schema.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { DIRECTORY_ACCOUNTS, type DirectoryAccounts } from './directory-accounts.js';
import { checkLastDay, longDate, noticeLastDay, onProbation } from './exit-rules.js';
import { exitCases } from './exit.schema.js';

type CaseRow = typeof exitCases.$inferSelect;
type EngagementRow = typeof engagements.$inferSelect;

const acceptPayload = z.object({ exitCaseId: z.uuid(), earlyRelease: z.boolean() });
const withdrawPayload = z.object({ exitCaseId: z.uuid() });
const OPEN = ['submitted', 'serving_notice', 'clearance'] as const;
const STEPS = ['manager', 'hr', 'hr_head'] as const;
export const EXIT_CHECKLIST = 'exit_clearance';
/** Raised for IT when iPro can't disable the Entra account itself (decision #82). */
export const ENTRA_REMOVAL = 'entra_account_removal';
/** The access job runs at 23:55 IST; from 23:00 on the last day it counts as the end of it. */
const END_OF_DAY_MINUTES = 23 * 60;

/**
 * Exit (slice 9a; spec workflow 7; decision #80). The employee resigns with a reason and a proposed
 * last day; the manager accepts after recording the retention conversation; HR fixes the last day
 * (earlier than the notice: a buyout or waiver, approved by HR head). Acceptance puts the person on
 * notice and starts the exit checklist. A resignation is withdrawn at once before acceptance and
 * with the manager's and HR's approval after. HR head can also end employment (termination).
 */
@Injectable()
export class ExitService implements OnModuleInit {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(JourneyService) private readonly journey: JourneyService,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(WorkflowActions) private readonly actions: WorkflowActions,
    @Inject(ChecklistsService) private readonly checklists: ChecklistsService,
    @Inject(LettersService) private readonly letters: LettersService,
    @Inject(DIRECTORY_ACCOUNTS) private readonly directory: DirectoryAccounts,
  ) {}

  onModuleInit(): void {
    // Spec workflow 7: all clearance tasks done → Clearance.
    this.checklists.onRunComplete(async (tx, run) => {
      if (run.stage !== 'exit') return;
      const [row] = await tx
        .select()
        .from(exitCases)
        .where(
          and(eq(exitCases.engagementId, run.engagementId), eq(exitCases.status, 'serving_notice')),
        );
      if (!row) return;
      await tx
        .update(exitCases)
        .set({ status: 'clearance', clearanceDoneAt: new Date(), updatedAt: new Date() })
        .where(eq(exitCases.id, row.id));
      await this.record(tx, row, 'exit_clearance_complete', 'Exit clearance complete');
    });
    this.actions.register('exit.accept_resignation', {
      validate: (payload) => {
        const parsed = acceptPayload.safeParse(payload);
        if (!parsed.success) throw new BadRequestException({ message: 'Invalid resignation' });
        return parsed.data;
      },
      describe: (tx, instance) =>
        this.describe(tx, acceptPayload.parse(instance.payload).exitCaseId),
      apply: (tx, instance) => this.accept(tx, acceptPayload.parse(instance.payload).exitCaseId),
      // The manager's and HR's steps need what only the exit page records.
      readyToApprove: async (tx, instance) => {
        const row = await this.load(tx, acceptPayload.parse(instance.payload).exitCaseId);
        const step = await this.stepOf(tx, instance.id);
        if (step === 'manager' && !row?.retentionNote) {
          return 'Record the retention conversation on the exit page first';
        }
        if (step === 'hr' && !row?.hrAcceptedAt) {
          return 'Fix the last working day on the exit page first';
        }
        return null;
      },
      link: (instance) => `/exits/${acceptPayload.parse(instance.payload).exitCaseId}`,
      onStatus: async (tx, instance, status) => {
        if (status !== 'withdrawn') return;
        const id = acceptPayload.parse(instance.payload).exitCaseId;
        await tx
          .update(exitCases)
          .set({ status: 'withdrawn', withdrawnAt: new Date(), updatedAt: new Date() })
          .where(and(eq(exitCases.id, id), eq(exitCases.status, 'submitted')));
      },
    });
    this.actions.register('exit.withdraw', {
      validate: (payload) => {
        const parsed = withdrawPayload.safeParse(payload);
        if (!parsed.success) throw new BadRequestException({ message: 'Invalid withdrawal' });
        return parsed.data;
      },
      describe: (tx, instance) =>
        this.describe(tx, withdrawPayload.parse(instance.payload).exitCaseId, true),
      apply: (tx, instance) =>
        this.withdrawAccepted(tx, withdrawPayload.parse(instance.payload).exitCaseId),
      link: (instance) => `/exits/${withdrawPayload.parse(instance.payload).exitCaseId}`,
    });
  }

  // ---- E10: the employee ----

  async mine(now = new Date()): Promise<MyExitView> {
    const { summary } = await this.self();
    const today = businessDate(now);
    return this.db.tx(async (tx) => {
      const engagement = await this.engagementOf(tx, summary.engagementId);
      const notice = await this.noticeFor(tx, engagement);
      const [row] = await tx
        .select()
        .from(exitCases)
        .where(
          and(eq(exitCases.engagementId, engagement.id), inArray(exitCases.status, [...OPEN])),
        );
      return {
        current: row ? await this.view(tx, row) : null,
        noticeDays: notice,
        noticeLastDay: noticeLastDay(today, notice),
        onProbation: onProbation(engagement),
      };
    });
  }

  async resign(input: ResignationInput, now = new Date()): Promise<ExitCaseView> {
    const { summary, actor } = await this.self();
    await this.authz.assert(actor, 'create', {
      area: 'exit',
      subjectPersonId: summary.personId,
      legalEntityId: summary.legalEntityId,
    });
    const today = businessDate(now);
    return this.db.tx(async (tx) => {
      const engagement = await this.engagementOf(tx, summary.engagementId);
      if (engagement.status !== 'active') {
        throw new BadRequestException({ message: 'Only someone currently working can resign' });
      }
      await this.assertNoOpenCase(tx, engagement.id);
      const notice = await this.noticeFor(tx, engagement);
      const noticeDay = noticeLastDay(today, notice);
      const check = checkLastDay(today, noticeDay, input.proposedLastDay);
      if ('problem' in check) throw new BadRequestException({ message: check.problem });
      const [row] = await tx
        .insert(exitCases)
        .values({
          tenantId: requireContext().tenantId,
          engagementId: engagement.id,
          personId: summary.personId,
          kind: 'resignation',
          status: 'submitted',
          resignationDate: today,
          reason: input.reason,
          reasonNote: input.note || null,
          noticeDays: notice,
          noticeLastDay: noticeDay,
          proposedLastDay: input.proposedLastDay,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning();
      const name = summary.preferredName ?? summary.legalName;
      const instanceId = await this.workflows.submit(tx, {
        key: 'resignation',
        subjectPersonId: summary.personId,
        title: `Resignation: ${name}, last day proposed ${longDate(input.proposedLastDay)}`,
        payload: { exitCaseId: row!.id, earlyRelease: false },
      });
      await tx
        .update(exitCases)
        .set({ workflowInstanceId: instanceId })
        .where(eq(exitCases.id, row!.id));
      // Spec notifications: the manager (the approval) and HR, at once.
      await notify(
        tx,
        await roleHolders(tx, 'hr', summary.legalEntityId),
        'resignation_submitted',
        `Resignation: ${name}`,
        `/exits/${row!.id}`,
      );
      await this.journey.record(tx, {
        engagementId: engagement.id,
        personId: summary.personId,
        eventType: 'resignation_submitted',
        category: 'exit',
        occurredOn: today,
        title: 'Resignation submitted',
        detail: { proposedLastDay: input.proposedLastDay },
        sensitivity: 'manager',
        sourceTable: 'exit_case',
        sourceId: row!.id,
      });
      return this.view(tx, (await this.load(tx, row!.id))!);
    });
  }

  /** Before acceptance: withdrawn at once. After: the manager and HR approve (spec). */
  async withdraw(id: string, reason: string): Promise<ExitCaseView> {
    const actor = requireContext().actor!;
    return this.db.tx(async (tx) => {
      const row = await this.mustLoad(tx, id);
      if (row.personId !== actor.personId) throw new ForbiddenException();
      const summary = await this.people.summary(row.personId);
      await this.authz.assert(actor, 'withdraw', {
        area: 'exit',
        subjectPersonId: row.personId,
        legalEntityId: summary.legalEntityId,
      });
      if (row.kind !== 'resignation') {
        throw new BadRequestException({ message: 'Only a resignation can be withdrawn' });
      }
      await tx
        .update(exitCases)
        .set({ withdrawReason: reason, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(exitCases.id, id));
      if (row.status === 'submitted') {
        if (row.workflowInstanceId) await this.workflows.cancelIn(tx, row.workflowInstanceId);
        await tx
          .update(exitCases)
          .set({ status: 'withdrawn', withdrawnAt: new Date() })
          .where(eq(exitCases.id, id));
        await this.record(tx, row, 'resignation_withdrawn', 'Resignation withdrawn');
      } else if (row.status === 'serving_notice') {
        if (row.withdrawalInstanceId) {
          const [open] = await tx
            .select({ status: workflowInstances.status })
            .from(workflowInstances)
            .where(eq(workflowInstances.id, row.withdrawalInstanceId));
          if (open?.status === 'pending') {
            throw new ConflictException({
              message: 'Your withdrawal is already with your manager',
            });
          }
        }
        const instanceId = await this.workflows.submit(tx, {
          key: 'resignation_withdrawal',
          subjectPersonId: row.personId,
          title: `Withdraw resignation: ${summary.preferredName ?? summary.legalName}`,
          payload: { exitCaseId: id },
        });
        await tx
          .update(exitCases)
          .set({ withdrawalInstanceId: instanceId })
          .where(eq(exitCases.id, id));
      } else {
        throw new BadRequestException({ message: 'This exit can no longer be withdrawn' });
      }
      return this.view(tx, (await this.load(tx, id))!);
    });
  }

  // ---- The manager and HR ----

  /** The manager records the retention conversation and accepts (their approval step). */
  async managerAccept(id: string, retentionNote: string): Promise<ExitCaseView> {
    const actor = requireContext().actor!;
    return this.db.tx(async (tx) => {
      const row = await this.mustLoad(tx, id);
      await this.assertCan(tx, actor, row, 'approve');
      if (row.status !== 'submitted' || (await this.waitingFor(tx, row)) !== 'manager') {
        throw new ConflictException({ message: 'This resignation isn’t waiting for the manager' });
      }
      await tx
        .update(exitCases)
        .set({
          retentionNote,
          managerAcceptedBy: actor.userId,
          managerAcceptedAt: new Date(),
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(exitCases.id, id));
      await this.approveMine(tx, row.workflowInstanceId!);
      return this.view(tx, (await this.load(tx, id))!);
    });
  }

  /** HR fixes the last working day (and any buyout or waiver) and accepts. */
  async hrAccept(id: string, input: HrAcceptInput): Promise<ExitCaseView> {
    const actor = requireContext().actor!;
    return this.db.tx(async (tx) => {
      const row = await this.mustLoad(tx, id);
      await this.assertCan(tx, actor, row, 'update');
      if (row.status !== 'submitted' || (await this.waitingFor(tx, row)) !== 'hr') {
        throw new ConflictException({ message: 'This resignation isn’t waiting for HR' });
      }
      const check = checkLastDay(row.resignationDate, row.noticeLastDay, input.lastWorkingDate);
      if ('problem' in check) throw new BadRequestException({ message: check.problem });
      const early = input.earlyRelease ?? null;
      if (check.earlyBy > 0 && !early) {
        throw new BadRequestException({
          message: `A last day ${check.earlyBy} days before the end of the notice needs a buyout or a waiver`,
        });
      }
      await tx
        .update(exitCases)
        .set({
          lastWorkingDate: input.lastWorkingDate,
          earlyRelease: check.earlyBy > 0 ? early : null,
          buyoutDays: check.earlyBy > 0 && early === 'buyout' ? check.earlyBy : null,
          hrNote: input.note || null,
          hrAcceptedBy: actor.userId,
          hrAcceptedAt: new Date(),
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(exitCases.id, id));
      // Decision #80: an early release goes to HR head as one more step.
      const [instance] = await tx
        .select({ payload: workflowInstances.payload })
        .from(workflowInstances)
        .where(eq(workflowInstances.id, row.workflowInstanceId!));
      await tx
        .update(workflowInstances)
        .set({ payload: { ...instance!.payload, earlyRelease: check.earlyBy > 0 } })
        .where(eq(workflowInstances.id, row.workflowInstanceId!));
      await this.approveMine(tx, row.workflowInstanceId!);
      return this.view(tx, (await this.load(tx, id))!);
    });
  }

  /** HR head ends employment: on notice to the day given, a termination letter, the checklist. */
  async terminate(
    personId: string,
    input: TerminationInput,
    now = new Date(),
  ): Promise<ExitCaseView> {
    const actor = requireContext().actor!;
    const summary = await this.people.summary(personId);
    await this.authz.assert(actor, 'terminate', {
      area: 'exit',
      subjectPersonId: personId,
      legalEntityId: summary.legalEntityId,
    });
    const today = businessDate(now);
    return this.db.tx(async (tx) => {
      const engagement = await this.engagementOf(tx, summary.engagementId);
      if (engagement.status !== 'active') {
        throw new BadRequestException({
          message: 'Only someone currently working can be terminated',
        });
      }
      await this.assertNoOpenCase(tx, engagement.id);
      if (input.lastWorkingDate < today) {
        throw new BadRequestException({ message: 'The last working day can’t be in the past' });
      }
      const notice = await this.noticeFor(tx, engagement);
      const [row] = await tx
        .insert(exitCases)
        .values({
          tenantId: requireContext().tenantId,
          engagementId: engagement.id,
          personId,
          kind: 'termination',
          status: 'serving_notice',
          resignationDate: today,
          noticeDays: notice,
          noticeLastDay: noticeLastDay(today, notice),
          lastWorkingDate: input.lastWorkingDate,
          terminationReason: input.reason,
          acceptedAt: new Date(),
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning();
      await this.startNotice(tx, row!, 'terminated');
      await this.letters.generateIn(tx, summary, {
        templateKey: 'termination',
        extra: { lastWorkingDate: longDate(input.lastWorkingDate) },
        approval: false,
      });
      await this.audit.record(tx, {
        action: 'create',
        table: 'exit_case',
        recordId: row!.id,
        subjectPersonId: personId,
        fieldChanges: [{ field: 'kind', to: 'termination' }],
      });
      await this.record(
        tx,
        row!,
        'terminated',
        `Employment ends; last working day ${longDate(input.lastWorkingDate)}`,
        'hr',
      );
      return this.view(tx, (await this.load(tx, row!.id))!);
    });
  }

  // ---- Clearance, the exit interview and the exit (slice 9b) ----

  /** HR records the exit interview, or that the employee declined it, and the rehire flag. */
  async recordInterview(id: string, input: ExitInterviewInput): Promise<ExitCaseView> {
    const actor = requireContext().actor!;
    return this.db.tx(async (tx) => {
      const row = await this.mustLoad(tx, id);
      await this.assertCan(tx, actor, row, 'update');
      if (row.status !== 'serving_notice' && row.status !== 'clearance') {
        throw new BadRequestException({ message: 'The exit interview is for someone on notice' });
      }
      const declined = input.declined ?? false;
      await tx
        .update(exitCases)
        .set({
          interviewRecordedAt: new Date(),
          interviewRecordedBy: actor.userId,
          interviewDeclined: declined,
          interviewAnswers: declined ? null : (input.answers ?? null),
          interviewNote: input.note || null,
          rehireEligible: input.rehireEligible,
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(exitCases.id, id));
      await this.audit.record(tx, {
        action: 'update',
        table: 'exit_case',
        recordId: id,
        subjectPersonId: row.personId,
        fieldChanges: [
          { field: 'exit_interview', to: declined ? 'declined' : 'recorded' },
          { field: 'rehire_eligible', to: String(input.rehireEligible) },
        ],
      });
      return this.view(tx, (await this.load(tx, id))!);
    });
  }

  /**
   * HR completes the exit (spec: Clearance → Exited) once every clearance task is done, the exit
   * interview is recorded and the last working day has come: relieving and experience letters,
   * the rehire flag, and the Exit event.
   */
  async complete(id: string, now = new Date()): Promise<ExitCaseView> {
    const actor = requireContext().actor!;
    const today = businessDate(now);
    return this.db.tx(async (tx) => {
      const row = await this.mustLoad(tx, id);
      await this.assertCan(tx, actor, row, 'update');
      const blockers = this.blockers(row, await this.checklistOf(tx, row), today);
      if (row.status !== 'serving_notice' && row.status !== 'clearance') {
        throw new BadRequestException({ message: 'This exit isn’t open' });
      }
      if (blockers.length)
        throw new BadRequestException({ message: blockers[0], problems: blockers });
      await tx
        .update(exitCases)
        .set({
          status: 'exited',
          exitedAt: new Date(),
          exitedBy: actor.userId,
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(exitCases.id, id));
      await tx
        .update(engagements)
        .set({
          status: 'exited',
          rehireEligible: row.rehireEligible,
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(engagements.id, row.engagementId));
      const summary = await this.people.summary(row.personId);
      for (const templateKey of ['relieving', 'experience']) {
        await this.letters.generateIn(tx, summary, { templateKey, extra: {}, approval: false });
      }
      await this.audit.record(tx, {
        action: 'update',
        table: 'exit_case',
        recordId: id,
        subjectPersonId: row.personId,
        fieldChanges: [{ field: 'status', from: row.status, to: 'exited' }],
      });
      await this.record(
        tx,
        row,
        'exit',
        `Exited; last working day ${longDate(row.lastWorkingDate!)}`,
      );
      return this.view(tx, (await this.load(tx, id))!);
    });
  }

  /**
   * The access job (decision #82; slice 9 done-when #2): at the end of the last working day the
   * leaver's iPro account is disabled (their sessions end with it) and their Entra account through
   * Microsoft Graph; where that can't be done (not set up, refused, no Entra link) IT gets a task.
   * Safe to run again; a missed run catches up the next day.
   */
  async disableDueAccounts(now = new Date()): Promise<{ disabled: number }> {
    const today = businessDate(now);
    const endOfDay = minutesInIndia(now) >= END_OF_DAY_MINUTES;
    const due = await this.db.tx((tx) =>
      tx
        .select()
        .from(exitCases)
        .where(
          and(
            inArray(exitCases.status, ['serving_notice', 'clearance', 'exited']),
            isNull(exitCases.accessDisabledAt),
          ),
        ),
    );
    let disabled = 0;
    for (const row of due) {
      const last = row.lastWorkingDate;
      if (!last || last > today || (last === today && !endOfDay)) continue;
      await this.db.tx(async (tx) => {
        const users = await tx
          .update(appUsers)
          .set({ status: 'disabled', updatedAt: new Date() })
          .where(and(eq(appUsers.personId, row.personId), eq(appUsers.status, 'active')))
          .returning({ id: appUsers.id, entraObjectId: appUsers.entraObjectId });
        for (const user of users) {
          await this.audit.record(tx, {
            action: 'update',
            table: 'app_user',
            recordId: user.id,
            subjectPersonId: row.personId,
            fieldChanges: [{ field: 'status', from: 'active', to: 'disabled' }],
          });
        }
        const objectIds = users.flatMap((u) => (u.entraObjectId ? [u.entraObjectId] : []));
        let method: 'entra' | 'it_task' = objectIds.length ? 'entra' : 'it_task';
        for (const objectId of objectIds) {
          try {
            await this.directory.disable(objectId);
          } catch {
            method = 'it_task';
          }
        }
        if (method === 'it_task') await this.raiseItTask(tx, row, today);
        await tx
          .update(exitCases)
          .set({ accessDisabledAt: new Date(), accessMethod: method, updatedAt: new Date() })
          .where(and(eq(exitCases.id, row.id), isNull(exitCases.accessDisabledAt)));
        disabled++;
      });
    }
    return { disabled };
  }

  // ---- H8: the exit tracker ----

  async list(closed = false): Promise<ExitCaseView[]> {
    const actor = requireContext().actor!;
    return this.db.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(exitCases)
        .where(closed ? undefined : inArray(exitCases.status, [...OPEN]))
        .orderBy(asc(exitCases.lastWorkingDate), desc(exitCases.createdAt));
      const out: ExitCaseView[] = [];
      for (const row of rows) {
        if (row.personId === actor.personId) continue;
        if (await this.canRead(tx, actor, row)) out.push(await this.view(tx, row));
      }
      return out;
    });
  }

  async get(id: string): Promise<ExitCaseView> {
    const actor = requireContext().actor!;
    return this.db.tx(async (tx) => {
      const row = await this.mustLoad(tx, id);
      if (row.personId !== actor.personId && !(await this.canRead(tx, actor, row))) {
        throw new ForbiddenException();
      }
      return this.view(tx, row);
    });
  }

  // ---- Internals ----

  private async self() {
    const actor = requireContext().actor!;
    if (!actor.personId) throw new ForbiddenException();
    return { actor, summary: await this.people.summary(actor.personId) };
  }

  /** Spec business rules: 30 days on probation, 60 confirmed, 90 Manager and above (settings). */
  private async noticeFor(tx: Tx, engagement: EngagementRow): Promise<number> {
    const today = businessDate(new Date());
    const [current] = await tx
      .select({ band: designations.designationBand })
      .from(assignments)
      .innerJoin(designations, eq(designations.id, assignments.designationId))
      .where(
        and(
          eq(assignments.engagementId, engagement.id),
          inForce(assignments.effectiveFrom, assignments.effectiveTo, today),
        ),
      );
    return noticePeriodDays(
      onProbation(engagement),
      current?.band ?? '',
      await this.settings.get(tx, 'notice_days'),
    );
  }

  /** Final approval: on notice to the agreed day, and the exit checklist. */
  private async accept(tx: Tx, id: string): Promise<void> {
    const row = await this.load(tx, id);
    if (!row || row.status !== 'submitted') return;
    const lastDay = row.lastWorkingDate ?? row.proposedLastDay ?? row.noticeLastDay;
    await tx
      .update(exitCases)
      .set({
        status: 'serving_notice',
        lastWorkingDate: lastDay,
        acceptedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(exitCases.id, id));
    await this.startNotice(tx, { ...row, lastWorkingDate: lastDay }, row.reason ?? 'resigned');
    await this.record(
      tx,
      row,
      'resignation_accepted',
      `Resignation accepted; last working day ${longDate(lastDay)}`,
    );
  }

  private async startNotice(tx: Tx, row: CaseRow, exitReason: string): Promise<void> {
    await tx
      .update(engagements)
      .set({
        status: 'on_notice',
        resignationDate: row.resignationDate,
        lastWorkingDate: row.lastWorkingDate,
        exitReason,
        updatedAt: new Date(),
        updatedBy: requireContext().actor?.userId ?? null,
      })
      .where(eq(engagements.id, row.engagementId));
    await this.checklists.ensureBuiltIn(tx, EXIT_CHECKLIST, {
      name: 'Exit clearance',
      stage: 'exit',
      appliesTo: {},
      // Days are relative to the last working day. IT and finance are admins and HR until an admin
      // names the people on this template (decision #15).
      tasks: [
        task('Hand over work, documents and passwords', { kind: 'manager' }, -5),
        task('Return the laptop, ID card and access card', { kind: 'role', role: 'admin' }, 0),
        task(
          'Remove access to tools, client systems and shared drives',
          { kind: 'role', role: 'admin' },
          0,
        ),
        task('Clear advances, loans and expense claims', { kind: 'role', role: 'hr' }, -2),
        task('Record the exit interview', { kind: 'role', role: 'hr' }, -1),
      ],
    });
    await this.checklists.startApplicable(tx, row.engagementId, 'exit', row.lastWorkingDate!);
  }

  /** The manager and HR approved a withdrawal: back to work, the exit checklist cancelled. */
  private async withdrawAccepted(tx: Tx, id: string): Promise<void> {
    const row = await this.load(tx, id);
    if (!row || row.status !== 'serving_notice') return;
    await tx
      .update(exitCases)
      .set({ status: 'withdrawn', withdrawnAt: new Date(), updatedAt: new Date() })
      .where(eq(exitCases.id, id));
    await tx
      .update(engagements)
      .set({
        status: 'active',
        resignationDate: null,
        lastWorkingDate: null,
        exitReason: null,
        updatedAt: new Date(),
      })
      .where(eq(engagements.id, row.engagementId));
    await this.checklists.cancelOpenIn(tx, row.engagementId, 'Resignation withdrawn', 'exit');
    await this.record(tx, row, 'resignation_withdrawn', 'Resignation withdrawn');
  }

  /** Why an exit can't be completed yet, in plain words (empty when it can). */
  private blockers(row: CaseRow, checklist: ExitCaseView['checklist'], today: string): string[] {
    if (row.status !== 'serving_notice' && row.status !== 'clearance') return [];
    const out: string[] = [];
    if (!row.clearanceDoneAt) {
      out.push(
        checklist
          ? `The exit checklist isn’t finished (${checklist.done} of ${checklist.total} done)`
          : 'The exit checklist hasn’t started',
      );
    }
    if (!row.interviewRecordedAt) out.push('Record the exit interview first');
    if (row.lastWorkingDate && row.lastWorkingDate > today) {
      out.push(`The last working day is ${longDate(row.lastWorkingDate)}`);
    }
    return out;
  }

  /** Progress of the exit checklist (open or finished). */
  private async checklistOf(tx: Tx, row: CaseRow): Promise<ExitCaseView['checklist']> {
    const runs = await tx
      .select({ id: checklistRuns.id })
      .from(checklistRuns)
      .innerJoin(checklistTemplates, eq(checklistTemplates.id, checklistRuns.templateId))
      .where(
        and(
          eq(checklistRuns.engagementId, row.engagementId),
          eq(checklistTemplates.stage, 'exit'),
          inArray(checklistRuns.status, ['open', 'complete']),
        ),
      );
    if (runs.length === 0) return null;
    const tasks = await tx
      .select({ status: checklistTasks.status })
      .from(checklistTasks)
      .where(
        inArray(
          checklistTasks.runId,
          runs.map((r) => r.id),
        ),
      );
    return { done: tasks.filter((t) => t.status !== 'open').length, total: tasks.length };
  }

  /** IT disables the Entra account and mailbox by hand (an access checklist, like decision #58). */
  private async raiseItTask(tx: Tx, row: CaseRow, today: string): Promise<void> {
    await this.checklists.ensureBuiltIn(tx, ENTRA_REMOVAL, {
      name: 'Leaver account removal',
      stage: 'access',
      appliesTo: {},
      tasks: [
        {
          title: 'Disable the Microsoft Entra account and mailbox',
          // Admins until an admin names the IT person on this template (decisions #15, #81).
          owner: { kind: 'role', role: 'admin' },
          dueOffsetDays: 0,
          mandatory: true,
          requiresDocument: false,
        },
      ],
    });
    try {
      await this.checklists.startIn(tx, row.engagementId, ENTRA_REMOVAL, today);
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
    }
  }

  /** Approves the open step of a workflow as the signed-in user (the engine checks they may). */
  private async approveMine(tx: Tx, instanceId: string): Promise<void> {
    const [open] = await tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.instanceId, instanceId),
          isNull(approvals.decision),
          isNull(approvals.closedAt),
        ),
      );
    if (!open) throw new ConflictException({ message: 'Nothing is waiting for you here' });
    await this.workflows.approve(open.id);
  }

  private async stepOf(tx: Tx, instanceId: string): Promise<(typeof STEPS)[number] | null> {
    const [instance] = await tx
      .select({ status: workflowInstances.status, step: workflowInstances.currentStep })
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId));
    if (!instance || instance.status !== 'pending') return null;
    return STEPS[instance.step] ?? null;
  }

  private async waitingFor(tx: Tx, row: CaseRow) {
    return row.status === 'submitted' && row.workflowInstanceId
      ? this.stepOf(tx, row.workflowInstanceId)
      : null;
  }

  private async canRead(tx: Tx, actor: Actor, row: CaseRow): Promise<boolean> {
    const decision = await this.authz.check(actor, 'read', await this.resource(row));
    return decision.allowed;
  }

  private async assertCan(tx: Tx, actor: Actor, row: CaseRow, action: 'approve' | 'update') {
    if (row.personId === actor.personId) throw new ForbiddenException();
    await this.authz.assert(actor, action, await this.resource(row));
  }

  private async resource(row: CaseRow) {
    const summary = await this.people.summary(row.personId);
    return {
      area: 'exit' as const,
      subjectPersonId: row.personId,
      legalEntityId: summary.legalEntityId,
    };
  }

  /** HR and HR head see the retention note, as does the manager who wrote it. */
  private async seesRetention(actor: Actor, row: CaseRow): Promise<boolean> {
    if (row.personId === actor.personId) return false;
    if (row.managerAcceptedBy === actor.userId) return true;
    const resource = await this.resource(row);
    return (
      (await this.authz.check(actor, 'update', resource)).allowed ||
      (await this.authz.check(actor, 'terminate', resource)).allowed
    );
  }

  private async view(tx: Tx, row: CaseRow): Promise<ExitCaseView> {
    const actor = requireContext().actor!;
    const summary = await this.people.summary(row.personId);
    const waiting = await this.waitingFor(tx, row);
    let withdrawal: ExitCaseView['withdrawal'] = null;
    if (row.withdrawalInstanceId && row.status === 'serving_notice') {
      const [w] = await tx
        .select({ status: workflowInstances.status })
        .from(workflowInstances)
        .where(eq(workflowInstances.id, row.withdrawalInstanceId));
      if (w?.status === 'pending' || w?.status === 'returned') {
        withdrawal = { status: w.status, requestId: row.withdrawalInstanceId };
      }
    }
    const checklist = await this.checklistOf(tx, row);
    const own = row.personId === actor.personId;
    const resource = await this.resource(row);
    const isHr = !own && (await this.authz.check(actor, 'update', resource)).allowed;
    const seesAnswers =
      isHr || (!own && (await this.authz.check(actor, 'terminate', resource)).allowed);
    const blockers = this.blockers(row, checklist, businessDate(new Date()));
    const open = row.status === 'serving_notice' || row.status === 'clearance';
    return {
      id: row.id,
      personId: row.personId,
      name: summary.preferredName ?? summary.legalName,
      employeeCode: summary.employeeCode,
      kind: row.kind,
      status: row.status,
      resignationDate: row.resignationDate,
      reason: (row.reason as ExitCaseView['reason']) ?? null,
      reasonNote: row.reasonNote,
      noticeDays: row.noticeDays,
      noticeLastDay: row.noticeLastDay,
      proposedLastDay: row.proposedLastDay,
      lastWorkingDate: row.lastWorkingDate,
      earlyRelease: row.earlyRelease,
      buyoutDays: row.buyoutDays,
      retentionNote: (await this.seesRetention(actor, row)) ? row.retentionNote : null,
      waitingFor: waiting,
      requestId: row.workflowInstanceId,
      withdrawal,
      checklist,
      clearanceDoneAt: row.clearanceDoneAt?.toISOString() ?? null,
      interview: row.interviewRecordedAt
        ? {
            recordedAt: row.interviewRecordedAt.toISOString(),
            declined: row.interviewDeclined ?? false,
            rehireEligible: row.rehireEligible ?? false,
            answers: seesAnswers ? (row.interviewAnswers as ExitInterviewAnswers | null) : null,
          }
        : null,
      access:
        row.accessDisabledAt && row.accessMethod
          ? { disabledAt: row.accessDisabledAt.toISOString(), method: row.accessMethod }
          : null,
      exitedAt: row.exitedAt?.toISOString() ?? null,
      blockers: isHr || seesAnswers ? blockers : [],
      can: {
        withdraw:
          own &&
          row.kind === 'resignation' &&
          (row.status === 'submitted' || (row.status === 'serving_notice' && !withdrawal)),
        managerAccept:
          !own &&
          waiting === 'manager' &&
          (await this.authz.check(actor, 'approve', resource)).allowed,
        hrAccept: waiting === 'hr' && isHr,
        recordInterview: isHr && open,
        completeExit: isHr && open && blockers.length === 0,
      },
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** The card: the resignation, the notice, the last day and any early release. */
  private async describe(tx: Tx, id: string, withdrawal = false): Promise<ChangeLine[]> {
    const row = await this.load(tx, id);
    if (!row) return [];
    const lines: ChangeLine[] = [];
    if (withdrawal) {
      lines.push({ label: 'Withdraw', from: 'Serving notice', to: 'Continue working' });
      if (row.withdrawReason) lines.push({ label: 'Why', from: null, to: row.withdrawReason });
    }
    lines.push(
      { label: 'Resigned on', from: null, to: longDate(row.resignationDate) },
      {
        label: 'Notice',
        from: null,
        to: `${row.noticeDays} days, to ${longDate(row.noticeLastDay)}`,
      },
    );
    if (row.proposedLastDay) {
      lines.push({ label: 'Last day proposed', from: null, to: longDate(row.proposedLastDay) });
    }
    if (row.lastWorkingDate) {
      lines.push({ label: 'Last working day', from: null, to: longDate(row.lastWorkingDate) });
    }
    if (row.earlyRelease) {
      lines.push({
        label: 'Early release',
        from: null,
        to:
          row.earlyRelease === 'buyout'
            ? `Buyout of ${row.buyoutDays} notice days`
            : 'Notice waived',
      });
    }
    if (row.reason) {
      lines.push({
        label: 'Reason',
        from: null,
        to: [exitReasonWords[row.reason as keyof typeof exitReasonWords], row.reasonNote]
          .filter(Boolean)
          .join(': '),
      });
    }
    return lines;
  }

  private async record(
    tx: Tx,
    row: CaseRow,
    eventType: string,
    title: string,
    sensitivity: 'manager' | 'hr' = 'manager',
  ) {
    await this.journey.record(tx, {
      engagementId: row.engagementId,
      personId: row.personId,
      eventType,
      category: 'exit',
      occurredOn: businessDate(new Date()),
      title,
      detail: { lastWorkingDate: row.lastWorkingDate },
      sensitivity,
      sourceTable: 'exit_case',
      sourceId: row.id,
    });
  }

  private async assertNoOpenCase(tx: Tx, engagementId: string) {
    const [open] = await tx
      .select({ id: exitCases.id })
      .from(exitCases)
      .where(and(eq(exitCases.engagementId, engagementId), inArray(exitCases.status, [...OPEN])));
    if (open) throw new ConflictException({ message: 'There is already an exit in progress' });
  }

  private async engagementOf(tx: Tx, id: string): Promise<EngagementRow> {
    const [row] = await tx.select().from(engagements).where(eq(engagements.id, id));
    if (!row) throw new NotFoundException();
    return row;
  }

  private async load(tx: Tx, id: string): Promise<CaseRow | undefined> {
    const [row] = await tx.select().from(exitCases).where(eq(exitCases.id, id));
    return row;
  }

  private async mustLoad(tx: Tx, id: string): Promise<CaseRow> {
    const row = await this.load(tx, id);
    if (!row) throw new NotFoundException();
    return row;
  }
}

function task(
  title: string,
  owner: { kind: 'manager' } | { kind: 'role'; role: 'admin' | 'hr' },
  dueOffsetDays: number,
) {
  return { title, owner, dueOffsetDays, mandatory: true, requiresDocument: false };
}
