import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type {
  ChangeAssignmentInput,
  ConvertEngagementInput,
  JourneyEntry,
  ChangeCompensationInput,
  CreatePersonInput,
  PersonFormOptions,
  PersonSummary,
} from '@ipro/shared';
import { AuditService, FIELD_CIPHER, SensitiveReads } from '../audit/audit.service.js';
import type { FieldCipher } from '../audit/field-cipher.js';
import { AuthzService, type Resource } from '../authz/authz.service.js';
import type { Action, DataArea } from '../authz/permissions.js';
import { addDays, businessDate, planChange } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { appUsers } from '../identity/identity.schema.js';
import { journalEvents } from '../journey/journey.schema.js';
import { JourneyService } from '../journey/journey.service.js';
import {
  departmentVersions,
  designations,
  legalEntities,
  locationVersions,
} from '../org/org.schema.js';
import { noticePeriodDays, probationEndDate } from './hr-settings.js';
import { inForce, personSummaries, type SummaryFilter } from './people.queries.js';
import {
  assignments,
  compensations,
  emergencyContacts,
  engagements,
  persons,
} from './people.schema.js';
import { SettingsService } from './settings.service.js';

const LIVE_STATUSES = ['offered', 'pre_joining', 'active', 'on_notice'] as const;

/** Where compensation ciphertext lives, so it can't be moved between rows. */
const compensationField = (id: string) => ({
  table: 'compensation',
  column: 'amount_encrypted',
  recordId: id,
});

