import { DecryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FieldCipher } from './field-cipher.js';
import { KmsDataKeyProvider, LocalDataKeyProvider, type DataKeyStore } from './key-providers.js';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const at = { table: 'kyc_record', column: 'value_encrypted', recordId: 'r1' };
const pan = 'ABCDE1234F'; // synthetic

const local = new FieldCipher(new LocalDataKeyProvider(randomBytes(32)));

describe('FieldCipher', () => {
  it('round-trips and never stores the plaintext', async () => {
    const stored = await local.encrypt(TENANT_A, pan, at);
    expect(stored).not.toContain(pan);
    expect(stored.startsWith('v1.')).toBe(true);
    expect(await local.decrypt(TENANT_A, stored, at)).toBe(pan);
  });

  it('uses a fresh IV each time', async () => {
    expect(await local.encrypt(TENANT_A, pan, at)).not.toBe(await local.encrypt(TENANT_A, pan, at));
  });

  it('rejects a value moved to another record or column', async () => {
    const stored = await local.encrypt(TENANT_A, pan, at);
    await expect(local.decrypt(TENANT_A, stored, { ...at, recordId: 'r2' })).rejects.toThrow();
    await expect(local.decrypt(TENANT_A, stored, { ...at, column: 'other' })).rejects.toThrow();
  });

  it('keeps tenants apart', async () => {
    const stored = await local.encrypt(TENANT_A, pan, at);
    await expect(local.decrypt(TENANT_B, stored, at)).rejects.toThrow();
  });

  it('detects tampering', async () => {
    const stored = await local.encrypt(TENANT_A, pan, at);
    const parts = stored.split('.');
    const body = Buffer.from(parts[4]!, 'base64url');
    body[0] = body[0]! ^ 0xff;
    parts[4] = body.toString('base64url');
    await expect(local.decrypt(TENANT_A, parts.join('.'), at)).rejects.toThrow();
  });
});

describe('KmsDataKeyProvider', () => {
  function fakeKms() {
    const wrapped = new Map<string, Buffer>();
    const calls: string[] = [];
    return {
      calls,
      send: async (command: unknown) => {
        if (command instanceof GenerateDataKeyCommand) {
          calls.push('generate');
          const plaintext = randomBytes(32);
          const blob = randomBytes(16);
          wrapped.set(blob.toString('hex'), plaintext);
          return { KeyId: 'arn:test:key', Plaintext: plaintext, CiphertextBlob: blob };
        }
        if (command instanceof DecryptCommand) {
          calls.push('decrypt');
          const blob = Buffer.from(command.input.CiphertextBlob!);
          return { Plaintext: wrapped.get(blob.toString('hex')) };
        }
        throw new Error('unexpected command');
      },
    };
  }

  function memoryStore(): DataKeyStore & {
    rows: Map<string, { keyRef: string; wrappedKey: Buffer }>;
  } {
    const rows = new Map<string, { keyRef: string; wrappedKey: Buffer }>();
    return {
      rows,
      find: async (tenantId) => rows.get(tenantId) ?? null,
      save: async (tenantId, key) => void rows.set(tenantId, key),
    };
  }

  it('generates a data key once, stores it wrapped and caches the plaintext', async () => {
    const kms = fakeKms();
    const store = memoryStore();
    const cipher = new FieldCipher(new KmsDataKeyProvider(kms as never, 'arn:test:key', store));
    const stored = await cipher.encrypt(TENANT_A, pan, at);
    expect(await cipher.decrypt(TENANT_A, stored, at)).toBe(pan);
    expect(kms.calls).toEqual(['generate']);
    expect(store.rows.get(TENANT_A)?.wrappedKey).toHaveLength(16);
  });

  it('unwraps the stored key after a restart', async () => {
    const kms = fakeKms();
    const store = memoryStore();
    const before = new FieldCipher(new KmsDataKeyProvider(kms as never, 'arn:test:key', store));
    const stored = await before.encrypt(TENANT_A, pan, at);
    const after = new FieldCipher(new KmsDataKeyProvider(kms as never, 'arn:test:key', store));
    expect(await after.decrypt(TENANT_A, stored, at)).toBe(pan);
    expect(kms.calls).toEqual(['generate', 'decrypt']);
  });
});
