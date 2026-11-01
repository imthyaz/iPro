import { Inject, Injectable } from '@nestjs/common';
import { requireContext } from '../context/request-context.js';
import type { Tx } from '../db/tenant-context.js';
import { auditLog, type AuditAction, type FieldChange } from './audit.schema.js';
import { maskLast4 } from './masking.js';
import { FieldCipher, type FieldLocation } from './field-cipher.js';

export interface AuditEntry {
  action: AuditAction;
  table: string;
  recordId?: string | null;
  subjectPersonId?: string | null;
  fieldChanges?: FieldChange[];
}

export const FIELD_CIPHER = Symbol('FIELD_CIPHER');

/** The only writer of AuditLog. Writes in the caller's transaction, so the audit row commits with the change. */
@Injectable()
export class AuditService {
  /** Returns the audit row id, so a journal event can point at the change it records. */
  async record(tx: Tx, entry: AuditEntry): Promise<string> {
    const context = requireContext();
    const [row] = await tx
      .insert(auditLog)
      .values({
        tenantId: context.tenantId,
        createdBy: context.actor?.userId ?? null,
        updatedBy: context.actor?.userId ?? null,
        action: entry.action,
        tableName: entry.table,
        recordId: entry.recordId ?? null,
        subjectPersonId: entry.subjectPersonId ?? null,
        fieldChanges: entry.fieldChanges ?? null,
        requestId: context.requestId,
        ip: context.ip,
      })
      .returning({ id: auditLog.id });
    return row!.id;
  }
}

export interface EncryptedField extends FieldLocation {
  stored: string;
  subjectPersonId: string | null;
}

/**
 * Reads of encrypted KYC and compensation values. Every read writes an audit row first (decision #16):
 * masked KYC views as `view`, unmasks as `unmask`, compensation reads as `view`.
 */
@Injectable()
export class SensitiveReads {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
  ) {}

  /** KYC value as the caller may see it: masked (last 4) unless `unmask` was authorised. */
  async kyc(tx: Tx, field: EncryptedField, mode: 'masked' | 'unmask'): Promise<string> {
    await this.log(tx, field, mode === 'unmask' ? 'unmask' : 'view');
    const value = await this.cipher.decrypt(requireContext().tenantId, field.stored, field);
    return mode === 'unmask' ? value : maskLast4(value);
  }

  /** Compensation amount in paise, as a bigint. */
  async compensation(tx: Tx, field: EncryptedField): Promise<bigint> {
    await this.log(tx, field, 'view');
    return BigInt(await this.cipher.decrypt(requireContext().tenantId, field.stored, field));
  }

  private log(tx: Tx, field: EncryptedField, action: 'view' | 'unmask') {
    return this.audit.record(tx, {
      action,
      table: field.table,
      recordId: field.recordId,
      subjectPersonId: field.subjectPersonId,
      fieldChanges: [{ field: field.column, sensitive: true }],
    });
  }
}

/** Field changes for an update audit row. Values of sensitive fields are never recorded. */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
  sensitive: readonly (keyof T)[] = [],
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of Object.keys(after) as (keyof T & string)[]) {
    if (Object.is(before[field], after[field])) continue;
    changes.push(
      sensitive.includes(field)
        ? { field, sensitive: true }
        : { field, from: before[field] ?? null, to: after[field] ?? null },
    );
  }
  return changes;
}
