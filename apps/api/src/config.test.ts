import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://ipro:ipro@localhost:5432/ipro',
  TENANT_ID: '00000000-0000-4000-8000-000000000001',
  LOCAL_FIELD_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('loadConfig', () => {
  it('applies defaults and uses dev sign-in when Entra is not configured', () => {
    const config = loadConfig(base);
    expect(config.PORT).toBe(3000);
    expect(config.JOBS_ENABLED).toBe(true);
    expect(config.AUTH_MODE).toBe('dev');
    expect(config.SESSION_IDLE_HOURS).toBe(12);
    expect(config.SESSION_MAX_DAYS).toBe(7);
  });

  it('names a missing setting without echoing values', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined })).toThrow(
      'Invalid configuration: DATABASE_URL',
    );
  });

  it('rejects a non-Postgres database URL', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: 'mysql://secret@localhost/ipro' })).toThrow(
      /^Invalid configuration: DATABASE_URL$/,
    );
  });

  it('switches to Entra when configured and requires the rest of the Entra settings', () => {
    expect(() => loadConfig({ ...base, ENTRA_TENANT_ID: 'tenant' })).toThrow(
      'Invalid configuration: ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, OIDC_REDIRECT_URI',
    );
    const config = loadConfig({
      ...base,
      ENTRA_TENANT_ID: 'tenant',
      ENTRA_CLIENT_ID: 'client',
      ENTRA_CLIENT_SECRET: 'secret',
      OIDC_REDIRECT_URI: 'https://ipro.example/api/auth/callback',
    });
    expect(config.AUTH_MODE).toBe('entra');
  });

  it('treats blank Entra settings as not configured', () => {
    expect(loadConfig({ ...base, ENTRA_TENANT_ID: '' }).AUTH_MODE).toBe('dev');
  });

  it('refuses dev sign-in and the local key provider in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      'Invalid configuration: ENTRA_TENANT_ID, FIELD_KEY_PROVIDER, ESIGN_PROVIDER',
    );
  });

  it('requires a 32-byte local field key', () => {
    expect(() => loadConfig({ ...base, LOCAL_FIELD_KEY: 'c2hvcnQ=' })).toThrow(
      'Invalid configuration: LOCAL_FIELD_KEY',
    );
  });
});
