import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://ipro:ipro@localhost:5432/ipro' });
    expect(config.PORT).toBe(3000);
    expect(config.JOBS_ENABLED).toBe(true);
  });

  it('names a missing setting without echoing values', () => {
    expect(() => loadConfig({ PORT: '3000' })).toThrow('Invalid configuration: DATABASE_URL');
  });

  it('rejects a non-Postgres database URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://secret@localhost/ipro' })).toThrow(
      /^Invalid configuration: DATABASE_URL$/,
    );
  });
});
