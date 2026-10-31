import { describe, expect, it } from 'vitest';
import { businessDate } from '../common/effective-dating.js';
import {
  delegationProblems,
  effectiveApprovers,
  type DelegationFacts,
} from './delegation-rules.js';

const request = {
  delegatorUserId: 'mgr-a',
  delegateUserId: 'mgr-b',
  startsOn: '2026-11-10',
  endsOn: '2026-11-14',
};
const facts: DelegationFacts = {
  delegatorIsManager: true,
  delegateIsManager: true,
  existing: [],
  today: '2026-11-02',
};

describe('delegationProblems', () => {
  it('accepts a manager delegating to another manager for a future range', () => {
    expect(delegationProblems(request, facts)).toEqual([]);
  });

  it('rejects bad ranges, self-delegation and non-managers', () => {
    expect(delegationProblems({ ...request, endsOn: '2026-11-09' }, facts)).toContain(
      'End date is before start date',
    );
    expect(
      delegationProblems({ ...request, startsOn: '2026-10-01', endsOn: '2026-10-05' }, facts),
    ).toContain('Delegation is entirely in the past');
    expect(delegationProblems({ ...request, delegateUserId: 'mgr-a' }, facts)).toContain(
      'Cannot delegate to yourself',
    );
    expect(delegationProblems(request, { ...facts, delegatorIsManager: false })).toContain(
      'Only managers delegate approvals',
    );
    expect(delegationProblems(request, { ...facts, delegateIsManager: false })).toContain(
      'Approvals can only be delegated to another manager',
    );
  });

  it('rejects overlap with an active delegation but ignores revoked ones', () => {
    const existing = { ...request, startsOn: '2026-11-14', endsOn: '2026-11-20' };
    expect(delegationProblems(request, { ...facts, existing: [existing] })).toContain(
      'Overlaps an existing delegation',
    );
    expect(
      delegationProblems(request, { ...facts, existing: [{ ...existing, revokedAt: new Date() }] }),
    ).toEqual([]);
  });
});

describe('effectiveApprovers', () => {
  const delegations = [
    request,
    {
      delegatorUserId: 'mgr-b',
      delegateUserId: 'mgr-c',
      startsOn: '2026-11-01',
      endsOn: '2026-11-30',
    },
  ];

  it('adds the delegate inside the range only', () => {
    expect(effectiveApprovers('mgr-a', '2026-11-10', delegations)).toEqual(['mgr-a', 'mgr-b']);
    expect(effectiveApprovers('mgr-a', '2026-11-14', delegations)).toEqual(['mgr-a', 'mgr-b']);
    expect(effectiveApprovers('mgr-a', '2026-11-15', delegations)).toEqual(['mgr-a']);
    expect(effectiveApprovers('mgr-a', '2026-11-09', delegations)).toEqual(['mgr-a']);
  });

  it('does not follow chains', () => {
    expect(effectiveApprovers('mgr-a', '2026-11-12', delegations)).not.toContain('mgr-c');
  });

  it('ignores revoked delegations', () => {
    expect(
      effectiveApprovers('mgr-a', '2026-11-12', [{ ...request, revokedAt: new Date() }]),
    ).toEqual(['mgr-a']);
  });
});

describe('businessDate', () => {
  it('uses the India date, not UTC', () => {
    expect(businessDate(new Date('2026-11-01T19:00:00Z'))).toBe('2026-11-02');
    expect(businessDate(new Date('2026-11-01T18:00:00Z'))).toBe('2026-11-01');
  });
});
