import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, asc, eq, lte } from 'drizzle-orm';
import {
  conversionRequestSchema,
  type ChangeLine,
  type ChangeRequestResult,
  type ConversionRequestInput,
  type ConvertEngagementInput,
  type PayChangeInput,
  type PersonSummary,
} from '@ipro/shared';
import { z } from 'zod';
import { AuthzService } from '../authz/authz.service.js';
import type { DataArea, Action } from '../authz/permissions.js';
import { FIELD_CIPHER, SensitiveReads } from '../audit/audit.service.js';
import type { FieldCipher } from '../audit/field-cipher.js';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { JourneyService } from '../journey/journey.service.js';
import { letterTemplates } from '../letters/letters.schema.js';
import { LettersService } from '../letters/letters.service.js';
import { checkBand } from '../offers/offers.service.js';
import { designations, grades } from '../org/org.schema.js';
import { inForce } from '../people/people.queries.js';
import { assignments, compensations } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { WorkflowActions } from '../workflow/actions.js';
import { notify, roleHolders, userOfPerson } from '../workflow/lookups.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { scheduledChanges } from './changes.schema.js';

/** Pay inside a request: encrypted under its own reference, read only through audited reads. */
const sealedPay = z.object({
  payRef: z.uuid(),
  amountEncrypted: z.string().min(1),
  rateUnit: z.enum(['year', 'month', 'day', 'hour']),
});
type SealedPay = z.infer<typeof sealedPay>;

const payPayload = z.object({
  engagementId: z.uuid(),
  effectiveFrom: z.iso.date(),
  reason: z.string(),
  pay: sealedPay,
  bandCheck: z.enum(['within', 'above', 'no_band', 'not_comparable']),
  letterTemplateKey: z.string().optional(),
  extra: z.record(z.string(), z.string()).optional(),
});
type PayPayload = z.infer<typeof payPayload>;

const conversionPayload = conversionRequestSchema
  .omit({ compensation: true })
  .extend({ engagementId: z.uuid(), pay: sealedPay.optional() });
type ConversionPayload = z.infer<typeof conversionPayload>;

const rateWords: Record<string, string> = {
  year: 'a year',
  month: 'a month',
  day: 'a day',
  hour: 'an hour',
};
const rupees = (paise: bigint) =>
  `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(Number(paise) / 100)}`;
const bandWords = {
  within: 'Within the grade band',
  above: 'Above the grade band',
  no_band: 'No band to check',
  not_comparable: 'Day or hour rate: not comparable with the band',
} as const;

class TrialRun extends Error {}

/**
 * Pay changes and conversions (decision #64). Both need HR head; a conversion also needs CXO
 * (decision #42). The requested pay is encrypted in the request and read only through audited reads.
 * A conversion dated in the future waits in `scheduled_change` and applies on the day.
 */
