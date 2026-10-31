import { describe, expect, it } from 'vitest';
import { decisionCapacity, nextStepIndex, type OpenApproval } from './engine-rules.js';

const step = (id: string, when?: { field: string; equals: boolean | string | number }) => ({
  id,
  label: id,
  approver: { kind: 'manager' as const },
  authorize: { area: 'leave', action: 'approve' },
  ...(when ? { when } : {}),
});

describe('nextStepIndex', () => {
  const steps = [
    step('manager'),
    step('hr_head', { field: 'aboveBand', equals: true }),
    step('hr'),
  ];

  it('runs conditional steps only when the payload matches', () => {
    expect(nextStepIndex(steps, 1, { aboveBand: true })).toBe(1);
    expect(nextStepIndex(steps, 1, { aboveBand: false })).toBe(2);
    expect(nextStepIndex(steps, 1, {})).toBe(2);
  });

  it('returns -1 when no step is left', () => {
    expect(nextStepIndex(steps, 3, {})).toBe(-1);
  });
});

describe('decisionCapacity', () => {
  const ENTITY = 'le-1';
  const toUser: OpenApproval = {
    assignedUserId: 'mgr',
    assignedRole: null,
    assignedLegalEntityId: ENTITY,
    escalatedToUserId: null,
    escalatedToRole: null,
  };
  const toRole: OpenApproval = { ...toUser, assignedUserId: null, assignedRole: 'hr' };
  const user = (userId: string, ...roles: [string, string | null][]) => ({
    userId,
    roles: roles.map(([role, legalEntityId]) => ({ role: role as 'hr', legalEntityId })),
  });

  it('the assigned approver decides', () => {
    expect(decisionCapacity(toUser, user('mgr', ['manager', null]), 'emp', [])).toEqual({
      as: 'approver',
    });
  });

  it('a delegate decides on behalf of the approver', () => {
    expect(decisionCapacity(toUser, user('mgr2', ['manager', null]), 'emp', ['mgr'])).toEqual({
      as: 'delegate',
      onBehalfOf: 'mgr',
    });
    expect(decisionCapacity(toUser, user('mgr2', ['manager', null]), 'emp', [])).toBeNull();
  });

  it('a role step is open to holders of the role in that legal entity', () => {
    expect(decisionCapacity(toRole, user('hr1', ['hr', ENTITY]), 'emp', [])).toEqual({
      as: 'approver',
    });
    expect(decisionCapacity(toRole, user('hr2', ['hr', null]), 'emp', [])).toEqual({
      as: 'approver',
    });
    expect(decisionCapacity(toRole, user('hr3', ['hr', 'le-2']), 'emp', [])).toBeNull();
    expect(decisionCapacity(toRole, user('mgr', ['manager', null]), 'emp', [])).toBeNull();
  });

  it('after escalation the escalated-to user (or role) can decide too', () => {
    const escalated = { ...toUser, escalatedToUserId: 'boss' };
    expect(decisionCapacity(escalated, user('boss', ['manager', null]), 'emp', [])).toEqual({
      as: 'approver',
    });
    expect(decisionCapacity(escalated, user('mgr', ['manager', null]), 'emp', [])).toEqual({
      as: 'approver',
    });
    const toHrHead = { ...toRole, escalatedToRole: 'hr_head' as const };
    expect(decisionCapacity(toHrHead, user('head', ['hr_head', null]), 'emp', [])).toEqual({
      as: 'approver',
    });
  });

  it('nobody decides their own request, even holding the role', () => {
    expect(decisionCapacity(toRole, user('hr1', ['hr', null]), 'hr1', [])).toBeNull();
    expect(decisionCapacity(toUser, user('mgr', ['manager', null]), 'mgr', [])).toBeNull();
  });
});
