import { loadConfig } from '../config.js';
import { runMigrations } from './migrate.js';
import { pgSsl } from './pg-options.js';

// The API image's migrate container: `node dist/db/migrate-cli.js` (decision #100).
const config = loadConfig();
const added = await runMigrations(config.DATABASE_URL, pgSsl(config), {
  id: config.TENANT_ID,
  name: process.env.TENANT_NAME ?? 'Ideassion',
});
process.stdout.write(`Migrations: ${added} applied\n`);
