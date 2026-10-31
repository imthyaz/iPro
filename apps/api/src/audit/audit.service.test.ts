import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runWithContext, type Actor } from '../context/request-context.js';
import type { Tx } from '../db/tenant-context.js';
import { AuditService, diffFields, SensitiveReads, type AuditEntry } from './audit.service.js';
import { FieldCipher } from './field-cipher.js';
import { LocalDataKeyProvider } from './key-providers.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const hr: Actor = {
  userId: '00000000-0000-4000-8000-0000000000c1',
  tenantId: TENANT,
  personId: null,
  roles: [{ role: 'hr', legalEntityId: null }],
};

class RecordingAudit extends AuditService {
  entries: AuditEntry[] = [];
  override async record(_tx: Tx, entry: AuditEntry) {
    this.entries.push(entry);
  }
}

const cipher = new FieldCipher(new LocalDataKeyProvider(randomBytes(32)));
const tx = {} as Tx;

async function setup() {
  const audit = new RecordingAudit();
  const reads = new SensitiveReads(audit, cipher);
  const at = { table: 'kyc_record', column: 'value_encrypted', recordId: 'k1' };
  const stored = await cipher.encrypt(TENANT, 'ABCDE1234F', at);
  return { audit, reads, field: { ...at, stored, subjectPersonId: 'p1' } };
}

const asHr = <T>(fn: () => Promise<T>) => runWithContext({ tenantId: TENANT, actor: hr }, fn);

describe('SensitiveReads', () => {
  it('a masked KYC view returns the last 4 and writes a view audit row', async () => {
    const { audit, reads, field } = await setup();
    expect(await asHr(() => reads.kyc(tx, field, 'masked'))).toMatch(/234F$/);
    expect(audit.entries).toEqual([
      {
        action: 'view',
        table: 'kyc_record',
        recordId: 'k1',
        subjectPersonId: 'p1',
        fieldChanges: [{ field: 'value_encrypted', sensitive: true }],
      },
    ]);
  });

  it('an unmask returns the value and writes an unmask audit row', async () => {
    const { audit, reads, field } = await setup();
    expect(await asHr(() => reads.kyc(tx, field, 'unmask'))).toBe('ABCDE1234F');
    expect(audit.entries.map((entry) => entry.action)).toEqual(['unmask']);
  });

  it('every compensation read writes a view audit row', async () => {
    const audit = new RecordingAudit();
    const reads = new SensitiveReads(audit, cipher);
    const at = { table: 'compensation', column: 'annual_ctc_encrypted', recordId: 'c1' };
    const stored = await cipher.encrypt(TENANT, '120000000', at); // ₹12,00,000 in paise, synthetic
    const field = { ...at, stored, subjectPersonId: 'p1' };
    expect(await asHr(() => reads.compensation(tx, field))).toBe(120000000n);
    expect(await asHr(() => reads.compensation(tx, field))).toBe(120000000n);
    expect(audit.entries).toHaveLength(2);
    expect(
      audit.entries.every((entry) => entry.action === 'view' && entry.table === 'compensation'),
    ).toBe(true);
  });

  it('no audit row means no value: a failed audit write stops the read', async () => {
    const failing = new (class extends AuditService {
      override async record(): Promise<void> {
        throw new Error('audit down');
      }
    })();
    const { field } = await setup();
    await expect(
      asHr(() => new SensitiveReads(failing, cipher).kyc(tx, field, 'unmask')),
    ).rejects.toThrow('audit down');
  });
});

describe('diffFields', () => {
  it('records changed fields and hides sensitive values', () => {
    expect(
      diffFields(
        { designation: 'Engineer', ctc: '1', city: 'Chennai' },
        { designation: 'Senior Engineer', ctc: '2', city: 'Chennai' },
        ['ctc'],
      ),
    ).toEqual([
      { field: 'designation', from: 'Engineer', to: 'Senior Engineer' },
      { field: 'ctc', sensitive: true },
    ]);
  });
});
