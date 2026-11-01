import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type {
  LetterTemplateInput,
  LetterTemplateView,
  LetterView,
  PersonSummary,
} from '@ipro/shared';
import { AuditService, SensitiveReads } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { ESIGN_PROVIDER, FakeEsign, type EsignProvider } from '../esign/esign.js';
import { grades, legalEntities } from '../org/org.schema.js';
import { documents } from '../people/documents.schema.js';
import { inForce } from '../people/people.queries.js';
import { assignments, compensations, engagements, persons } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/object-storage.js';
import { WorkflowActions } from '../workflow/actions.js';
import { notify, roleHolders } from '../workflow/lookups.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { letters, letterTemplates } from './letters.schema.js';
import { fieldsIn, merge, templateProblems, toBlocks } from './merge-fields.js';
import { renderLetterPdf } from './pdf.js';

type LetterRow = typeof letters.$inferSelect;

/** Called in the refresh transaction when the signer signs, declines or the request is withdrawn. */
export type SettledListener = (
  tx: Tx,
  letter: {
    letterId: string;
    personId: string;
    engagementId: string;
    state: 'signed' | 'declined' | 'cancelled';
  },
) => Promise<void>;

const longDate = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const formatDate = (iso: string | null | undefined) =>
  iso ? longDate.format(new Date(`${iso}T00:00:00Z`)) : null;
const rate: Record<string, string> = {
  year: 'a year',
  month: 'a month',
  day: 'a day',
  hour: 'an hour',
};

/** ₹ amount from paise, Indian grouping, whole rupees without decimals. */
function formatPaise(paise: bigint): string {
  const rupees = (paise / 100n).toString();
  const rest = paise % 100n;
  const head = rupees.slice(0, -3).replace(/\B(?=(\d{2})+$)/g, ',');
  return `₹${head ? `${head},${rupees.slice(-3)}` : rupees}${rest ? `.${rest.toString().padStart(2, '0')}` : ''}`;
}

const releasePayload = z.object({ letterId: z.uuid(), approverRole: z.enum(['hr', 'hr_head']) });

/**
 * Letters (decision #51): templates with merge fields and versions, PDF generation into versioned
 * Documents, an approval step where the template asks for one, and e-signature through the esign
 * layer. Signing stores the signed PDF as the next document version.
 */
