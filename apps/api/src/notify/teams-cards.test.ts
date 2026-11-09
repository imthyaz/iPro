import type { ApprovalCard } from '@ipro/shared';
import { describe, expect, it } from 'vitest';
import { APPROVE_VERB, approvalCard, noticeCard, REJECT_VERB } from './teams-cards.js';

const base: ApprovalCard = {
  approvalId: '00000000-0000-4000-8000-0000000000a1',
  instanceId: '00000000-0000-4000-8000-0000000000b1',
  key: 'leave_request',
  title: 'Leave: Anbu Arasu',
  stepLabel: 'Manager approval',
  subject: { personId: '00000000-0000-4000-8000-0000000000c1', name: 'Anbu Arasu' },
  submittedBy: 'Anbu Arasu',
  submittedAt: '2026-11-09T04:00:00.000Z',
  dueOn: '2026-11-12',
  overdue: false,
  escalated: false,
  onBehalfOf: null,
  changes: [
    { label: 'Leave', from: null, to: 'Casual leave, 20 Nov 2026 (1 day)' },
    { label: 'Casual leave balance', from: '5', to: '4' },
    { label: 'Also off', from: null, to: 'No one else in the team (4 people)' },
    { label: 'Policy', from: null, to: 'Planned, 11 days ahead' },
  ],
  waitingFor: null,
  link: null,
  bulk: true,
};

const json = (x: unknown) => JSON.stringify(x);

describe('Teams approval cards (decision #87)', () => {
  it('carry the in-app card’s context: balance after, who else is off, policy fit', () => {
    const c = approvalCard(base, 'https://ipro.example.test');
    const facts = (c.body as { type: string; facts?: { title: string; value: string }[] }[]).find(
      (b) => b.type === 'FactSet',
    )!.facts!;
    expect(facts).toEqual([
      { title: 'Leave', value: 'Casual leave, 20 Nov 2026 (1 day)' },
      { title: 'Casual leave balance', value: '5 → 4' },
      { title: 'Also off', value: 'No one else in the team (4 people)' },
      { title: 'Policy', value: 'Planned, 11 days ahead' },
    ]);
    expect(json(c)).toContain('due 12 Nov 2026');
  });

  it('approve, and reject with a required comment, act on this approval', () => {
    const c = approvalCard(base, 'https://ipro.example.test');
    const s = json(c);
    expect(s).toContain(
      `"verb":"${APPROVE_VERB}","style":"positive","data":{"approvalId":"${base.approvalId}"}`,
    );
    expect(s).toContain(`"verb":"${REJECT_VERB}","data":{"approvalId":"${base.approvalId}"}`);
    expect(s).toContain('"id":"comment"');
    expect(s).toContain('"isRequired":true');
    expect(s).toContain(`https://ipro.example.test/requests/${base.instanceId}`);
  });

  it('a card waiting for something can only be returned', () => {
    const c = approvalCard(
      { ...base, waitingFor: 'Waiting for a medical certificate' },
      'https://ipro.example.test',
    );
    expect(json(c)).not.toContain(APPROVE_VERB);
    expect(json(c)).toContain('Waiting for a medical certificate. It can still be returned.');
  });

  it('other notifications link into iPro', () => {
    expect(
      json(noticeCard('Approved: Leave', '/requests/x', 'https://ipro.example.test/')),
    ).toContain('https://ipro.example.test/requests/x');
  });
});
