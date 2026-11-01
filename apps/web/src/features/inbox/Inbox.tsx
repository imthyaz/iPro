import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import type {
  ApprovalCard,
  DocumentView,
  MyPolicyView,
  MyTaskView,
  NotificationView,
} from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { useMe } from '../../auth.js';
import { useOnboarding } from '../onboarding/Onboarding.js';
import {
  ChangeList,
  Chip,
  DueChip,
  Empty,
  Field,
  formatDate,
  Note,
} from '../../design-system/index.js';

/**
 * Home is the Action inbox: approvals waiting on me, my checklist tasks and policies to accept. Each
 * card carries what is needed to act without opening anything else.
 */
export function Inbox() {
  const me = useMe().data;
  const approvals = useQuery({
    queryKey: ['approvals'],
    queryFn: () => api<ApprovalCard[]>('/approvals'),
  });
  const tasks = useQuery({
    queryKey: ['my-tasks'],
    queryFn: () => api<MyTaskView[]>('/checklist-tasks/mine'),
  });
  const policies = useQuery({
    queryKey: ['my-policies'],
    queryFn: () => api<MyPolicyView[]>('/policies/mine'),
    enabled: Boolean(me?.personId),
  });
  const onboarding = useOnboarding(Boolean(me?.personId));
  const pendingPolicies = policies.data?.filter((p) => p.pending) ?? [];
  const loaded = approvals.data && tasks.data && (!me?.personId || policies.data);
  const nothing =
    loaded &&
    approvals.data!.length === 0 &&
    tasks.data!.length === 0 &&
    pendingPolicies.length === 0;

  return (
    <main className="page">
      <h1>Action inbox</h1>
      {onboarding.data && (
        <Link className="card onboarding-link" to="/onboarding">
          <strong>Your onboarding</strong>
          <span className="muted">
            First day {formatDate(onboarding.data.joiningDate)}: see what to do before you join
          </span>
        </Link>
      )}
      {nothing && <Empty>You’re all caught up.</Empty>}

      {approvals.error && <Note kind="error">{errorMessage(approvals.error)}</Note>}
      {Boolean(approvals.data?.length) && (
        <section aria-labelledby="inbox-approvals">
          <h2 id="inbox-approvals">Approvals ({approvals.data!.length})</h2>
          <ul className="cards" aria-label="Approvals">
            {approvals.data!.map((card) => (
              <Approval key={card.approvalId} card={card} />
            ))}
          </ul>
        </section>
      )}

      {pendingPolicies.length > 0 && (
        <section aria-labelledby="inbox-policies">
          <h2 id="inbox-policies">Policies to accept ({pendingPolicies.length})</h2>
          <ul className="cards" aria-label="Policies to accept">
            {pendingPolicies.map((p) => (
              <li key={p.policyId} className="card" aria-label={p.title}>
                <strong>{p.title}</strong>
                <span className="muted">
                  Version {p.current.version}, in force from {formatDate(p.current.effectiveFrom)}
                </span>
                <Link className="button" to="/policies">
                  Read and accept
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tasks.error && <Note kind="error">{errorMessage(tasks.error)}</Note>}
      {Boolean(tasks.data?.length) && (
        <section aria-labelledby="inbox-tasks">
          <h2 id="inbox-tasks">Tasks ({tasks.data!.length})</h2>
          <ul className="cards" aria-label="Tasks">
            {tasks.data!.map((task) => (
              <Task key={task.id} task={task} />
            ))}
          </ul>
        </section>
      )}

      <Notifications />
    </main>
  );
}

function Approval({ card }: { card: ApprovalCard }) {
  const client = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');
  const done = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['approvals'] }),
      client.invalidateQueries({ queryKey: ['requests'] }),
    ]);
  const approve = useMutation({
    mutationFn: () => api(`/approvals/${card.approvalId}/approve`, { body: {} }),
    onSuccess: done,
  });
  const reject = useMutation({
    mutationFn: () => api(`/approvals/${card.approvalId}/reject`, { body: { comment } }),
    onSuccess: done,
  });
  const busy = approve.isPending || reject.isPending;
  const error = approve.error ?? reject.error;

  return (
    <li className="card" aria-label={`${card.title} for ${card.subject.name}`}>
      <div className="card-head">
        <strong>{card.title}</strong>
        <DueChip dueOn={card.dueOn} overdue={card.overdue} />
      </div>
      <span className="muted">
        {card.stepLabel} · for {card.subject.name} · asked by {card.submittedBy} on{' '}
        {formatDate(card.submittedAt)}
      </span>
      {(card.escalated || card.onBehalfOf) && (
        <span>
          {card.escalated && <Chip tone="warn">Escalated to you</Chip>}{' '}
          {card.onBehalfOf && <Chip tone="info">On behalf of {card.onBehalfOf}</Chip>}
        </span>
      )}
      <ChangeList changes={card.changes} />
      {rejecting ? (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            reject.mutate();
          }}
        >
          <Field label="Why are you returning it?" hint="The requester sees this comment.">
            {(id) => (
              <textarea
                id={id}
                required
                rows={2}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            )}
          </Field>
          <div className="form-actions">
            <button className="button button-primary" disabled={busy || !comment.trim()}>
              Return to requester
            </button>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => setRejecting(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="form-actions">
          <button
            className="button button-primary"
            disabled={busy}
            onClick={() => approve.mutate()}
          >
            Approve
          </button>
          <button className="button" disabled={busy} onClick={() => setRejecting(true)}>
            Reject…
          </button>
          <Link className="button button-quiet" to={`/requests/${card.instanceId}`}>
            Details
          </Link>
        </div>
      )}
      {error && <Note kind="error">{errorMessage(error)}</Note>}
    </li>
  );
}

