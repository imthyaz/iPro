import { BadRequestException, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  inLifeChangeSchema,
  type ChangeLine,
  type InLifeChangeInput,
  type PersonSummary,
} from '@ipro/shared';
import { z } from 'zod';
import { AuthzService } from '../authz/authz.service.js';
import { businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { letterTemplates } from '../letters/letters.schema.js';
import { LettersService } from '../letters/letters.service.js';
import { designations } from '../org/org.schema.js';
import { personSummaries } from '../people/people.queries.js';
import { PeopleService } from '../people/people.service.js';
import { WorkflowActions, type ActionInstance } from '../workflow/actions.js';
import { notify, roleHolders, userOfPerson } from '../workflow/lookups.js';
import { WorkflowService } from '../workflow/workflow.service.js';

/** What the approval carries: the change, for the engagement it was asked about. */
const payloadSchema = z.intersection(inLifeChangeSchema, z.object({ engagementId: z.uuid() }));
type Payload = z.infer<typeof payloadSchema>;

/** Thrown to roll back a trial run of the change (checking it can apply before asking for approval). */
class TrialRun extends Error {}

/**
 * In-life changes (spec workflow 8; decision #62): HR asks for a change of designation, department,
 * location, manager or bucket from a date; HR head approves; the dated assignment opens (a future one
 * applies by itself on the day and shows as upcoming on the journey), with a letter if one was asked
 * for. Pay changes and conversions come with slice 5c.
 */
@Injectable()
export class ChangesService implements OnModuleInit {
  private readonly logger = new Logger('Changes');

  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(LettersService) private readonly letters: LettersService,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(WorkflowActions) private readonly actions: WorkflowActions,
  ) {}

  onModuleInit(): void {
    this.actions.register('change.apply', {
      validate: (payload) => {
        const parsed = payloadSchema.safeParse(payload);
        if (!parsed.success) throw new BadRequestException({ message: 'Invalid change' });
        return parsed.data;
      },
      describe: (tx, instance) => this.describe(tx, payloadSchema.parse(instance.payload)),
      apply: (tx, instance) => this.apply(tx, instance),
    });
  }

  /** H6: checks the change can apply, then sends it to HR head. */
  async request(personId: string, input: InLifeChangeInput, now = new Date()) {
    const summary = await this.people.summary(personId);
    await this.authz.assert(requireContext().actor!, 'update', {
      area: 'assignment_history',
      subjectPersonId: personId,
      legalEntityId: summary.legalEntityId,
    });
    // A trial run inside a transaction that is always rolled back: bad dates, units or overlaps
    // are refused now, not when HR head approves.
    try {
      await this.db.tx(async (tx) => {
        await this.people.changeAssignmentIn(tx, summary, this.assignmentInput(input), now);
        throw new TrialRun();
      });
    } catch (error) {
      if (!(error instanceof TrialRun)) throw error;
    }
    // HR head is the approver: their own change applies at once rather than waiting on themselves.
    const approver = await this.authz.check(requireContext().actor!, 'approve', {
      area: 'assignment_history',
      subjectPersonId: personId,
      legalEntityId: summary.legalEntityId,
    });
    const payload = { ...input, engagementId: summary.engagementId };
    if (approver.allowed) {
      await this.db.tx(async (tx) => {
        await this.checkTemplate(tx, input.letterTemplateKey);
        await this.apply(tx, {
          id: 'direct',
          subjectPersonId: personId,
          submittedBy: requireContext().actor!.userId,
          payload,
        });
      });
      return { applied: true as const };
    }
    const requestId = await this.db.tx(async (tx) => {
      await this.checkTemplate(tx, input.letterTemplateKey);
      return this.workflows.submit(tx, {
        key: 'inlife_change',
        subjectPersonId: personId,
        title: `Change: ${summary.preferredName ?? summary.legalName}, ${input.reason}`,
        payload,
      });
    });
    return { requestId };
  }

  private async checkTemplate(tx: Tx, key: string | undefined): Promise<void> {
    if (!key) return;
    const [template] = await tx
      .select({ id: letterTemplates.id })
      .from(letterTemplates)
      .where(and(eq(letterTemplates.key, key), eq(letterTemplates.active, true)));
    if (!template) throw new BadRequestException({ message: `No letter template "${key}"` });
  }

  private assignmentInput(change: InLifeChangeInput) {
    return {
      effectiveFrom: change.effectiveFrom,
      changeReason: change.reason,
      ...(change.designationId !== undefined ? { designationId: change.designationId } : {}),
      ...(change.departmentId !== undefined ? { departmentId: change.departmentId } : {}),
      ...(change.locationId !== undefined ? { locationId: change.locationId } : {}),
      ...(change.managerEngagementId !== undefined
        ? { managerEngagementId: change.managerEngagementId }
        : {}),
      ...(change.bucket !== undefined ? { bucket: change.bucket } : {}),
    };
  }

  /** Each changed field as it is now and as it will be from the date, so HR head decides on the card. */
  private async describe(tx: Tx, change: Payload): Promise<ChangeLine[]> {
    const personId = await this.personOf(tx, change.engagementId);
    if (!personId) return [];
    const [before] = await personSummaries(tx, businessDate(new Date()), { personIds: [personId] });
    const lines: ChangeLine[] = [];
    const add = (label: string, from: string | null | undefined, to: string | null | undefined) =>
      lines.push({ label, from: from ?? null, to: to ?? null });
    if (change.designationId) {
      const [designation] = await tx
        .select({ title: designations.title })
        .from(designations)
        .where(eq(designations.id, change.designationId));
      add('Designation', before?.designation?.title, designation?.title);
    }
    // The new values come from the request itself: nothing has changed yet.
    const unitName = async (kind: 'department' | 'location', id: string) => {
      const rows = await tx.execute<{ name: string }>(
        kind === 'department'
          ? sqlUnit('department_version', 'department_id', id, change.effectiveFrom)
          : sqlUnit('location_version', 'location_id', id, change.effectiveFrom),
      );
      return rows.rows[0]?.name ?? null;
    };
    if (change.departmentId) {
      add(
        'Department',
        before?.department?.name,
        await unitName('department', change.departmentId),
      );
    }
    if (change.locationId) {
      add('Location', before?.location?.name, await unitName('location', change.locationId));
    }
    if (change.managerEngagementId !== undefined) {
      const manager = change.managerEngagementId
        ? await tx.execute<{ name: string }>(sqlManager(change.managerEngagementId))
        : null;
      add('Reports to', before?.manager?.name, manager?.rows[0]?.name ?? 'No manager');
    }
    if (change.bucket) add('Bucket', before?.bucket, change.bucket);
    add('From', null, change.effectiveFrom);
    add('Reason', null, change.reason);
    if (change.letterTemplateKey) add('Letter', null, change.letterTemplateKey);
    return lines;
  }

  /** On approval: the dated assignment opens, the person is told, and the letter is made. */
  private async apply(tx: Tx, instance: ActionInstance): Promise<void> {
    const change = payloadSchema.parse(instance.payload);
    const summary = await this.people.summary(instance.subjectPersonId);
    await this.people.changeAssignmentIn(tx, summary, this.assignmentInput(change), new Date());
    const employee = await userOfPerson(tx, instance.subjectPersonId);
    if (employee) {
      await notify(
        tx,
        [employee],
        'role_change',
        `Your role changes from ${change.effectiveFrom}: ${change.reason}`,
        '/me',
      );
    }
    if (change.letterTemplateKey) await this.letter(tx, summary, change);
  }

  /** A letter that can't be made never undoes the approved change: HR is told instead. */
  private async letter(tx: Tx, summary: PersonSummary, change: Payload): Promise<void> {
    try {
      const letterId = await this.letters.generateIn(tx, summary, {
        templateKey: change.letterTemplateKey!,
        extra: change.extra ?? {},
        approval: false,
        asOf: change.effectiveFrom,
      });
      const [template] = await tx
        .select({ signature: letterTemplates.signature })
        .from(letterTemplates)
        .where(
          and(eq(letterTemplates.key, change.letterTemplateKey!), eq(letterTemplates.active, true)),
        );
      if (template?.signature === 'employee') await this.letters.sendIn(tx, letterId);
    } catch (error) {
      this.logger.warn(
        `Change letter not made for ${summary.personId}: ${(error as Error).message}`,
      );
      await notify(
        tx,
        await roleHolders(tx, 'hr', summary.legalEntityId),
        'letter_needed',
        `Couldn’t make the letter for ${summary.preferredName ?? summary.legalName}’s change; make it from their record`,
        `/people/${summary.personId}`,
      );
    }
  }

  private async personOf(tx: Tx, engagementId: string): Promise<string | null> {
    const rows = await tx.execute<{ person_id: string }>(sqlPerson(engagementId));
    return rows.rows[0]?.person_id ?? null;
  }
}

const sqlUnit = (table: string, column: string, id: string, day: string) =>
  sql`select name from ${sql.identifier(table)}
      where ${sql.identifier(column)} = ${id}
        and effective_from <= ${day} and (effective_to is null or effective_to >= ${day})`;
const sqlManager = (engagementId: string) =>
  sql`select coalesce(p.preferred_name, p.legal_name) as name
      from engagement e join person p on p.id = e.person_id where e.id = ${engagementId}`;
const sqlPerson = (engagementId: string) =>
  sql`select person_id from engagement where id = ${engagementId}`;
