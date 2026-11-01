import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { WorkflowView } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import {
  ChangeList,
  Chip,
  Empty,
  Field,
  formatDate,
  ListDetail,
  Note,
  RequestStatusChip,
} from '../../design-system/index.js';

/** My requests: what I asked for and where each one is, with the request in the side panel. */
export function Requests() {
  const { requestId } = useParams();
  const navigate = useNavigate();
  const requests = useQuery({
    queryKey: ['requests'],
    queryFn: () => api<WorkflowView[]>('/workflows'),
  });

  const list = (
    <>
      <h1>My requests</h1>
      {requests.error && <Note kind="error">{errorMessage(requests.error)}</Note>}
      {requests.data?.length === 0 && <Empty>You haven’t asked for anything yet.</Empty>}
      <ul className="rows" aria-label="Requests">
        {requests.data?.map((r) => (
          <li key={r.id}>
            <Link
              to={`/requests/${r.id}`}
              className={r.id === requestId ? 'row row-selected' : 'row'}
              aria-current={r.id === requestId ? 'true' : undefined}
            >
              <span className="row-main">
                <strong>{r.title}</strong>
                <span className="muted">
                  For {r.subject.name} · {formatDate(r.submittedAt)}
                </span>
              </span>
              <span className="row-side">
                <RequestStatusChip status={r.status} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );

  return (
    <ListDetail
      list={list}
      detail={requestId ? <RequestDetail requestId={requestId} /> : null}
      onClose={() => navigate('/requests')}
      detailLabel="Request"
    />
  );
}

/** One request: its steps, decisions and comments, and what I can do now. */
export function RequestDetail({ requestId }: { requestId: string }) {
  const client = useQueryClient();
  const [comment, setComment] = useState('');
  const request = useQuery({
    queryKey: ['request', requestId],
    queryFn: () => api<WorkflowView>(`/workflows/${requestId}`),
  });
  const refresh = (view: WorkflowView) => {
    client.setQueryData(['request', requestId], view);
    return client.invalidateQueries({ queryKey: ['requests'] });
  };
  const addComment = useMutation({
    mutationFn: () =>
      api<WorkflowView>(`/workflows/${requestId}/comments`, { body: { body: comment } }),
    onSuccess: (view) => {
      setComment('');
      return refresh(view);
    },
  });
  const withdraw = useMutation({
    mutationFn: () => api<WorkflowView>(`/workflows/${requestId}/withdraw`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const resubmit = useMutation({
    mutationFn: () => api<WorkflowView>(`/workflows/${requestId}/resubmit`, { body: {} }),
    onSuccess: refresh,
  });

  if (request.error) return <Note kind="error">{errorMessage(request.error)}</Note>;
  if (!request.data) return <p className="muted">Loading…</p>;
  const r = request.data;
  const error = addComment.error ?? withdraw.error ?? resubmit.error;

  return (
    <article className="record">
      <header className="record-header">
        <h2>{r.title}</h2>
        <p className="muted">
          For {r.subject.name} · asked by {r.submittedBy.name} on {formatDate(r.submittedAt)}
        </p>
        <p>
          <RequestStatusChip status={r.status} />
        </p>
      </header>
      <ChangeList changes={r.changes} />

      <h3>Steps</h3>
      <ol className="timeline" aria-label="Steps">
        {r.steps.map((s) => (
          <li key={s.approvalId}>
            <strong>{s.label}</strong> · {s.escalatedTo ?? s.assignedTo}{' '}
            {s.decision === 'approved' && <Chip tone="ok">Approved</Chip>}
            {s.decision === 'rejected' && <Chip tone="warn">Returned</Chip>}
            {!s.decision && !s.closed && <Chip tone="info">Due {formatDate(s.dueOn)}</Chip>}
            {s.escalatedTo && <Chip tone="warn">Escalated</Chip>}
            {s.decidedBy && (
              <div className="muted">
                {s.decidedBy}
                {s.onBehalfOf ? ` for ${s.onBehalfOf}` : ''} · {formatDate(s.decidedAt)}
                {s.comment ? ` · “${s.comment}”` : ''}
              </div>
            )}
          </li>
        ))}
      </ol>

      {(r.canWithdraw || r.canResubmit) && (
        <div className="form-actions">
          {r.canResubmit && (
            <button
              className="button button-primary"
              disabled={resubmit.isPending}
              onClick={() => resubmit.mutate()}
            >
              Send again
            </button>
          )}
          {r.canWithdraw && (
            <button
              className="button"
              disabled={withdraw.isPending}
              onClick={() => {
                if (window.confirm('Withdraw this request? This can’t be undone.'))
                  withdraw.mutate();
              }}
            >
              Withdraw
            </button>
          )}
        </div>
      )}

      <h3>Comments</h3>
      {r.comments.length === 0 ? (
        <Empty>No comments.</Empty>
      ) : (
        <ul className="plain" aria-label="Comments">
          {r.comments.map((c) => (
            <li key={c.id}>
              <strong>{c.author}</strong> <span className="muted">{formatDate(c.at)}</span>
              <div>{c.body}</div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          addComment.mutate();
        }}
      >
        <Field label="Add a comment">
          {(id) => (
            <textarea
              id={id}
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          )}
        </Field>
        <button className="button" disabled={addComment.isPending || !comment.trim()}>
          Comment
        </button>
      </form>
      {error && <Note kind="error">{errorMessage(error)}</Note>}
    </article>
  );
}