@Injectable()
export class LettersService implements OnModuleInit {
  private readonly logger = new Logger('Letters');
  private readonly settledListeners: SettledListener[] = [];

  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SensitiveReads) private readonly sensitive: SensitiveReads,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ESIGN_PROVIDER) private readonly esign: EsignProvider,
    @Inject(WorkflowActions) private readonly actions: WorkflowActions,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
  ) {}

  onModuleInit(): void {
    this.actions.register('letter.release', {
      validate: (payload) => {
        const parsed = releasePayload.safeParse(payload);
        if (!parsed.success) throw new BadRequestException({ message: 'Invalid letter approval' });
        return parsed.data;
      },
      describe: async (tx, instance) => {
        const { letterId } = releasePayload.parse(instance.payload);
        const [row] = await tx
          .select({ name: letterTemplates.name, version: letterTemplates.version })
          .from(letters)
          .innerJoin(letterTemplates, eq(letterTemplates.id, letters.templateId))
          .where(eq(letters.id, letterId));
        return [
          {
            label: 'Letter',
            from: null,
            to: row ? `${row.name} (template v${row.version})` : null,
          },
        ];
      },
      apply: async (tx, instance) => {
        await this.setStatus(tx, releasePayload.parse(instance.payload).letterId, 'ready');
      },
      onStatus: async (tx, instance, status) => {
        const { letterId } = releasePayload.parse(instance.payload);
        if (status === 'returned') await this.setStatus(tx, letterId, 'returned');
        if (status === 'withdrawn') await this.setStatus(tx, letterId, 'cancelled');
        if (status === 'pending') await this.setStatus(tx, letterId, 'pending_approval');
      },
    });
  }

  // ---- Templates (A3) ----

  async saveTemplate(key: string, input: LetterTemplateInput): Promise<LetterTemplateView> {
    const { actor, tenantId } = requireContext();
    await this.authz.assert(actor!, 'update', { area: 'org_config' });
    const problems = templateProblems(input.body);
    if (problems.length > 0)
      throw new BadRequestException({ message: 'Template has problems', problems });
    return this.db.tx(async (tx) => {
      const [latest] = await tx
        .select({ version: letterTemplates.version })
        .from(letterTemplates)
        .where(eq(letterTemplates.key, key))
        .orderBy(desc(letterTemplates.version))
        .limit(1);
      await tx.update(letterTemplates).set({ active: false }).where(eq(letterTemplates.key, key));
      const [row] = await tx
        .insert(letterTemplates)
        .values({
          tenantId,
          key,
          version: (latest?.version ?? 0) + 1,
          ...input,
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        })
        .returning();
      await this.audit.record(tx, {
        action: 'create',
        table: 'letter_template',
        recordId: row!.id,
      });
      return { key, version: row!.version, ...input, fields: fieldsIn(input.body) };
    });
  }

  async listTemplates(): Promise<LetterTemplateView[]> {
    await this.authz.assert(requireContext().actor!, 'read', { area: 'org_config' });
    const rows = await this.db.tx((tx) =>
      tx
        .select()
        .from(letterTemplates)
        .where(eq(letterTemplates.active, true))
        .orderBy(asc(letterTemplates.name)),
    );
    return rows.map((r) => ({
      key: r.key,
      version: r.version,
      name: r.name,
      type: r.type,
      body: r.body,
      approverRole: r.approverRole,
      signature: r.signature,
      fields: fieldsIn(r.body),
    }));
  }

  // ---- Letters ----

  /** HR generates a letter: merge, render, store as a new document version, then approval if required. */
  async generate(
    personId: string,
    input: { templateKey: string; extra: Record<string, string> },
  ): Promise<LetterView> {
    const summary = await this.people.summary(personId);
    await this.authz.assert(requireContext().actor!, 'create', {
      area: 'documents',
      subjectPersonId: personId,
      legalEntityId: summary.legalEntityId,
    });
    const letterId = await this.db.tx((tx) =>
      this.generateIn(tx, summary, { ...input, approval: true }),
    );
    return this.view(letterId);
  }

  /**
   * Generates inside the caller's transaction. `approval: false` is for letters whose approval is part
   * of another workflow (an offer's, decision #54); the letter is then ready at once.
   */
  async generateIn(
    tx: Tx,
    summary: PersonSummary,
    input: { templateKey: string; extra: Record<string, string>; approval: boolean },
  ): Promise<string> {
    const { actor, tenantId } = requireContext();
    const personId = summary.personId;
    {
      const [template] = await tx
        .select()
        .from(letterTemplates)
        .where(and(eq(letterTemplates.key, input.templateKey), eq(letterTemplates.active, true)));
      if (!template)
        throw new NotFoundException({ message: `No letter template "${input.templateKey}"` });

      const values = await this.values(tx, summary.engagementId, template.body, input.extra);
      const merged = merge(template.body, values);
      if (!merged.ok) {
        throw new BadRequestException({
          message: 'Some fields have no value',
          problems: merged.missing,
        });
      }
      const companyName = values['company.name'] ?? '';
      const pdf = await renderLetterPdf({
        title: template.name,
        companyName,
        date: values['letter.date']!,
        blocks: toBlocks(merged.text),
      });

      // Versioned per person and template: a regenerated letter is the next version.
      const [previous] = await tx
        .select({ id: documents.id, version: documents.version })
        .from(documents)
        .where(
          and(
            eq(documents.personId, personId),
            eq(documents.generatedFromTemplateId, template.id),
            isNull(documents.signedAt),
          ),
        )
        .orderBy(desc(documents.version))
        .limit(1);
      const documentId = await this.storeDocument(tx, {
        personId,
        title: template.name,
        fileName: `${template.name}.pdf`,
        pdf,
        version: (previous?.version ?? 0) + 1,
        previousVersionId: previous?.id ?? null,
        templateId: template.id,
        signedAt: null,
      });
      const [letter] = await tx
        .insert(letters)
        .values({
          tenantId,
          personId,
          engagementId: summary.engagementId,
          templateId: template.id,
          documentId,
          status: template.approverRole && input.approval ? 'pending_approval' : 'ready',
          extra: input.extra,
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        })
        .returning();
      await this.audit.record(tx, {
        action: 'create',
        table: 'letter',
        recordId: letter!.id,
        subjectPersonId: personId,
      });
      if (template.approverRole && input.approval) {
        const requestId = await this.workflows.submit(tx, {
          key: 'letter_approval',
          subjectPersonId: personId,
          title: `${template.name}: ${summary.preferredName ?? summary.legalName}`,
          payload: { letterId: letter!.id, approverRole: template.approverRole },
        });
        await tx
          .update(letters)
          .set({ approvalRequestId: requestId })
          .where(eq(letters.id, letter!.id));
      }
      return letter!.id;
    }
  }

  /** Sends a released letter to the person for e-signature. */
  async send(letterId: string): Promise<LetterView> {
    const { letter } = await this.db.tx((tx) => this.load(tx, letterId));
    await this.assertOnPerson(letter.personId, 'update');
    await this.db.tx((tx) => this.sendIn(tx, letterId));
    return this.view(letterId);
  }

  /**
   * Sends inside the caller's transaction, after the caller has authorised it (an offer's final
   * approver, decision #54). The provider is called last, so a failure rolls everything back.
   */
  async sendIn(tx: Tx, letterId: string): Promise<void> {
    const actor = requireContext().actor;
    const { letter, template } = await this.load(tx, letterId);
    if (letter.status !== 'ready')
      throw new ConflictException({ message: 'Only a released letter can be sent' });
    if (template.signature !== 'employee')
      throw new BadRequestException({ message: 'This letter is not signed' });

    const [signer] = await tx
      .select({
        legalName: persons.legalName,
        personalEmail: persons.personalEmail,
        workEmail: engagements.workEmail,
      })
      .from(engagements)
      .innerJoin(persons, eq(persons.id, engagements.personId))
      .where(eq(engagements.id, letter.engagementId));
    const email = signer?.workEmail ?? signer?.personalEmail;
    if (!signer || !email)
      throw new BadRequestException({ message: 'The person has no email to sign with' });
    const [doc] = await tx.select().from(documents).where(eq(documents.id, letter.documentId));
    const pdf = await this.storage.get(doc!.storageKey);
    await this.audit.record(tx, {
      action: 'update',
      table: 'letter',
      recordId: letterId,
      subjectPersonId: letter.personId,
      fieldChanges: [{ field: 'status', from: 'ready', to: 'sent' }],
    });
    const { requestId } = await this.esign.send({
      pdf,
      fileName: doc!.fileName,
      title: template.name,
      signer: { name: signer.legalName, email },
      reference: letter.id,
    });
    await tx
      .update(letters)
      .set({
        status: 'sent',
        esignProvider: this.esign.name,
        esignRequestId: requestId,
        sentAt: new Date(),
        updatedAt: new Date(),
        updatedBy: actor?.userId ?? null,
      })
      .where(eq(letters.id, letterId));
  }

  async cancel(letterId: string): Promise<LetterView> {
    const { letter } = await this.db.tx((tx) => this.load(tx, letterId));
    await this.assertOnPerson(letter.personId, 'update');
    if (!['ready', 'sent', 'returned'].includes(letter.status)) {
      throw new ConflictException({ message: 'This letter can’t be cancelled now' });
    }
    await this.db.tx((tx) => this.cancelIn(tx, letterId));
    return this.view(letterId);
  }

  /** Cancels inside the caller's transaction (also withdrawing it from the signing provider). */
  async cancelIn(tx: Tx, letterId: string): Promise<void> {
    const { letter } = await this.load(tx, letterId);
    if (!['ready', 'sent', 'returned', 'pending_approval'].includes(letter.status)) return;
    await this.setStatus(tx, letterId, 'cancelled');
    await this.audit.record(tx, {
      action: 'update',
      table: 'letter',
      recordId: letterId,
      subjectPersonId: letter.personId,
      fieldChanges: [{ field: 'status', from: letter.status, to: 'cancelled' }],
    });
    if (letter.status === 'sent' && letter.esignRequestId)
      await this.esign.cancel(letter.esignRequestId);
  }

  /** Lets another module act when a letter is signed or declined (an offer, decision #54). */
  onSettled(listener: SettledListener): void {
    this.settledListeners.push(listener);
  }

  async lettersFor(personId: string): Promise<LetterView[]> {
    await this.assertOnPerson(personId, 'read');
    const rows = await this.db.tx((tx) =>
      tx
        .select({ id: letters.id })
        .from(letters)
        .where(eq(letters.personId, personId))
        .orderBy(desc(letters.createdAt)),
    );
    return Promise.all(rows.map((r) => this.view(r.id)));
  }

  /** Provider webhook: only tells us which request to check; the outcome comes from the provider. */
  async webhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    const requestId = this.esign.webhookRequestId(rawBody, headers);
    if (!requestId) return false;
    const [letter] = await this.db.tx((tx) =>
      tx.select({ id: letters.id }).from(letters).where(eq(letters.esignRequestId, requestId)),
    );
    if (!letter) return false;
    await this.refresh(letter.id);
    return true;
  }

  /** Development only: the fake provider's signer signs or declines, then the letter is re-checked. */
  async playFakeSigner(letterId: string, action: 'sign' | 'decline'): Promise<void> {
    if (!(this.esign instanceof FakeEsign)) throw new NotFoundException();
    const { letter } = await this.db.tx((tx) => this.load(tx, letterId));
    await this.assertOnPerson(letter.personId, 'update');
    if (letter.status !== 'sent' || !letter.esignRequestId) {
      throw new ConflictException({ message: 'This letter is not out for signature' });
    }
    if (action === 'sign') this.esign.sign(letter.esignRequestId);
    else this.esign.decline(letter.esignRequestId);
    await this.refresh(letterId);
  }

  /** Every 15 minutes: checks letters out for signature (catches webhooks that never arrive). */
  async poll(): Promise<{ checked: number }> {
    const sent = await this.db.tx((tx) =>
      tx.select({ id: letters.id }).from(letters).where(eq(letters.status, 'sent')),
    );
    for (const { id } of sent) {
      try {
        await this.refresh(id);
      } catch (error) {
        this.logger.warn(`E-sign status check failed for letter ${id}: ${(error as Error).name}`);
      }
    }
    return { checked: sent.length };
  }

  /** Applies the provider's current status to a sent letter. */
  async refresh(letterId: string): Promise<void> {
    const { letter, template } = await this.db.tx((tx) => this.load(tx, letterId));
    if (letter.status !== 'sent' || !letter.esignRequestId) return;
    const status = await this.esign.status(letter.esignRequestId);
    if (status.state === 'pending') return;
    await this.db.tx(async (tx) => {
      const [current] = await tx.select().from(letters).where(eq(letters.id, letterId));
      if (current?.status !== 'sent') return; // another refresh got here first
      if (status.state === 'signed') {
        const [unsigned] = await tx
          .select()
          .from(documents)
          .where(eq(documents.id, letter.documentId));
        const signedAt = new Date();
        const signedDocumentId = await this.storeDocument(tx, {
          personId: letter.personId,
          title: `${template.name} (signed)`,
          fileName: `${template.name} (signed).pdf`,
          pdf: status.signedPdf,
          version: unsigned!.version + 1,
          previousVersionId: unsigned!.id,
          templateId: template.id,
          signedAt,
        });
        await tx
          .update(letters)
          .set({ status: 'signed', signedAt, signedDocumentId, updatedAt: signedAt })
          .where(eq(letters.id, letterId));
      } else {
        await this.setStatus(tx, letterId, status.state === 'declined' ? 'declined' : 'cancelled');
      }
      await this.audit.record(tx, {
        action: 'update',
        table: 'letter',
        recordId: letterId,
        subjectPersonId: letter.personId,
        fieldChanges: [{ field: 'status', from: 'sent', to: status.state }],
      });
      for (const listener of this.settledListeners) {
        await listener(tx, {
          letterId,
          personId: letter.personId,
          engagementId: letter.engagementId,
          state: status.state,
        });
      }
      const [engagement] = await tx
        .select({ legalEntityId: engagements.legalEntityId })
        .from(engagements)
        .where(eq(engagements.id, letter.engagementId));
      await notify(
        tx,
        await roleHolders(tx, 'hr', engagement!.legalEntityId),
        `letter_${status.state}`,
        `${template.name} ${status.state === 'signed' ? 'signed' : status.state}`,
        `/people/${letter.personId}`,
      );
    });
  }

  // ---- Internals ----

  /** Merge values for the fields a template uses. Pay is read only if the template asks for it. */
  private async values(
    tx: Tx,
    engagementId: string,
    body: string,
    extra: Record<string, string>,
  ): Promise<Record<string, string | null>> {
    const today = businessDate(new Date());
    const used = new Set(fieldsIn(body));
    const [row] = await tx
      .select({ engagement: engagements, person: persons, company: legalEntities })
      .from(engagements)
      .innerJoin(persons, eq(persons.id, engagements.personId))
      .innerJoin(legalEntities, eq(legalEntities.id, engagements.legalEntityId))
      .where(eq(engagements.id, engagementId));
    if (!row) throw new NotFoundException();
    // An offer letter describes the role and pay from the joining date.
    const on = row.engagement.joiningDate > today ? row.engagement.joiningDate : today;
    const summary = await this.people.summary(row.person.id);
    const [assignment] = await tx
      .select({ gradeName: grades.name })
      .from(assignments)
      .innerJoin(grades, eq(grades.id, assignments.gradeId))
      .where(
        and(
          eq(assignments.engagementId, engagementId),
          inForce(assignments.effectiveFrom, assignments.effectiveTo, on),
        ),
      );

    const values: Record<string, string | null> = {
      'letter.date': formatDate(today),
      'company.name': row.company.name,
      'company.address': row.company.registeredAddress,
      'person.legalName': row.person.legalName,
      'person.preferredName': row.person.preferredName ?? row.person.legalName,
      'engagement.employeeCode': row.engagement.employeeCode,
      'engagement.type': row.engagement.type.replace('_', '-'),
      'engagement.joiningDate': formatDate(row.engagement.joiningDate),
      'engagement.probationEndDate': formatDate(row.engagement.probationEndDate),
      'engagement.noticePeriodDays': row.engagement.noticePeriodDays?.toString() ?? null,
      'engagement.lastWorkingDate': formatDate(row.engagement.lastWorkingDate),
      'assignment.designation': summary.designation?.title ?? null,
      'assignment.department': summary.department?.name ?? null,
      'assignment.location': summary.location?.name ?? null,
      'assignment.grade': assignment?.gradeName ?? null,
      'manager.name': summary.manager?.name ?? null,
    };
    if (used.has('compensation.amount')) {
      const [pay] = await tx
        .select()
        .from(compensations)
        .where(
          and(
            eq(compensations.engagementId, engagementId),
            inForce(compensations.effectiveFrom, compensations.effectiveTo, on),
          ),
        );
      if (pay) {
        const amount = await this.sensitive.compensation(tx, {
          table: 'compensation',
          column: 'amount_encrypted',
          recordId: pay.id,
          stored: pay.amountEncrypted,
          subjectPersonId: row.person.id,
        });
        values['compensation.amount'] = `${formatPaise(amount)} ${rate[pay.rateUnit] ?? ''}`.trim();
      }
    }
    for (const [key, value] of Object.entries(extra)) values[`extra.${key}`] = value;
    return values;
  }

  private async storeDocument(
    tx: Tx,
    doc: {
      personId: string;
      title: string;
      fileName: string;
      pdf: Buffer;
      version: number;
      previousVersionId: string | null;
      templateId: string;
      signedAt: Date | null;
    },
  ): Promise<string> {
    const { tenantId, actor } = requireContext();
    const id = randomUUID();
    const storageKey = `${tenantId}/people/${doc.personId}/${id}`;
    await this.storage.put(storageKey, doc.pdf, 'application/pdf');
    await tx.insert(documents).values({
      id,
      tenantId,
      personId: doc.personId,
      type: 'letter',
      title: doc.title,
      storageKey,
      fileName: doc.fileName,
      contentType: 'application/pdf',
      sizeBytes: doc.pdf.length,
      sha256: createHash('sha256').update(doc.pdf).digest('hex'),
      version: doc.version,
      previousVersionId: doc.previousVersionId,
      generatedFromTemplateId: doc.templateId,
      signedAt: doc.signedAt,
      confidential: true,
      createdBy: actor?.userId ?? null,
      updatedBy: actor?.userId ?? null,
    });
    await this.audit.record(tx, {
      action: 'create',
      table: 'document',
      recordId: id,
      subjectPersonId: doc.personId,
    });
    return id;
  }

  private async setStatus(tx: Tx, letterId: string, status: LetterRow['status']) {
    await tx.update(letters).set({ status, updatedAt: new Date() }).where(eq(letters.id, letterId));
  }

  private async load(tx: Tx, letterId: string) {
    const [row] = await tx
      .select({ letter: letters, template: letterTemplates })
      .from(letters)
      .innerJoin(letterTemplates, eq(letterTemplates.id, letters.templateId))
      .where(eq(letters.id, letterId));
    if (!row) throw new NotFoundException();
    return row;
  }

  /** Letters are confidential documents: HR and HR head, and the person themselves. */
  private async assertOnPerson(personId: string, action: 'read' | 'update') {
    const summary = await this.people.summary(personId);
    await this.authz.assert(requireContext().actor!, action, {
      area: 'documents',
      subjectPersonId: personId,
      legalEntityId: summary.legalEntityId,
      attributes: { confidential: true },
    });
  }

  private view(letterId: string): Promise<LetterView> {
    return this.db.tx(async (tx) => {
      const { letter, template } = await this.load(tx, letterId);
      const [doc] = await tx
        .select({ version: documents.version })
        .from(documents)
        .where(eq(documents.id, letter.documentId));
      return {
        id: letter.id,
        title: template.name,
        type: template.type,
        templateVersion: template.version,
        status: letter.status,
        documentId: letter.documentId,
        documentVersion: doc!.version,
        signedDocumentId: letter.signedDocumentId,
        needsSignature: template.signature === 'employee',
        approvalRequestId: letter.approvalRequestId,
        createdAt: letter.createdAt.toISOString(),
        sentAt: letter.sentAt?.toISOString() ?? null,
        signedAt: letter.signedAt?.toISOString() ?? null,
      };
    });
  }
}
