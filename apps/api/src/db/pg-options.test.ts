import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pgSsl } from './pg-options.js';

describe('pgSsl (decision #100)', () => {
  it('is off locally', () => {
    expect(pgSsl({ DATABASE_SSL: 'off' })).toBe(false);
  });

  it('verifies the server against the given CA bundle', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ca-')), 'bundle.pem');
    writeFileSync(file, '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n');
    expect(pgSsl({ DATABASE_SSL: 'verify', DATABASE_SSL_CA_FILE: file })).toEqual({
      rejectUnauthorized: true,
      ca: '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n',
    });
  });
});
