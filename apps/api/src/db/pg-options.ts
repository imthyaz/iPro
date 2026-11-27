import { readFileSync } from 'node:fs';
import type { AppConfig } from '../config.js';

/**
 * TLS options for node-postgres and pg-boss (decision #100): none locally; on AWS the server's
 * certificate must chain to the RDS CA bundle shipped in the image.
 */
export function pgSsl(
  config: Pick<AppConfig, 'DATABASE_SSL'> & { DATABASE_SSL_CA_FILE?: string | undefined },
): false | { rejectUnauthorized: true; ca: string } {
  if (config.DATABASE_SSL === 'off') return false;
  return { rejectUnauthorized: true, ca: readFileSync(config.DATABASE_SSL_CA_FILE!, 'utf8') };
}
