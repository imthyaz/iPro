import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
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
import { TodayCard } from '../attendance/Attendance.js';
import { useOnboarding } from '../onboarding/Onboarding.js';
import { CheckInCard, useOpenCheckIns } from '../reviews/CheckIns.js';
import { useReviews } from '../reviews/Reviews.js';
import {
  ChangeList,
  Chip,
  DueChip,
  Empty,
  Field,
  formatDate,
  Note,
} from '../../design-system/index.js';
import {
  approveLater,
  dismissFailures,
  undo,
  usePendingApprovals,
  type PendingBatch,
} from './pending-approvals.js';

/** Policies have no due date; they sort after everything that has one. */
const NO_DUE = '9999-12-31';

/**
 * Home is the Action inbox (X3): everything waiting on me in one list, soonest due first, acted on
 * in place. Routine approvals can be selected and approved together; on a phone a card can be
 * swiped right to approve. Every approval waits 10 seconds before it is sent, so it can be undone.
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
  const reviews = useReviews();
  const checkIns = useOpenCheckIns();
  const pending = usePendingApprovals();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const queued = new Set(pending.batches.flatMap((b) => b.approvalIds));
  const cards = (approvals.data ?? []).filter((c) => !queued.has(c.approvalId));
  const routine = cards.filter((c) => c.bulk && !c.waitingFor);
  const chosen = routine.filter((c) => selected.has(c.approvalId));

  const items: { key: string; due: string; node: ReactNode }[] = [
    ...cards.map((card) => ({
      key: `a-${card.approvalId}`,
      due: card.dueOn,
      node: (
        <Approval
          card={card}
          selected={selected.has(card.approvalId)}
          onSelect={(on) => {
            const next = new Set(selected);
            if (on) next.add(card.approvalId);
            else next.delete(card.approvalId);
            setSelected(next);
          }}
        />
      ),
    })),
    ...(reviews.data ?? [])
      .filter((r) => r.canSubmit)
      .map((r) => ({
        key: `r-${r.id}`,
        due: r.dueOn,
        node: (
          <li
            className="card"
            aria-label={`${r.kind === 'probation' ? 'Probation review' : 'Internship assessment'}: ${r.person.name}`}
          >
            <div className="card-head">
              <strong>
                {r.kind === 'probation' ? 'Probation review' : 'Internship assessment'}:{' '}
                {r.person.name}
              </strong>
              <DueChip dueOn={r.dueOn} overdue={r.overdue} />
            </div>
            <span className="muted">
              {r.designation ?? '—'} · joined {formatDate(r.joiningDate)}
            </span>
            <Link className="button" to={`/reviews/${r.id}`}>
              Write the review
            </Link>
          </li>
        ),
      })),
    ...(checkIns.data ?? [])
      .filter((c) => c.canRecord)
      .map((c) => ({ key: `c-${c.id}`, due: c.dueOn, node: <CheckInCard checkIn={c} /> })),
    ...(tasks.data ?? []).map((task) => ({
      key: `t-${task.id}`,
      due: task.dueOn,
      node: <Task task={task} />,
    })),
    ...(policies.data ?? [])
      .filter((p) => p.pending)
      .map((p) => ({
        key: `p-${p.policyId}`,
        due: NO_DUE,
        node: (
          <li className="card" aria-label={p.title}>
            <strong>{p.title}</strong>
            <span className="muted">
              Version {p.current.version}, in force from {formatDate(p.current.effectiveFrom)}
            </span>
            <Link className="button" to="/policies">
              Read and accept
            </Link>
          </li>
        ),
      })),
  ].sort((x, y) => x.due.localeCompare(y.due) || x.key.localeCompare(y.key));

  const loaded = approvals.data && tasks.data && (!me?.personId || policies.data);
  const approveChosen = () => {
    approveLater(
      chosen.map((c) => ({ approvalId: c.approvalId, bulk: true, title: titleOf(c) })),
      chosen.length === 1
        ? `Approved: ${titleOf(chosen[0]!)}`
        : `Approved ${chosen.length} requests`,
    );
    setSelected(new Set());
  };

  return (
    <main className={`page${chosen.length > 0 || pending.batches.length > 0 ? ' has-bar' : ''}`}>
      <h1>Action inbox</h1>
      <TodayCard />
      {me?.personId && (
        <Link className="card quick-link" to="/leave?apply">
          <strong>Apply leave</strong>
          <span className="muted">See your balances and send a request</span>
        </Link>
      )}
      {me?.personId && (
        <Link className="card quick-link" to="/hybrid">
          <strong>Plan my week</strong>
          <span className="muted">Office, WFH or client site for next week</span>
        </Link>
      )}
      {onboarding.data && (
        <Link className="card onboarding-link" to="/onboarding">
          <strong>Your onboarding</strong>
          <span className="muted">
            First day {formatDate(onboarding.data.joiningDate)}: see what to do before you join
          </span>
        </Link>
      )}

      {approvals.error && <Note kind="error">{errorMessage(approvals.error)}</Note>}
      {tasks.error && <Note kind="error">{errorMessage(tasks.error)}</Note>}
      {pending.failures.length > 0 && (
        <div className="note note-error failures" role="alert">
          <strong>
            {pending.failures.length === 1
              ? 'One approval didn’t go through'
              : `${pending.failures.length} approvals didn’t go through`}
          </strong>
          <ul>
            {pending.failures.map((f) => (
              <li key={f.approvalId}>
                {f.title}: {f.message}
              </li>
            ))}
          </ul>
          <button className="button button-quiet" onClick={dismissFailures}>
            Dismiss
          </button>
        </div>
      )}
      {loaded && items.length === 0 && <Empty>You’re all caught up.</Empty>}

      {items.length > 0 && (
        <section aria-labelledby="inbox-waiting">
          <div className="section-head">
            <h2 id="inbox-waiting">Waiting on you ({items.length})</h2>
            {routine.length > 1 &&
              (chosen.length === routine.length ? (
                <button className="button button-quiet" onClick={() => setSelected(new Set())}>
                  Clear selection
                </button>
              ) : (
                <button
                  className="button button-quiet"
                  onClick={() => setSelected(new Set(routine.map((c) => c.approvalId)))}
                >
                  Select all routine ({routine.length})
                </button>
              ))}
          </div>
          {routine.length > 0 && (
            <p className="muted swipe-tip">
              Leave, comp-off, regularisation and hybrid requests can be approved together. On a
              phone, swipe a card right to approve it.
            </p>
          )}
          <ul className="cards" aria-label="Waiting on you">
            {items.map((item) => (
              <Fragment key={item.key}>{item.node}</Fragment>
            ))}
          </ul>
        </section>
      )}

      <Notifications />

      {(chosen.length > 0 || pending.batches.length > 0) && (
        <div className="action-bar" role="region" aria-label="Approvals">
          {pending.batches.map((b) => (
            <UndoRow key={b.id} batch={b} />
          ))}
          {chosen.length > 0 && (
            <div className="action-bar-row">
              <span>{chosen.length} selected</span>
              <button className="button button-quiet" onClick={() => setSelected(new Set())}>
                Clear
              </button>
              <button className="button button-primary" onClick={approveChosen}>
                Approve {chosen.length}
              </button>
            </div>
          )}
        </div>
      )}
    </main>
  );
}

const titleOf = (card: ApprovalCard) => `${card.title} for ${card.subject.name}`;

function UndoRow({ batch }: { batch: PendingBatch }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((batch.sendsAt - now) / 1000));
  return (
    <div className="action-bar-row" role="status">
      <span>
        {batch.label}{' '}
        <span className="muted">{left > 0 ? `· sending in ${left}s` : '· sending…'}</span>
      </span>
      <button className="button" disabled={left === 0} onClick={() => undo(batch.id)}>
        Undo
      </button>
    </div>
  );
}

/** How far right (as a share of the card's width) a swipe must go to approve. */
const SWIPE_SHARE = 0.35;

