import { describe, expect, it } from 'vitest';
import { compareManifests, type RestoreManifest } from './restore-check.js';

const manifest = (over: Partial<RestoreManifest> = {}): RestoreManifest => ({
  cutoff: '2026-11-25T08:00:00.000Z',
  takenAt: '2026-11-25T09:00:00.000Z',
  migrations: ['m1', 'm2'],
  tenants: {
    t1: { person: { rows: 3, idsHash: 'aaa' }, journal_event: { rows: 10, idsHash: 'bbb' } },
  },
  ...over,
});

describe('compareManifests (decision #98)', () => {
  it('finds nothing when the restore matches', () => {
    expect(compareManifests(manifest(), manifest({ takenAt: 'later' }))).toEqual([]);
  });

  it('names missing rows, changed rows, extra rows, missing tenants and migrations', () => {
    const restored = manifest({
      migrations: ['m1'],
      tenants: {
        t1: {
          person: { rows: 2, idsHash: 'zzz' },
          journal_event: { rows: 10, idsHash: 'ccc' },
          audit_log: { rows: 1, idsHash: 'ddd' },
        },
        t2: {},
      },
    });
    expect(compareManifests(manifest(), restored)).toEqual([
      '1 migration(s) missing from the restored database',
      'Tenant t1: person has 2 rows (expected 3)',
      'Tenant t1: journal_event has the same count but different rows',
      "Tenant t1: audit_log has rows the source didn't",
      "Tenant t2 wasn't in the source",
    ]);
    expect(compareManifests(manifest(), manifest({ tenants: {} }))).toEqual([
      'Tenant t1 is missing',
    ]);
  });

  it('refuses to compare manifests taken with different cut-offs', () => {
    expect(compareManifests(manifest(), manifest({ cutoff: '2026-11-25T08:05:00.000Z' }))).toEqual([
      'Cut-offs differ: 2026-11-25T08:00:00.000Z and 2026-11-25T08:05:00.000Z',
    ]);
  });
});
