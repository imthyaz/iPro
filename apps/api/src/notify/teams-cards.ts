import type { ApprovalCard } from '@ipro/shared';

/**
 * Adaptive Cards for Teams (decision #87). Approval cards carry the same context as the in-app card
 * (CLAUDE.md: decide on the card) and two Universal Actions (Action.Execute): approve, and reject
 * with a comment. The bot answers an action by replacing the card with the outcome.
 */
export type AdaptiveCard = Record<string, unknown> & { type: 'AdaptiveCard' };

const card = (body: unknown[], actions: unknown[] = []): AdaptiveCard => ({
  type: 'AdaptiveCard',
  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
  version: '1.4',
  body,
  ...(actions.length ? { actions } : {}),
});

const text = (value: string, extra: Record<string, unknown> = {}) => ({
  type: 'TextBlock',
  text: value,
  wrap: true,
  ...extra,
});

const open = (title: string, appUrl: string, link: string) => ({
  type: 'Action.OpenUrl',
  title,
  url: new URL(link, appUrl).toString(),
});

export const APPROVE_VERB = 'ipro.approve';
export const REJECT_VERB = 'ipro.reject';

const shortDate = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));

/** The approval card, with the change lines as facts and Approve / Reject when it can be decided. */
export function approvalCard(c: ApprovalCard, appUrl: string): AdaptiveCard {
  const facts = c.changes.map((l) => ({
    title: l.label,
    value: l.from ? `${l.from} → ${l.to}` : l.to,
  }));
  const body: unknown[] = [
    text(c.title, { weight: 'Bolder', size: 'Medium' }),
    text(
      `${c.stepLabel} · for ${c.subject.name} · asked by ${c.submittedBy} · due ${shortDate(c.dueOn)}${
        c.overdue ? ' (overdue)' : ''
      }`,
      { isSubtle: true, spacing: 'None' },
    ),
  ];
  if (c.onBehalfOf) body.push(text(`On behalf of ${c.onBehalfOf}`, { isSubtle: true }));
  if (facts.length) body.push({ type: 'FactSet', facts });
  if (c.waitingFor)
    body.push(text(`${c.waitingFor}. It can still be returned.`, { color: 'Warning' }));
  const actions: unknown[] = [];
  if (!c.waitingFor) {
    actions.push({
      type: 'Action.Execute',
      title: 'Approve',
      verb: APPROVE_VERB,
      style: 'positive',
      data: { approvalId: c.approvalId },
    });
  }
  actions.push({
    type: 'Action.ShowCard',
    title: 'Reject…',
    card: card(
      [
        {
          type: 'Input.Text',
          id: 'comment',
          label: 'Why are you returning it? The requester sees this comment.',
          isMultiline: true,
          isRequired: true,
          errorMessage: 'Add a comment for the requester',
          maxLength: 2000,
        },
      ],
      [
        {
          type: 'Action.Execute',
          title: 'Return to requester',
          verb: REJECT_VERB,
          data: { approvalId: c.approvalId },
        },
      ],
    ),
  });
  actions.push(
    open(c.link ? 'Open in iPro' : 'Details', appUrl, c.link ?? `/requests/${c.instanceId}`),
  );
  return card(body, actions);
}

/** What replaces an approval card once it is decided, or when an action can't be done. */
export function outcomeCard(title: string, outcome: string, appUrl: string): AdaptiveCard {
  return card(
    [text(title, { weight: 'Bolder' }), text(outcome, { spacing: 'Small' })],
    [open('Open the Action inbox', appUrl, '/')],
  );
}

/** Any other notification: its title and a link into iPro. */
export function noticeCard(title: string, link: string | null, appUrl: string): AdaptiveCard {
  return card([text(title)], [open('Open in iPro', appUrl, link ?? '/')]);
}