@Injectable()
export class PeopleService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SensitiveReads) private readonly sensitive: SensitiveReads,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(JourneyService) private readonly journey: JourneyService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /**
   * Person, engagement and first assignment in one step, writing a Joined event (decision #20: HR may
   * create directly without the offer flow). Authorised as creating assignment history (decision #35).
   */
  async create(input: CreatePersonInput, now = new Date()): Promise<PersonSummary> {
    const actor = requireContext().actor!;
    const legalEntityId = input.engagement.legalEntityId;
    await this.authz.assert(actor, 'create', { area: 'assignment_history', legalEntityId });
    if (input.compensation) {
      await this.authz.assert(actor, 'create', { area: 'compensation', legalEntityId });
    }
    const { personId } = await this.db.tx((tx) => this.createIn(tx, input, now));
    return this.get(personId);
  }

  /**
   * Creates the records inside the caller's transaction; the caller has authorised it. An offer
   * (decision #54) starts as an `offered` engagement and writes its Joined event only on joining.
   */
  async createIn(
    tx: Tx,
    input: CreatePersonInput & { engagement: { contractEndDate?: string | null } },
    now: Date,
    options: { offer?: boolean } = {},
  ): Promise<{ personId: string; engagementId: string; designationTitle: string }> {
    const { actor, tenantId } = requireContext();
    const legalEntityId = input.engagement.legalEntityId;
    const today = businessDate(now);
    const by = { createdBy: actor?.userId ?? null, updatedBy: actor?.userId ?? null };
    const { designation, departmentName } = await this.checkAssignmentRefs(
      tx,
      input.assignment,
      input.engagement.joiningDate,
    );
    const probationEnd = probationEndDate(
      input.engagement.joiningDate,
      input.engagement.type,
      await this.settings.get(tx, 'probation_months'),
    );
    const notice = noticePeriodDays(
      probationEnd !== null,
      designation.designationBand,
      await this.settings.get(tx, 'notice_days'),
    );

    const [person] = await tx
      .insert(persons)
      .values({ tenantId, ...input.person, ...by })
      .returning({ id: persons.id });
    const employeeCode = await this.settings.nextEmployeeCode(tx);
    const joined = input.engagement.joiningDate <= today;
    const engagementId = randomUUID();
    await this.insertEngagement(tx, {
      id: engagementId,
      tenantId,
      personId: person!.id,
      employeeCode,
      legalEntityId,
      type: input.engagement.type,
      status: options.offer ? 'offered' : joined ? 'active' : 'pre_joining',
      workEmail: input.engagement.workEmail ?? null,
      offerDate: input.engagement.offerDate ?? null,
      joiningDate: input.engagement.joiningDate,
      contractEndDate: input.engagement.contractEndDate ?? null,
      probationEndDate: probationEnd,
      noticePeriodDays: notice,
      ...by,
    });
    const [assignment] = await tx
      .insert(assignments)
      .values({
        tenantId,
        engagementId,
        effectiveFrom: input.engagement.joiningDate,
        ...input.assignment,
        gradeId: designation.gradeId,
        changeReason: 'Joined',
        ...by,
      })
      .returning({ id: assignments.id });
    if (input.compensation) {
      await this.insertCompensation(tx, engagementId, person!.id, {
        ...input.compensation,
        effectiveFrom: input.engagement.joiningDate,
      });
    }

    if (!options.offer) {
      await this.journey.record(tx, {
        engagementId,
        personId: person!.id,
        eventType: 'joined',
        category: 'lifecycle',
        occurredOn: input.engagement.joiningDate,
        isPlanned: !joined,
        title: `Joined as ${designation.title}`,
        detail: {
          employeeCode,
          designationId: designation.id,
          departmentName,
          engagementType: input.engagement.type,
          viaOfferFlow: false,
        },
        sensitivity: 'public',
        sourceTable: 'engagement',
        sourceId: engagementId,
      });
    }
    for (const [table, recordId] of [
      ['person', person!.id],
      ['engagement', engagementId],
      ['assignment', assignment!.id],
    ] as const) {
      await this.audit.record(tx, {
        action: 'create',
        table,
        recordId,
        subjectPersonId: person!.id,
      });
    }
    if (input.engagement.workEmail) {
      await linkUsersToPerson(tx, input.engagement.workEmail, person!.id);
    }
    return { personId: person!.id, engagementId, designationTitle: designation.title };
  }

  /** People directory (H1): everyone the actor may read, as of a date. */
  async directory(filter: SummaryFilter & { asOf?: string }): Promise<PersonSummary[]> {
    const { actor } = requireContext();
    const asOf = filter.asOf ?? businessDate(new Date());
    const all = await this.db.tx((tx) => personSummaries(tx, asOf, filter));
    const visible: PersonSummary[] = [];
    for (const person of all) {
      const decision = await this.authz.check(actor!, 'read', {
        area: 'profile',
        subjectPersonId: person.personId,
        legalEntityId: person.legalEntityId,
        asOf,
      });
      if (decision.allowed) visible.push(person);
    }
    return visible;
  }

  /** Header and profile of a person record (H2, E7, M7). */
  async get(personId: string, asOf = businessDate(new Date())) {
    const [summary] = await this.db.tx((tx) =>
      personSummaries(tx, asOf, { personIds: [personId] }),
    );
    if (!summary) throw new NotFoundException();
    await this.assertOn(summary, 'profile', 'read');
    const [person, contacts] = await this.db.tx(async (tx) => [
      (await tx.select().from(persons).where(eq(persons.id, personId)))[0]!,
      await tx
        .select({
          id: emergencyContacts.id,
          name: emergencyContacts.name,
          relation: emergencyContacts.relation,
          phone: emergencyContacts.phone,
        })
        .from(emergencyContacts)
        .where(and(eq(emergencyContacts.personId, personId), isNull(emergencyContacts.deletedAt))),
    ]);
    return {
      ...summary,
      profile: {
        dateOfBirth: person.dateOfBirth,
        gender: person.gender,
        nationality: person.nationality,
        personalEmail: person.personalEmail,
        phone: person.phone,
        priorExperienceMonths: person.priorExperienceMonths,
      },
      emergencyContacts: contacts,
    };
  }

  /** Assignment history across all of the person's engagements (H2 tab). */
  async assignmentHistory(personId: string) {
    const summary = await this.summary(personId);
    await this.assertOn(summary, 'assignment_history', 'read');
    return this.db.tx(async (tx) => {
      const rows = await tx
        .select({
          assignment: assignments,
          engagement: engagements,
          designationTitle: designations.title,
        })
        .from(assignments)
        .innerJoin(engagements, eq(engagements.id, assignments.engagementId))
        .innerJoin(designations, eq(designations.id, assignments.designationId))
        .where(eq(engagements.personId, personId))
        .orderBy(asc(assignments.effectiveFrom));
      const names = await this.unitNames(tx);
      return rows.map(({ assignment: a, engagement: e, designationTitle }) => ({
        id: a.id,
        engagementId: e.id,
        employeeCode: e.employeeCode,
        engagementType: e.type,
        effectiveFrom: a.effectiveFrom,
        effectiveTo: a.effectiveTo,
        designation: { id: a.designationId, title: designationTitle },
        department: { id: a.departmentId, name: names.department(a.departmentId, a.effectiveFrom) },
        location: { id: a.locationId, name: names.location(a.locationId, a.effectiveFrom) },
        managerEngagementId: a.managerEngagementId,
        bucket: a.bucket,
        changeReason: a.changeReason,
      }));
    });
  }

  /**
   * HR changes assignment facts effective from a date (closing the row in force). Slice 5 puts the
   * in-life change approval in front of this.
   */
  /**
   * A direct change, effective from a date: for HR head, whose approval it would need anyway (decision
   * #62). HR asks through the in-life change request (H6).
   */
  async changeAssignment(personId: string, input: ChangeAssignmentInput, now = new Date()) {
    const summary = await this.summary(personId);
    await this.assertOn(summary, 'assignment_history', 'approve');
    await this.db.tx((tx) => this.changeAssignmentIn(tx, summary, input, now));
    return this.assignmentHistory(personId);
  }

  /**
   * Closes the row in force and opens the new one from the date (a future date applies by itself on
   * the day), with an audit row and a journey event that shows as upcoming until then. The caller has
   * authorised it: HR head directly, or an approved in-life change request.
   */
  async changeAssignmentIn(
    tx: Tx,
    summary: PersonSummary,
    input: ChangeAssignmentInput,
    now: Date,
  ): Promise<{ assignmentId: string; changed: string[] }> {
    const personId = summary.personId;
    const { actor, tenantId } = requireContext();
    const engagementId = input.engagementId ?? summary.engagementId;
    {
      const engagement = await this.engagementOf(tx, personId, engagementId);
      const history = await tx
        .select()
        .from(assignments)
        .where(eq(assignments.engagementId, engagement.id))
        .orderBy(asc(assignments.effectiveFrom));
      const plan = planChange(history, input.effectiveFrom);
      if (!plan.ok) throw new BadRequestException({ message: plan.problem });
      const base = history.find((row) => row.id === plan.basedOn);
      if (!base) throw new BadRequestException({ message: 'No assignment in force on that date' });
      const { engagementId: _engagementId, effectiveFrom, changeReason, ...changes } = input;
      const next = { ...pickAssignment(base), ...stripUndefined(changes) };
      const { designation } = await this.checkAssignmentRefs(tx, next, effectiveFrom);

      if (plan.close) {
        await tx
          .update(assignments)
          .set({
            effectiveTo: plan.close.effectiveTo,
            updatedAt: now,
            updatedBy: actor?.userId ?? null,
          })
          .where(eq(assignments.id, plan.close.id));
      }
      const [row] = await tx
        .insert(assignments)
        .values({
          tenantId,
          engagementId: engagement.id,
          ...plan.newRow,
          ...next,
          gradeId: designation.gradeId,
          changeReason,
          createdBy: actor?.userId ?? null,
          updatedBy: actor?.userId ?? null,
        })
        .returning({ id: assignments.id });
      const changed = Object.keys(stripUndefined(changes));
      await this.audit.record(tx, {
        action: 'create',
        table: 'assignment',
        recordId: row!.id,
        subjectPersonId: personId,
        fieldChanges: changed.map((field) => ({
          field,
          from: (pickAssignment(base) as Record<string, unknown>)[field] ?? null,
          to: (next as Record<string, unknown>)[field] ?? null,
        })),
      });
      await this.journey.record(tx, {
        engagementId: engagement.id,
        personId,
        eventType: 'assignment_changed',
        category: 'role',
        occurredOn: effectiveFrom,
        isPlanned: effectiveFrom > businessDate(now),
        title: changeReason,
        detail: { changed, designationId: next.designationId, departmentId: next.departmentId },
        sensitivity: 'public',
        sourceTable: 'assignment',
        sourceId: row!.id,
      });
      return { assignmentId: row!.id, changed };
    }
  }

  /** Compensation history. Each amount read writes an audit row (decision #16). */
  async compensationHistory(personId: string) {
    const summary = await this.summary(personId);
    await this.assertOn(summary, 'compensation', 'read');
    return this.db.tx(async (tx) => {
      const rows = await tx
        .select({ compensation: compensations, engagement: engagements })
        .from(compensations)
        .innerJoin(engagements, eq(engagements.id, compensations.engagementId))
        .where(eq(engagements.personId, personId))
        .orderBy(asc(compensations.effectiveFrom));
      const result = [];
      for (const { compensation: c, engagement: e } of rows) {
        const amount = await this.sensitive.compensation(tx, {
          ...compensationField(c.id),
          stored: c.amountEncrypted,
          subjectPersonId: personId,
        });
        result.push({
          id: c.id,
          engagementId: e.id,
          employeeCode: e.employeeCode,
          effectiveFrom: c.effectiveFrom,
          effectiveTo: c.effectiveTo,
          amount: amount.toString(),
          rateUnit: c.rateUnit,
          currency: c.currency,
        });
      }
      return result;
    });
  }

  /** New pay effective from a date. Approval above band comes with the offer and change workflows. */
  /** A direct pay change is HR head's; HR asks through a pay change request (decision #64). */
  async changeCompensation(personId: string, input: ChangeCompensationInput, now = new Date()) {
    const summary = await this.summary(personId);
    await this.assertOn(summary, 'compensation', 'approve');
    await this.db.tx((tx) => this.changeCompensationIn(tx, summary, input, now));
    return this.compensationHistory(personId);
  }

  /**
   * A new pay row from the date (the current one closes the day before), with a journey event. The
   * caller has authorised it. `title` names the event, e.g. "Became paid" for an unpaid intern.
   */
  async changeCompensationIn(
    tx: Tx,
    summary: PersonSummary,
    input: ChangeCompensationInput,
    now: Date,
    title = 'Compensation revised',
  ): Promise<string> {
    const personId = summary.personId;
    {
      const engagement = await this.engagementOf(
        tx,
        personId,
        input.engagementId ?? summary.engagementId,
      );
      const id = await this.insertCompensation(tx, engagement.id, personId, input);
      await this.journey.record(tx, {
        engagementId: engagement.id,
        personId,
        eventType: 'compensation_changed',
        category: 'pay',
        occurredOn: input.effectiveFrom,
        isPlanned: input.effectiveFrom > businessDate(now),
        title,
        sensitivity: 'hr',
        sourceTable: 'compensation',
        sourceId: id,
      });
      return id;
    }
  }

  async addEmergencyContact(
    personId: string,
    input: { name: string; relation: string; phone: string },
  ) {
    const summary = await this.summary(personId);
    await this.assertProfileUpdate(summary);
    const { actor, tenantId } = requireContext();
    await this.db.tx(async (tx) => {
      const [row] = await tx
        .insert(emergencyContacts)
        .values({
          tenantId,
          personId,
          ...input,
          createdBy: actor?.userId ?? null,
          updatedBy: actor?.userId ?? null,
        })
        .returning({ id: emergencyContacts.id });
      await this.audit.record(tx, {
        action: 'create',
        table: 'emergency_contact',
        recordId: row!.id,
        subjectPersonId: personId,
      });
    });
    return this.get(personId);
  }

  async removeEmergencyContact(personId: string, contactId: string) {
    const summary = await this.summary(personId);
    await this.assertProfileUpdate(summary);
    const { actor } = requireContext();
    await this.db.tx(async (tx) => {
      const now = new Date();
      const updated = await tx
        .update(emergencyContacts)
        .set({
          deletedAt: now,
          deletedBy: actor?.userId ?? null,
          updatedAt: now,
          updatedBy: actor?.userId ?? null,
        })
        .where(
          and(
            eq(emergencyContacts.id, contactId),
            eq(emergencyContacts.personId, personId),
            isNull(emergencyContacts.deletedAt),
          ),
        )
        .returning({ id: emergencyContacts.id });
      if (updated.length === 0) throw new NotFoundException();
      await this.audit.record(tx, {
        action: 'delete',
        table: 'emergency_contact',
        recordId: contactId,
        subjectPersonId: personId,
      });
    });
    return this.get(personId);
  }

  /**
   * Retainer (or consultant) to payroll: the same person and employee code continue on a new
   * engagement (decision #19). The old engagement, assignment and pay close the day before; the person
   * keeps one record and one journey. Effective today or earlier (decision #41).
   */
  async convert(personId: string, input: ConvertEngagementInput, now = new Date()) {
    const summary = await this.summary(personId);
    // A direct conversion is HR head's; HR asks through a conversion request (decision #64).
    await this.assertOn(summary, 'assignment_history', 'approve');
    if (input.compensation) await this.assertOn(summary, 'compensation', 'create');
    await this.db.tx((tx) => this.convertIn(tx, summary, input, now));
    return this.get(personId);
  }

  /** The conversion in the caller's transaction; the caller has authorised it. */
  async convertIn(
    tx: Tx,
    summary: PersonSummary,
    input: ConvertEngagementInput,
    now: Date,
  ): Promise<void> {
    const personId = summary.personId;
    const today = businessDate(now);
    if (input.effectiveFrom > today) {
      throw new BadRequestException({
        message: 'Future-dated conversions come with the in-life change workflow',
      });
    }
    const { actor, tenantId } = requireContext();
    const by = { createdBy: actor?.userId ?? null, updatedBy: actor?.userId ?? null };

    {
      const old = await this.engagementOf(tx, personId, summary.engagementId);
      // Retainers and consultants move to payroll; interns and trainees become employees (decision #64).
      if (
        !['retainer', 'consultant', 'intern', 'trainee'].includes(old.type) ||
        !['active', 'on_notice'].includes(old.status)
      ) {
        throw new BadRequestException({
          message: 'Only a current retainer, consultant, intern or trainee engagement converts',
        });
      }
      const exitReason = ['retainer', 'consultant'].includes(old.type)
        ? 'converted_to_payroll'
        : 'converted_to_employee';
      if (input.effectiveFrom <= old.joiningDate) {
        throw new BadRequestException({ message: 'Conversion must be after the joining date' });
      }
      const [current] = await tx
        .select()
        .from(assignments)
        .where(
          and(
            eq(assignments.engagementId, old.id),
            inForce(assignments.effectiveFrom, assignments.effectiveTo, input.effectiveFrom),
          ),
        );
      if (!current)
        throw new BadRequestException({ message: 'No assignment in force on that date' });
      const next = { ...pickAssignment(current), ...stripUndefined(input.assignment ?? {}) };
      const { designation } = await this.checkAssignmentRefs(tx, next, input.effectiveFrom);
      const dayBefore = addDays(input.effectiveFrom, -1);

      // Close the old engagement's dated rows the day before; nothing may be planned after it.
      for (const table of [assignments, compensations] as const) {
        const later = await tx
          .select({ id: table.id })
          .from(table)
          .where(and(eq(table.engagementId, old.id), gt(table.effectiveFrom, dayBefore)));
        if (later.length > 0) {
          throw new BadRequestException({
            message: 'Changes are planned after the conversion date',
          });
        }
        await tx
          .update(table)
          .set({ effectiveTo: dayBefore, updatedAt: now, updatedBy: actor?.userId ?? null })
          .where(
            and(
              eq(table.engagementId, old.id),
              inForce(table.effectiveFrom, table.effectiveTo, dayBefore),
            ),
          );
      }
      await tx
        .update(engagements)
        .set({
          status: 'exited',
          lastWorkingDate: dayBefore,
          exitReason,
          updatedAt: now,
          updatedBy: actor?.userId ?? null,
        })
        .where(eq(engagements.id, old.id));

      // HR and CXO decide per conversion whether probation applies (decision #42).
      const probationEnd =
        input.probation === 'policy'
          ? probationEndDate(
              input.effectiveFrom,
              input.type,
              await this.settings.get(tx, 'probation_months'),
            )
          : null;
      const engagementId = randomUUID();
      await this.insertEngagement(tx, {
        id: engagementId,
        tenantId,
        personId,
        employeeCode: old.employeeCode,
        legalEntityId: old.legalEntityId,
        type: input.type,
        status: 'active',
        workEmail: old.workEmail,
        joiningDate: input.effectiveFrom,
        probationEndDate: probationEnd,
        noticePeriodDays: noticePeriodDays(
          probationEnd !== null,
          designation.designationBand,
          await this.settings.get(tx, 'notice_days'),
        ),
        previousEngagementId: old.id,
        ...by,
      });
      const [assignment] = await tx
        .insert(assignments)
        .values({
          tenantId,
          engagementId,
          effectiveFrom: input.effectiveFrom,
          ...next,
          gradeId: designation.gradeId,
          changeReason:
            exitReason === 'converted_to_payroll'
              ? 'Converted to payroll'
              : 'Converted to employee',
          ...by,
        })
        .returning({ id: assignments.id });
      if (input.compensation) {
        await this.insertCompensation(tx, engagementId, personId, {
          ...input.compensation,
          effectiveFrom: input.effectiveFrom,
        });
      }

      await this.journey.record(tx, {
        engagementId,
        personId,
        eventType: 'converted',
        category: 'lifecycle',
        occurredOn: input.effectiveFrom,
        title: `Converted from ${old.type} to ${input.type}`,
        detail: {
          fromEngagementId: old.id,
          fromType: old.type,
          toType: input.type,
          employeeCode: old.employeeCode,
          probation: input.probation,
        },
        sensitivity: 'public',
        sourceTable: 'engagement',
        sourceId: engagementId,
      });
      await this.audit.record(tx, {
        action: 'update',
        table: 'engagement',
        recordId: old.id,
        subjectPersonId: personId,
        fieldChanges: [
          { field: 'status', from: old.status, to: 'exited' },
          { field: 'exit_reason', from: old.exitReason, to: exitReason },
        ],
      });
      for (const [table, recordId] of [
        ['engagement', engagementId],
        ['assignment', assignment!.id],
      ] as const) {
        await this.audit.record(tx, {
          action: 'create',
          table,
          recordId,
          subjectPersonId: personId,
        });
      }
    }
  }

  /**
   * The person's journey across all engagements (timelines are per person, decision #19). Compensation
   * and exit-reason events need journey_sensitive; the full timeline screens come with slice 10.
   */
  async journeyOf(personId: string, now = new Date()): Promise<JourneyEntry[]> {
    const today = businessDate(now);
    const summary = await this.summary(personId);
    await this.assertOn(summary, 'journey_public', 'read');
    const sensitive = (
      await this.authz.check(requireContext().actor!, 'read', {
        area: 'journey_sensitive',
        subjectPersonId: personId,
        legalEntityId: summary.legalEntityId,
      })
    ).allowed;
    const rows = await this.db.tx((tx) =>
      tx
        .select({ event: journalEvents, employeeCode: engagements.employeeCode })
        .from(journalEvents)
        .innerJoin(engagements, eq(engagements.id, journalEvents.engagementId))
        .where(eq(journalEvents.personId, personId))
        .orderBy(asc(journalEvents.occurredOn), asc(journalEvents.createdAt)),
    );
    return (
      rows
        .filter(
          ({ event }) =>
            sensitive || event.sensitivity === 'public' || event.sensitivity === 'manager',
        )
        // A scheduled conversion shows while it is ahead; on the day the conversion writes its own event.
        .filter(
          ({ event }) => event.eventType !== 'conversion_scheduled' || event.occurredOn > today,
        )
        .map(({ event, employeeCode }) => ({
          id: event.id,
          engagementId: event.engagementId,
          employeeCode,
          eventType: event.eventType,
          category: event.category,
          occurredOn: event.occurredOn,
          isPlanned: event.isPlanned,
          upcoming: event.occurredOn > today,
          title: event.title,
          sensitivity: event.sensitivity,
          migrated: event.migrated,
        }))
    );
  }

  /** Options for the new-person form (H2 "new person"), current as of today. */
  async formOptions(): Promise<PersonFormOptions> {
    await this.authz.assert(requireContext().actor!, 'create', { area: 'assignment_history' });
    const today = businessDate(new Date());
    return this.db.tx(async (tx) => {
      const [entities, titles, departments, locations, buckets, people] = await Promise.all([
        tx
          .select({ id: legalEntities.id, name: legalEntities.name })
          .from(legalEntities)
          .where(isNull(legalEntities.deletedAt))
          .orderBy(asc(legalEntities.name)),
        tx
          .select({ id: designations.id, title: designations.title, gradeId: designations.gradeId })
          .from(designations)
          .where(isNull(designations.deletedAt))
          .orderBy(asc(designations.title)),
        tx
          .select({ id: departmentVersions.departmentId, name: departmentVersions.name })
          .from(departmentVersions)
          .where(inForce(departmentVersions.effectiveFrom, departmentVersions.effectiveTo, today))
          .orderBy(asc(departmentVersions.name)),
        tx
          .select({ id: locationVersions.locationId, name: locationVersions.name })
          .from(locationVersions)
          .where(inForce(locationVersions.effectiveFrom, locationVersions.effectiveTo, today))
          .orderBy(asc(locationVersions.name)),
        this.settings.get(tx, 'buckets'),
        personSummaries(tx, today),
      ]);
      return {
        legalEntities: entities,
        designations: titles,
        departments,
        locations,
        buckets,
        managers: people
          .filter((p) => p.status === 'active' || p.status === 'on_notice')
          .map((p) => ({
            engagementId: p.engagementId,
            name: p.preferredName ?? p.legalName,
            employeeCode: p.employeeCode,
          })),
      };
    });
  }

  /** The summary authz decisions are made on (legal entity of the live or latest engagement). */
  /** As of today; someone not yet joined is shown with their planned first assignment. */
  async summary(personId: string): Promise<PersonSummary> {
    const today = businessDate(new Date());
    let [summary] = await this.db.tx((tx) => personSummaries(tx, today, { personIds: [personId] }));
    if (!summary) throw new NotFoundException();
    if (!summary.designation && summary.joiningDate > today) {
      [summary] = await this.db.tx((tx) =>
        personSummaries(tx, summary!.joiningDate, { personIds: [personId] }),
      );
    }
    return summary!;
  }

  private assertOn(summary: PersonSummary, area: DataArea, action: Action) {
    const resource: Resource = {
      area,
      subjectPersonId: summary.personId,
      legalEntityId: summary.legalEntityId,
    };
    return this.authz.assert(requireContext().actor!, action, resource);
  }

  /** Employees change their own profile through a change request, which arrives with slice 3. */
  private async assertProfileUpdate(summary: PersonSummary) {
    const obligations = await this.assertOn(summary, 'profile', 'update');
    if (obligations.has('via_change_request')) {
      throw new ConflictException({
        message: 'Profile changes need a change request (coming soon)',
      });
    }
  }

  private async insertEngagement(tx: Tx, values: typeof engagements.$inferInsert) {
    try {
      await tx.insert(engagements).values(values);
    } catch (error) {
      if (String((error as Error).cause ?? error).includes('engagement_work_email_live_key')) {
        throw new ConflictException({
          message: 'Work email is already used by a current engagement',
        });
      }
      throw error;
    }
  }

  private async insertCompensation(
    tx: Tx,
    engagementId: string,
    personId: string,
    input: {
      amount: string;
      rateUnit: ChangeCompensationInput['rateUnit'];
      currency?: string;
      effectiveFrom: string;
    },
  ): Promise<string> {
    const { actor, tenantId } = requireContext();
    const history = await tx
      .select()
      .from(compensations)
      .where(eq(compensations.engagementId, engagementId));
    const plan = planChange(history, input.effectiveFrom);
    if (!plan.ok) throw new BadRequestException({ message: plan.problem });
    if (plan.close) {
      await tx
        .update(compensations)
        .set({
          effectiveTo: plan.close.effectiveTo,
          updatedAt: new Date(),
          updatedBy: actor?.userId ?? null,
        })
        .where(eq(compensations.id, plan.close.id));
    }
    const id = randomUUID();
    await tx.insert(compensations).values({
      id,
      tenantId,
      engagementId,
      ...plan.newRow,
      amountEncrypted: await this.cipher.encrypt(tenantId, input.amount, compensationField(id)),
      rateUnit: input.rateUnit,
      currency: input.currency ?? 'INR',
      createdBy: actor?.userId ?? null,
      updatedBy: actor?.userId ?? null,
    });
    await this.audit.record(tx, {
      action: 'create',
      table: 'compensation',
      recordId: id,
      subjectPersonId: personId,
      fieldChanges: [{ field: 'amount_encrypted', sensitive: true }],
    });
    return id;
  }

  private async engagementOf(tx: Tx, personId: string, engagementId: string) {
    const [engagement] = await tx
      .select()
      .from(engagements)
      .where(and(eq(engagements.id, engagementId), eq(engagements.personId, personId)));
    if (!engagement) throw new NotFoundException();
    return engagement;
  }

  /** The designation, department, location and manager must exist and be in force on the date. */
  private async checkAssignmentRefs(
    tx: Tx,
    a: {
      designationId: string;
      departmentId: string;
      locationId: string;
      managerEngagementId?: string | null;
      bucket: string;
    },
    onDate: string,
  ) {
    const [designation] = await tx
      .select()
      .from(designations)
      .where(and(eq(designations.id, a.designationId), isNull(designations.deletedAt)));
    if (!designation) throw new BadRequestException({ message: 'Unknown designation' });
    const [department] = await tx
      .select({ name: departmentVersions.name })
      .from(departmentVersions)
      .where(
        and(
          eq(departmentVersions.departmentId, a.departmentId),
          inForce(departmentVersions.effectiveFrom, departmentVersions.effectiveTo, onDate),
        ),
      );
    if (!department)
      throw new BadRequestException({ message: 'Department is not in force on that date' });
    const [location] = await tx
      .select({ id: locationVersions.id })
      .from(locationVersions)
      .where(
        and(
          eq(locationVersions.locationId, a.locationId),
          inForce(locationVersions.effectiveFrom, locationVersions.effectiveTo, onDate),
        ),
      );
    if (!location)
      throw new BadRequestException({ message: 'Location is not in force on that date' });
    if (a.managerEngagementId) {
      const [manager] = await tx
        .select({ id: engagements.id })
        .from(engagements)
        .where(
          and(
            eq(engagements.id, a.managerEngagementId),
            inArray(engagements.status, [...LIVE_STATUSES]),
          ),
        );
      if (!manager) throw new BadRequestException({ message: 'Manager has no current engagement' });
    }
    const buckets = await this.settings.get(tx, 'buckets');
    if (!buckets.includes(a.bucket)) throw new BadRequestException({ message: 'Unknown bucket' });
    return { designation, departmentName: department.name };
  }

  /** Department and location names as of a date, for history rows. */
  private async unitNames(tx: Tx) {
    const [departmentRows, locationRows] = await Promise.all([
      tx.select().from(departmentVersions),
      tx.select().from(locationVersions),
    ]);
    const nameAt = (
      rows: { effectiveFrom: string; effectiveTo: string | null; name: string }[],
      date: string,
    ) =>
      rows.find((r) => r.effectiveFrom <= date && (r.effectiveTo === null || date <= r.effectiveTo))
        ?.name ?? '';
    return {
      department: (id: string, date: string) =>
        nameAt(
          departmentRows.filter((r) => r.departmentId === id),
          date,
        ),
      location: (id: string, date: string) =>
        nameAt(
          locationRows.filter((r) => r.locationId === id),
          date,
        ),
    };
  }
}

const assignmentFields = [
  'designationId',
  'departmentId',
  'locationId',
  'costCentreId',
  'managerEngagementId',
  'dottedManagerEngagementId',
  'bucket',
  'positionId',
  'workPolicyId',
] as const;

function pickAssignment(row: typeof assignments.$inferSelect) {
  return Object.fromEntries(assignmentFields.map((f) => [f, row[f]])) as Pick<
    typeof assignments.$inferSelect,
    (typeof assignmentFields)[number]
  >;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Links sign-in users whose email matches a current engagement's work email (decision #34). */
export async function linkUsersToPerson(
  tx: Tx,
  workEmail: string,
  personId: string,
): Promise<void> {
  await tx
    .update(appUsers)
    .set({ personId, updatedAt: new Date() })
    .where(and(sql`lower(${appUsers.email}) = lower(${workEmail})`, isNull(appUsers.personId)));
}
