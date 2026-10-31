import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DataKeyProvider } from './key-providers.js';

/**
 * Binds a ciphertext to where it lives, so a value copied into another row or column fails to decrypt.
 * Use the table, column and record id.
 */
export interface FieldLocation {
  table: string;
  column: string;
  recordId: string;
}

const VERSION = 'v1';

/**
 * Field-level envelope encryption for KYC and compensation (AES-256-GCM with the tenant's data key).
 * Stored format: `v1.<keyRef>.<iv>.<tag>.<ciphertext>`, base64url parts. Plaintext never reaches logs.
 */
export class FieldCipher {
  constructor(private readonly keys: DataKeyProvider) {}

  async encrypt(tenantId: string, plaintext: string, at: FieldLocation): Promise<string> {
    const { keyRef, key } = await this.keys.dataKey(tenantId);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(tenantId, at));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      VERSION,
      Buffer.from(keyRef).toString('base64url'),
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  async decrypt(tenantId: string, stored: string, at: FieldLocation): Promise<string> {
    const [version, , iv, tag, ciphertext, ...rest] = stored.split('.');
    if (version !== VERSION || !iv || !tag || ciphertext === undefined || rest.length > 0) {
      throw new Error('Unrecognised encrypted value');
    }
    const { key } = await this.keys.dataKey(tenantId);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(aad(tenantId, at));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

function aad(tenantId: string, at: FieldLocation): Buffer {
  return Buffer.from(JSON.stringify([tenantId, at.table, at.column, at.recordId]));
}