export function Task({ task }: { task: MyTaskView }) {
  const client = useQueryClient();
  const [evidence, setEvidence] = useState('');
  const documents = useQuery({
    queryKey: ['documents', task.person.personId],
    queryFn: () => api<DocumentView[]>(`/people/${task.person.personId}/documents`),
    enabled: task.requiresDocument,
  });
  const complete = useMutation({
    mutationFn: () =>
      api(`/checklist-tasks/${task.id}/done`, {
        body: evidence ? { evidenceDocumentId: evidence } : {},
      }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['my-tasks'] }),
        client.invalidateQueries({ queryKey: ['onboarding'] }),
      ]),
  });
  return (
    <li className="card" aria-label={task.title}>
      <div className="card-head">
        <strong>{task.title}</strong>
        <DueChip dueOn={task.dueOn} overdue={task.overdue} />
      </div>
      <span className="muted">
        {task.checklist} · {task.person.name}
        {task.mandatory ? '' : ' · optional'}
      </span>
      {task.requiresDocument && (
        <Field label="Document" hint="This task needs one of the person’s documents.">
          {(id) => (
            <select id={id} value={evidence} onChange={(e) => setEvidence(e.target.value)}>
              <option value="">Choose a document</option>
              {documents.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title} (v{d.version})
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <div className="form-actions">
        <button
          className="button button-primary"
          disabled={complete.isPending || (task.requiresDocument && !evidence)}
          onClick={() => complete.mutate()}
        >
          Mark done
        </button>
      </div>
      {documents.error && (
        <Note kind="error">You can’t see this person’s documents; ask HR to mark it done.</Note>
      )}
      {complete.error && <Note kind="error">{errorMessage(complete.error)}</Note>}
    </li>
  );
}

/** Recent updates (returned, approved, reminders); Teams and email delivery come in slice 11. */
function Notifications() {
  const client = useQueryClient();
  const notes = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<NotificationView[]>('/notifications'),
  });
  const read = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const unread = notes.data?.filter((n) => !n.read) ?? [];
  if (unread.length === 0) return null;
  return (
    <section aria-labelledby="inbox-updates">
      <h2 id="inbox-updates">Updates ({unread.length})</h2>
      <ul className="rows" aria-label="Updates">
        {unread.map((n) => (
          <li key={n.id} className="row">
            <span className="row-main">
              {n.link ? (
                <Link to={n.link} onClick={() => read.mutate(n.id)}>
                  {n.title}
                </Link>
              ) : (
                <span>{n.title}</span>
              )}
              <span className="muted">{formatDate(n.createdAt)}</span>
            </span>
            <button className="button button-quiet" onClick={() => read.mutate(n.id)}>
              Dismiss
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