function Approval({
  card,
  selected,
  onSelect,
}: {
  card: ApprovalCard;
  selected: boolean;
  onSelect: (on: boolean) => void;
}) {
  const client = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');
  const reject = useMutation({
    mutationFn: () => api(`/approvals/${card.approvalId}/reject`, { body: { comment } }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['approvals'] }),
        client.invalidateQueries({ queryKey: ['requests'] }),
      ]),
  });
  const canApprove = !card.waitingFor;
  const approve = () =>
    approveLater(
      [{ approvalId: card.approvalId, bulk: card.bulk, title: titleOf(card) }],
      `Approved: ${titleOf(card)}`,
    );
  const swipe = useSwipe(canApprove && !rejecting, approve);

  return (
    <li
      className={`card swipeable${swipe.offset > 0 ? ' swiping' : ''}${selected ? ' selected' : ''}`}
      aria-label={titleOf(card)}
      {...swipe.handlers}
      style={swipe.offset ? { transform: `translateX(${swipe.offset}px)` } : undefined}
    >
      {swipe.offset > 0 && (
        <span className="swipe-hint" aria-hidden="true">
          {swipe.ready ? 'Release to approve' : 'Approve →'}
        </span>
      )}
      <div className="card-head">
        {card.bulk && canApprove ? (
          <label className="card-select">
            <input
              type="checkbox"
              checked={selected}
              onChange={(e) => onSelect(e.target.checked)}
              aria-label={`Select ${titleOf(card)}`}
            />
            <strong>{card.title}</strong>
          </label>
        ) : (
          <strong>{card.title}</strong>
        )}
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
      {card.waitingFor && <Note kind="info">{card.waitingFor}. It can still be returned.</Note>}
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
            <button
              className="button button-primary"
              disabled={reject.isPending || !comment.trim()}
            >
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
          <button className="button button-primary" disabled={!canApprove} onClick={approve}>
            Approve
          </button>
          <button className="button" disabled={reject.isPending} onClick={() => setRejecting(true)}>
            Reject…
          </button>
          <Link
            className={card.link ? 'button' : 'button button-quiet'}
            to={card.link ?? `/requests/${card.instanceId}`}
          >
            {card.link ? 'Open' : 'Details'}
          </Link>
        </div>
      )}
      {reject.error && <Note kind="error">{errorMessage(reject.error)}</Note>}
    </li>
  );
}

