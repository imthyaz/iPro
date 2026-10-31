import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { KycSubmitInput, KycView } from '@ipro/shared';
import { AuditService, FIELD_CIPHER, SensitiveReads } from '../audit/audit.service.js';
import type { FieldCipher } from '../audit/field-cipher.js';
import { AuthzService, type Resource } from '../authz/authz.service.js';
import type { Action } from '../authz/permissions.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { documents, kycRecords } from './documents.schema.js';
import { PeopleService } from './people.service.js';

const kycField = (id: string) => ({ table: 'kyc_record', column: 'value_encrypted', recordId: id });

/**
 * KYC values: encrypted, listed masked (every view audited), unmasked only by HR and HR head (every
 * unmask audited). Employees submit their own; once HR verifies a value, only HR can replace it.
 */
@Injectable()
export class KycService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SensitiveReads) private readonly sensitive: SensitiveReads,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(PeopleService) private readonly people: PeopleService,
  ) {}

  async list(personId: string): Promise<KycView[]> {
    await this.assert(personId, 'read');
    return this.db.tx(async (tx) => {
      const rows = await this.current(tx, personId);
      const views: KycView[] = [];
      for (const row of rows) {
        const masked = await this.sensitive.kyc(
          tx,
          { ...kycField(row.id), stored: row.valueEncrypted, subjectPersonId: personId },
          'masked',
        );
        views.push({
          id: row.id,
          type: row.type,
          maskedValue: masked,
          extra: row.extra,
          documentId: row.documentId,
          verified: row.verifiedAt !== null,
          verifiedAt: row.verifiedAt?.toISOString() ?? null,
        });
      }
      return views;
    });
  }

  async unmask(personId: string, kycId: string): Promise<{ value: string }> {
    await this.assert(personId, 'unmask');
    return this.db.tx(async (tx) => {
      const row = await this.load(tx, personId, kycId);
      const value = await this.sensitive.kyc(
        tx,
        { ...kycField(row.id), stored: row.valueEncrypted, subjectPersonId: personId },
        'unmask',
      );
      return { value };
    });
  }

  async submit(personId: string, input: KycSubmitInput): Promise<KycView[]> {
    const { actor, tenantId } = requireContext();
    const resource = await this.resource(personId);
    // HR and HR head update anyone's KYC; employees create their own.
    const asHr = (await this.authz.check(actor!, 'update', resource)).allowed;
    if (!asHr) await this.authz.assert(actor!, 'create', resource);

    await this.db.tx(async (tx) => {
      const [existing] = (await this.current(tx, personId)).filter(
        (row) => row.type === input.type,
      );
      if (existing?.verifiedAt && !asHr) {
        throw new ConflictException({ message: 'This value is verified; ask HR to change it' });
      }
      if (input.documentId) await this.checkScan(tx, personId, input.documentId);

      const now = new Date();
      if (existing) {
        await tx
          .update(kycRecords)
          .set({
            deletedAt: now,
            deletedBy: actor!.userId,
            updatedAt: now,
            updatedBy: actor!.userId,
          })
          .where(eq(kycRecords.id, existing.id));
        await this.audit.record(tx, {
          action: 'delete',
          table: 'kyc_record',
          recordId: existing.id,
          subjectPersonId: personId,
        });
      }
      const id = randomUUID();
      await tx.insert(kycRecords).values({
        id,
        tenantId,
        personId,
        type: input.type,
        valueEncrypted: await this.cipher.encrypt(tenantId, input.value, kycField(id)),
        extra: input.ifsc ? { ifsc: input.ifsc } : {},
        documentId: input.documentId ?? null,
        createdBy: actor!.userId,
        updatedBy: actor!.userId,
      });
      await this.audit.record(tx, {
        action: 'create',
        table: 'kyc_record',
        recordId: id,
        subjectPersonId: personId,
        fieldChanges: [{ field: 'value_encrypted', sensitive: true }],
      });
    });
    return this.list(personId);
  }

  async verify(personId: string, kycId: string): Promise<KycView[]> {
    await this.assert(personId, 'verify');
    const { actor } = requireContext();
    await this.db.tx(async (tx) => {
      const row = await this.load(tx, personId, kycId);
      if (row.verifiedAt) return;
      const now = new Date();
      await tx
        .update(kycRecords)
        .set({
          verifiedBy: actor!.userId,
          verifiedAt: now,
          updatedAt: now,
          updatedBy: actor!.userId,
        })
        .where(eq(kycRecords.id, kycId));
      await this.audit.record(tx, {
        action: 'update',
        table: 'kyc_record',
        recordId: kycId,
        subjectPersonId: personId,
        fieldChanges: [{ field: 'verified_at', from: null, to: now.toISOString() }],
      });
    });
    return this.list(personId);
  }

  private async resource(personId: string): Promise<Resource> {
    const summary = await this.people.summary(personId);
    return { area: 'kyc', subjectPersonId: personId, legalEntityId: summary.legalEntityId };
  }

  private async assert(personId: string, action: Action) {
    return this.authz.assert(requireContext().actor!, action, await this.resource(personId));
  }

  private current(tx: Tx, personId: string) {
    return tx
      .select()
      .from(kycRecords)
      .where(and(eq(kycRecords.personId, personId), isNull(kycRecords.deletedAt)))
      .orderBy(asc(kycRecords.type));
  }

  private async load(tx: Tx, personId: string, kycId: string) {
    const [row] = await tx
      .select()
      .from(kycRecords)
      .where(
        and(
          eq(kycRecords.id, kycId),
          eq(kycRecords.personId, personId),
          isNull(kycRecords.deletedAt),
        ),
      );
    if (!row) throw new NotFoundException();
    return row;
  }

  private async checkScan(tx: Tx, personId: string, documentId: string) {
    const [scan] = await tx
      .select({ type: documents.type })
      .from(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.personId, personId),
          isNull(documents.deletedAt),
        ),
      );
    if (scan?.type !== 'kyc_scan')
      throw new BadRequestException({ message: 'Not a KYC scan of this person' });
  }
}
