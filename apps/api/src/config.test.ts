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

describe('Ask iPro model ids (slice 12 done-when #5: India-only routing)', () => {
  const india = {
    LLM_PROVIDER: 'bedrock',
    BEDROCK_MODEL_LOOKUP: 'in.anthropic.claude-haiku-test',
    BEDROCK_MODEL_REASONING: 'in.anthropic.claude-sonnet-test',
  };

  it('accepts only India inference-profile ids (in.)', () => {
    expect(loadConfig({ ...base, ...india }).BEDROCK_MODEL_LOOKUP).toBe(
      'in.anthropic.claude-haiku-test',
    );
  });

  it.each([
    ['a global profile', 'global.anthropic.claude-haiku-test'],
    ['an APAC profile', 'apac.anthropic.claude-haiku-test'],
    ['a US profile', 'us.anthropic.claude-haiku-test'],
    ['a base model id', 'anthropic.claude-haiku-test'],
    ['an ARN', 'arn:aws:bedrock:ap-south-1:123:inference-profile/global.x'],
  ])('refuses %s, which could route data outside India', (_name, id) => {
    expect(() => loadConfig({ ...base, ...india, BEDROCK_MODEL_LOOKUP: id })).toThrow(
      'Invalid configuration: BEDROCK_MODEL_LOOKUP',
    );
    expect(() => loadConfig({ ...base, ...india, BEDROCK_MODEL_REASONING: id })).toThrow(
      'Invalid configuration: BEDROCK_MODEL_REASONING',
    );
  });

  it('refuses a non-India id even while Bedrock is off', () => {
    expect(() =>
      loadConfig({ ...base, BEDROCK_MODEL_LOOKUP: 'global.anthropic.claude-haiku-test' }),
    ).toThrow('Invalid configuration: BEDROCK_MODEL_LOOKUP');
  });

  it('needs both model ids to use Bedrock, and never the scripted model in production', () => {
    expect(() => loadConfig({ ...base, LLM_PROVIDER: 'bedrock' })).toThrow(
      'Invalid configuration: BEDROCK_MODEL_LOOKUP, BEDROCK_MODEL_REASONING',
    );
    expect(loadConfig(base).LLM_PROVIDER).toBe('fake');
  });
});