/**
 * Swipe right to approve (CLAUDE.md: approve with 1 tap or a swipe on mobile). Vertical moves are
 * left to the page so the list still scrolls; a drag that starts on a button or field is ignored.
 */
function useSwipe(enabled: boolean, onSwipe: () => void) {
  const [offset, setOffset] = useState(0);
  const [width, setWidth] = useState(0);
  const start = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const ready = width > 0 && offset >= width * SWIPE_SHARE;
  const end = (approve: boolean) => {
    start.current = null;
    setOffset(0);
    if (approve) onSwipe();
  };
  const handlers = enabled
    ? {
        onPointerDown: (e: PointerEvent<HTMLLIElement>) => {
          if ((e.target as HTMLElement).closest('button, a, input, textarea, select, label')) {
            return;
          }
          start.current = { x: e.clientX, y: e.clientY, dragging: false };
          setWidth(e.currentTarget.offsetWidth);
        },
        onPointerMove: (e: PointerEvent<HTMLLIElement>) => {
          const s = start.current;
          if (!s) return;
          const dx = e.clientX - s.x;
          const dy = e.clientY - s.y;
          if (!s.dragging) {
            if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
              start.current = null;
              return;
            }
            if (dx < 10) return;
            s.dragging = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          setOffset(Math.max(0, dx));
        },
        onPointerUp: () => end(Boolean(start.current?.dragging && ready)),
        onPointerCancel: () => end(false),
      }
    : {};
  return { offset, ready, handlers };
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

/** Unread updates on the home screen; the full list and settings are on Notifications (X1). */
function Notifications() {
  const client = useQueryClient();
  const notes = useNotifications();
  const read = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const unread = notes.data?.filter((n) => !n.read) ?? [];
  if (unread.length === 0) return null;
  return (
    <section aria-labelledby="inbox-updates">
      <div className="section-head">
        <h2 id="inbox-updates">Updates ({unread.length})</h2>
        <Link className="button button-quiet" to="/notifications">
          All notifications
        </Link>
      </div>
      <ul className="rows" aria-label="Updates">
        {unread.slice(0, 10).map((n) => (
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

export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<NotificationView[]>('/notifications'),
    enabled,
  });
}
