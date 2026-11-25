import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { compareManifests, takeManifest, type RestoreManifest } from './restore-check.js';

/**
 * Restore verification from the command line (docs/runbooks/backup-restore.md; decision #98).
 *
 *   Before:  DATABASE_URL=<source> pnpm --filter @ipro/api ops:restore-check manifest \
 *              --cutoff 2026-11-25T08:00:00Z --out source.json
 *   After:   DATABASE_URL=<restored> pnpm --filter @ipro/api ops:restore-check verify \
 *              --manifest source.json
 *
 * Prints counts and table names only; exits 1 when the restored database doesn't match.
 */
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    cutoff: { type: 'string' },
    out: { type: 'string' },
    manifest: { type: 'string' },
  },
});
const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL to the database to read');

const total = (m: RestoreManifest) =>
  Object.values(m.tenants).reduce(
    (sum, tables) => sum + Object.values(tables).reduce((n, t) => n + t.rows, 0),
    0,
  );

switch (positionals[0]) {
  case 'manifest': {
    const cutoff = new Date(values.cutoff ?? '');
    if (Number.isNaN(cutoff.getTime())) throw new Error('--cutoff must be an ISO date-time');
    const manifest = await takeManifest(url, cutoff);
    writeFileSync(values.out ?? 'restore-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(
      `Manifest: ${Object.keys(manifest.tenants).length} tenant(s), ${total(manifest)} rows created by ${manifest.cutoff}, ${manifest.migrations.length} migrations\n`,
    );
    break;
  }
  case 'verify': {
    if (!values.manifest) throw new Error('--manifest is required');
    const source = JSON.parse(readFileSync(values.manifest, 'utf8')) as RestoreManifest;
    const restored = await takeManifest(url, new Date(source.cutoff));
    const problems = compareManifests(source, restored);
    if (problems.length === 0) {
      process.stdout.write(
        `Restore verified: ${total(restored)} rows in ${Object.keys(restored.tenants).length} tenant(s) match the source up to ${source.cutoff}\n`,
      );
    } else {
      process.stdout.write(`Restore does NOT match (${problems.length}):\n`);
      for (const p of problems) process.stdout.write(`- ${p}\n`);
      process.exitCode = 1;
    }
    break;
  }
  default:
    throw new Error(
      'Usage: restore-check manifest --cutoff <ISO> [--out file] | verify --manifest <file>',
    );
}