@Injectable()
export class PayConversionsService implements OnModuleInit {
  private readonly logger = new Logger('PayConversions');

  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(SensitiveReads) private readonly sensitive: SensitiveReads,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(JourneyService) private readonly journey: JourneyService,
    @Inject(LettersService) private readonly letters: LettersService,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(WorkflowActions) private readonly actions: WorkflowActions,
  ) {}

  onModuleInit(): void {
    this.actions.register('pay.apply', {
      validate: (payload) => this.parse(payPayload, payload),
      describe: (tx, instance) =>
        this.describePay(tx, payPayload.parse(instance.payload), instance.subjectPersonId),
      apply: (tx, instance) =>
        this.applyPay(tx, payPayload.parse(instance.payload), instance.subjectPersonId),
    });
    this.actions.register('conversion.apply', {
      validate: (payload) => this.parse(conversionPayload, payload),
      describe: (tx, instance) =>
        this.describeConversion(
          tx,
          conversionPayload.parse(instance.payload),
          instance.subjectPersonId,
        ),
      apply: (tx, instance) =>
        this.approveConversion(
          tx,
          conversionPayload.parse(instance.payload),
          instance.subjectPersonId,
          instance.id,
        ),
    });
  }

  // ---- Pay changes ----

  async requestPay(
    personId: string,
    input: PayChangeInput,
    now = new Date(),
  ): Promise<ChangeRequestResult> {
    const summary = await this.people.summary(personId);
    await this.assert(summary, 'compensation', 'update');
    await this.trial((tx) =>
      this.people.changeCompensationIn(
        tx,
        summary,
        { amount: input.amount, rateUnit: input.rateUnit, effectiveFrom: input.effectiveFrom },
        now,
      ),
    );
    const payload: PayPayload = await this.db.tx(async (tx) => ({
      engagementId: summary.engagementId,
      effectiveFrom: input.effectiveFrom,
      reason: input.reason,
      pay: await this.seal(input.amount, input.rateUnit),
      bandCheck: checkBand(
        input,
        await this.bandMax(tx, summary.engagementId, input.effectiveFrom),
      ),
      ...(input.letterTemplateKey ? { letterTemplateKey: input.letterTemplateKey } : {}),
      ...(input.extra ? { extra: input.extra } : {}),
    }));
    // HR head is the approver: their own change applies at once.
    if (await this.can(summary, 'compensation', 'approve')) {
      await this.db.tx(async (tx) => {
        await this.checkTemplate(tx, input.letterTemplateKey);
        await this.applyPay(tx, payload, personId);
      });
      return { applied: true };
    }
    const requestId = await this.db.tx(async (tx) => {
      await this.checkTemplate(tx, input.letterTemplateKey);
      return this.workflows.submit(tx, {
        key: 'pay_change',
        subjectPersonId: personId,
        title: `Pay change: ${summary.preferredName ?? summary.legalName}, ${input.reason}`,
        payload,
      });
    });
    return { requestId };
  }

  private async describePay(tx: Tx, change: PayPayload, personId: string): Promise<ChangeLine[]> {
    const now = await this.currentPay(tx, change.engagementId, personId, change.effectiveFrom);
    const next = await this.open(tx, change.pay, personId);
    return [
      { label: 'Pay', from: now, to: `${rupees(next)} ${rateWords[change.pay.rateUnit]}` },
      { label: 'Against the band', from: null, to: bandWords[change.bandCheck] },
      { label: 'From', from: null, to: change.effectiveFrom },
      { label: 'Reason', from: null, to: change.reason },
    ];
  }

  private async applyPay(tx: Tx, change: PayPayload, personId: string): Promise<void> {
    const summary = await this.people.summary(personId);
    const amount = await this.open(tx, change.pay, personId);
    const [paidBefore] = await tx
      .select({ id: compensations.id })
      .from(compensations)
      .where(eq(compensations.engagementId, change.engagementId))
      .limit(1);
    await this.people.changeCompensationIn(
      tx,
      summary,
      {
        amount: amount.toString(),
        rateUnit: change.pay.rateUnit,
        effectiveFrom: change.effectiveFrom,
      },
      new Date(),
      paidBefore ? 'Compensation revised' : 'Became paid',
    );
    const employee = await userOfPerson(tx, personId);
    if (employee) {
      await notify(
        tx,
        [employee],
        'pay_change',
        `Your pay changes from ${change.effectiveFrom}`,
        '/me',
      );
    }
    if (change.letterTemplateKey) {
      await this.letter(
        tx,
        summary,
        change.letterTemplateKey,
        change.extra ?? {},
        change.effectiveFrom,
      );
    }
  }

  // ---- Conversions ----

  async requestConversion(
    personId: string,
    input: ConversionRequestInput,
  ): Promise<ChangeRequestResult> {
    const summary = await this.people.summary(personId);
    await this.assert(summary, 'assignment_history', 'update');
    if (input.compensation) await this.assert(summary, 'compensation', 'update');
    // Checked as on its date, so a future conversion is refused now rather than on the day.
    await this.trial((tx) =>
      this.people.convertIn(tx, summary, input, new Date(`${input.effectiveFrom}T12:00:00+05:30`)),
    );
    const { compensation, ...rest } = input;
    const payload: ConversionPayload = {
      ...rest,
      engagementId: summary.engagementId,
      ...(compensation ? { pay: await this.seal(compensation.amount, compensation.rateUnit) } : {}),
    };
    const requestId = await this.db.tx((tx) =>
      this.workflows.submit(tx, {
        key: 'conversion',
        subjectPersonId: personId,
        title: `Conversion: ${summary.preferredName ?? summary.legalName} to ${input.type.replace('_', '-')}`,
        payload,
      }),
    );
    return { requestId };
  }

  private async describeConversion(
    tx: Tx,
    change: ConversionPayload,
    personId: string,
  ): Promise<ChangeLine[]> {
    const summary = await this.people.summary(personId);
    const lines: ChangeLine[] = [
      {
        label: 'Engagement',
        from: summary.engagementType.replace('_', '-'),
        to: change.type.replace('_', '-'),
      },
      {
        label: 'Probation',
        from: null,
        to: change.probation === 'policy' ? 'Serves probation (policy length)' : 'No probation',
      },
      { label: 'From', from: null, to: change.effectiveFrom },
      { label: 'Reason', from: null, to: change.reason },
    ];
    if (change.assignment?.designationId) {
      const [designation] = await tx
        .select({ title: designations.title })
        .from(designations)
        .where(eq(designations.id, change.assignment.designationId));
      lines.splice(1, 0, {
        label: 'Designation',
        from: summary.designation?.title ?? null,
        to: designation?.title ?? null,
      });
    }
    if (change.pay) {
      const amount = await this.open(tx, change.pay, personId);
      lines.push({
        label: 'Pay',
        from: await this.currentPay(tx, change.engagementId, personId, change.effectiveFrom),
        to: `${rupees(amount)} ${rateWords[change.pay.rateUnit]}`,
      });
    }
    return lines;
  }

  /** Final approval: today or earlier applies now; a later date waits for the day. */
  private async approveConversion(
    tx: Tx,
    change: ConversionPayload,
    personId: string,
    requestId: string,
  ): Promise<void> {
    const today = businessDate(new Date());
    if (change.effectiveFrom <= today) {
      await this.convert(tx, change, personId, new Date());
      return;
    }
    const [row] = await tx
      .insert(scheduledChanges)
      .values({
        tenantId: requireContext().tenantId,
        kind: 'conversion',
        personId,
        requestId,
        payload: change,
        runOn: change.effectiveFrom,
        status: 'pending',
      })
      .returning({ id: scheduledChanges.id });
    const summary = await this.people.summary(personId);
    // Shown as upcoming until the day; the conversion itself then writes its own event.
    await this.journey.record(tx, {
      engagementId: summary.engagementId,
      personId,
      eventType: 'conversion_scheduled',
      category: 'lifecycle',
      occurredOn: change.effectiveFrom,
      isPlanned: true,
      title: `Converts to ${change.type.replace('_', '-')}`,
      detail: { requestId },
      sensitivity: 'public',
      sourceTable: 'scheduled_change',
      sourceId: row!.id,
    });
  }

  /** Daily at 05:30 IST: applies conversions whose day has come. */
  async runScheduled(now = new Date()): Promise<{ applied: number; failed: number }> {
    const today = businessDate(now);
    const due = await this.db.tx((tx) =>
      tx
        .select()
        .from(scheduledChanges)
        .where(and(eq(scheduledChanges.status, 'pending'), lte(scheduledChanges.runOn, today)))
        .orderBy(asc(scheduledChanges.runOn)),
    );
    let applied = 0;
    let failed = 0;
    for (const item of due) {
      try {
        await this.db.tx(async (tx) => {
          await this.convert(tx, conversionPayload.parse(item.payload), item.personId, now);
          await tx
            .update(scheduledChanges)
            .set({ status: 'applied', appliedAt: new Date(), updatedAt: new Date() })
            .where(eq(scheduledChanges.id, item.id));
        });
        applied++;
      } catch (error) {
        failed++;
        const failure = error instanceof BadRequestException ? error.message : 'unexpected error';
        this.logger.warn(`Scheduled change ${item.id} failed: ${failure}`);
        await this.db.tx(async (tx) => {
          await tx
            .update(scheduledChanges)
            .set({ status: 'failed', failure, updatedAt: new Date() })
            .where(eq(scheduledChanges.id, item.id));
          const summary = await this.people.summary(item.personId);
          await notify(
            tx,
            await roleHolders(tx, 'hr', summary.legalEntityId),
            'scheduled_change_failed',
            `A scheduled conversion couldn’t apply: ${failure}`,
            `/people/${item.personId}`,
          );
        });
      }
    }
    return { applied, failed };
  }

  private async convert(tx: Tx, change: ConversionPayload, personId: string, now: Date) {
    const summary = await this.people.summary(personId);
    const { pay, engagementId: _engagementId, reason: _reason, ...rest } = change;
    const input: ConvertEngagementInput = {
      ...rest,
      ...(pay
        ? {
            compensation: {
              amount: (await this.open(tx, pay, personId)).toString(),
              rateUnit: pay.rateUnit,
            },
          }
        : {}),
    };
    await this.people.convertIn(tx, summary, input, now);
    const employee = await userOfPerson(tx, personId);
    if (employee) {
      await notify(
        tx,
        [employee],
        'converted',
        `You are now ${change.type.replace('_', '-')} from ${change.effectiveFrom}`,
        '/me',
      );
    }
  }

  // ---- Internals ----

  private async seal(amount: string, rateUnit: SealedPay['rateUnit']): Promise<SealedPay> {
    const payRef = randomUUID();
    return {
      payRef,
      rateUnit,
      amountEncrypted: await this.cipher.encrypt(requireContext().tenantId, amount, {
        table: 'change_request',
        column: 'pay',
        recordId: payRef,
      }),
    };
  }

  /** Every read of requested pay is an audited compensation read (decision #16). */
  private open(tx: Tx, pay: SealedPay, personId: string): Promise<bigint> {
    return this.sensitive.compensation(tx, {
      table: 'change_request',
      column: 'pay',
      recordId: pay.payRef,
      stored: pay.amountEncrypted,
      subjectPersonId: personId,
    });
  }

  private async currentPay(
    tx: Tx,
    engagementId: string,
    personId: string,
    day: string,
  ): Promise<string> {
    const before = addDays(day, -1);
    const [row] = await tx
      .select()
      .from(compensations)
      .where(
        and(
          eq(compensations.engagementId, engagementId),
          inForce(compensations.effectiveFrom, compensations.effectiveTo, before),
        ),
      );
    if (!row) return 'Unpaid';
    const amount = await this.sensitive.compensation(tx, {
      table: 'compensation',
      column: 'amount_encrypted',
      recordId: row.id,
      stored: row.amountEncrypted,
      subjectPersonId: personId,
    });
    return `${rupees(amount)} ${rateWords[row.rateUnit]}`;
  }

  private async bandMax(tx: Tx, engagementId: string, day: string): Promise<bigint | null> {
    const [row] = await tx
      .select({ bandMax: grades.bandMax })
      .from(assignments)
      .innerJoin(grades, eq(grades.id, assignments.gradeId))
      .where(
        and(
          eq(assignments.engagementId, engagementId),
          inForce(assignments.effectiveFrom, assignments.effectiveTo, day),
        ),
      );
    return row?.bandMax ?? null;
  }

  private async letter(
    tx: Tx,
    summary: PersonSummary,
    templateKey: string,
    extra: Record<string, string>,
    asOf: string,
  ): Promise<void> {
    try {
      const letterId = await this.letters.generateIn(tx, summary, {
        templateKey,
        extra,
        approval: false,
        asOf,
      });
      const [template] = await tx
        .select({ signature: letterTemplates.signature })
        .from(letterTemplates)
        .where(and(eq(letterTemplates.key, templateKey), eq(letterTemplates.active, true)));
      if (template?.signature === 'employee') await this.letters.sendIn(tx, letterId);
    } catch (error) {
      this.logger.warn(`Letter not made for ${summary.personId}: ${(error as Error).message}`);
      await notify(
        tx,
        await roleHolders(tx, 'hr', summary.legalEntityId),
        'letter_needed',
        `Couldn’t make a letter for ${summary.preferredName ?? summary.legalName}; make it from their record`,
        `/people/${summary.personId}`,
      );
    }
  }

  private async checkTemplate(tx: Tx, key: string | undefined): Promise<void> {
    if (!key) return;
    const [template] = await tx
      .select({ id: letterTemplates.id })
      .from(letterTemplates)
      .where(and(eq(letterTemplates.key, key), eq(letterTemplates.active, true)));
    if (!template) throw new BadRequestException({ message: `No letter template "${key}"` });
  }

  /** Runs the change in a transaction that is always rolled back: problems surface now. */
  private async trial(run: (tx: Tx) => Promise<unknown>): Promise<void> {
    try {
      await this.db.tx(async (tx) => {
        await run(tx);
        throw new TrialRun();
      });
    } catch (error) {
      if (!(error instanceof TrialRun)) throw error;
    }
  }

  private async can(summary: PersonSummary, area: DataArea, action: Action): Promise<boolean> {
    return (
      await this.authz.check(requireContext().actor!, action, {
        area,
        subjectPersonId: summary.personId,
        legalEntityId: summary.legalEntityId,
      })
    ).allowed;
  }

  private async assert(summary: PersonSummary, area: DataArea, action: Action): Promise<void> {
    await this.authz.assert(requireContext().actor!, action, {
      area,
      subjectPersonId: summary.personId,
      legalEntityId: summary.legalEntityId,
    });
  }

  private parse<T extends z.ZodType>(schema: T, payload: unknown): Record<string, unknown> {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new BadRequestException({ message: 'Invalid request' });
    return parsed.data as Record<string, unknown>;
  }
}
