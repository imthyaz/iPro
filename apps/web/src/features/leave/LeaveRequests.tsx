import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import type {
  LeaveApplyInput,
  LeavePreview,
  LeaveRequestStatus,
  LeaveRequestView,
  LeaveTypeView,
} from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { Chip, Empty, Field, formatDate, Note, todayIso } from '../../design-system/index.js';

/** The same words and colours for leave requests in every module. */
export const requestWords: Record<LeaveRequestStatus, string> = {
  applied: 'Waiting for approval',
  returned: 'Returned',
  approved: 'Approved',
  cancelled: 'Cancelled',
  revoked: 'Revoked',
  withdrawn: 'Withdrawn',
};
const requestTone: Record<LeaveRequestStatus, 'ok' | 'info' | 'warn' | 'muted'> = {
  applied: 'info',
  returned: 'warn',
  approved: 'ok',
  cancelled: 'muted',
  revoked: 'muted',
  withdrawn: 'muted',
};

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dates = (r: Pick<LeaveRequestView, 'from' | 'to'>) =>
  r.from === r.to ? formatDate(r.from) : `${formatDate(r.from)} – ${formatDate(r.to)}`;
const plural = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** Waits until the value stops changing, so the preview isn't asked for on every keystroke. */
function useSettled<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * E4 Apply leave: the type (casual first), the dates (tomorrow by default) and Send — three taps.
 * The form shows the days, the balance after and anything that stops it before it is sent.
 */
export function ApplyLeave({ onDone }: { onDone?: () => void }) {
  const client = useQueryClient();
  const tomorrow = addDays(todayIso(), 1);
  const types = useQuery({
    queryKey: ['leave-types'],
    queryFn: () => api<LeaveTypeView[]>('/leave-types'),
  });
  const usable = (types.data ?? []).filter((t) => t.active);
  const [form, setForm] = useState({
    leaveTypeId: '',
    from: tomorrow,
    to: tomorrow,
    startHalf: 'full' as 'full' | 'second',
    endHalf: 'full' as 'full' | 'first',
    reason: '',
    lopForShortfall: false,
  });
  const typeId = form.leaveTypeId || usable[0]?.id || '';
  const body: LeaveApplyInput = {
    ...form,
    leaveTypeId: typeId,
    to: form.to < form.from ? form.from : form.to,
    reason: form.reason || undefined,
  };
  const settled = useSettled(body);
  const preview = useQuery({
    queryKey: ['leave-preview', settled],
    queryFn: () => api<LeavePreview>('/leave/requests/preview', { body: settled }),
    enabled: Boolean(settled.leaveTypeId),
  });
  const [sent, setSent] = useState<LeaveRequestView | null>(null);
  const send = useMutation({
    mutationFn: () => api<LeaveRequestView>('/leave/requests', { body }),
    onSuccess: (request) => {
      setSent(request);
      void client.invalidateQueries({ queryKey: ['leave-requests'] });
      void client.invalidateQueries({ queryKey: ['leave-balances'] });
      void client.invalidateQueries({ queryKey: ['attendance-month'] });
    },
  });
  const p = preview.data;
  // The loss-of-pay offer is a choice, not a problem: it goes away once accepted.
  const blocking = (p?.problems ?? []).filter(
    (problem) => !(form.lopForShortfall && problem.endsWith('would be loss of pay')),
  );
  const single = body.from === body.to;

  if (sent) {
    return (
      <section className="card" aria-label="Leave sent">
        <Note kind="info">
          Sent: {sent.leaveType.name}, {dates(sent)} ({plural(sent.days)}). Your manager will see it
          in their inbox.
        </Note>
        {sent.needsCertificate && !sent.certificateAttached && (
          <Certificate request={sent} onAttached={setSent} />
        )}
        <button
          className="button"
          onClick={() => {
            setSent(null);
            onDone?.();
          }}
        >
          Done
        </button>
      </section>
    );
  }

  return (
    <form
      className="inline-form apply-leave"
      aria-label="Apply leave"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <h2>Apply leave</h2>
      <div className="segmented" role="radiogroup" aria-label="Leave type">
        {usable.map((t) => (
          <button
            type="button"
            key={t.id}
            role="radio"
            aria-checked={t.id === typeId}
            className={t.id === typeId ? 'segment segment-active' : 'segment'}
            onClick={() => setForm({ ...form, leaveTypeId: t.id, lopForShortfall: false })}
          >
            {t.name}
          </button>
        ))}
      </div>
      <div className="form-grid">
        <Field label="From">
          {(id) => (
            <input
              id={id}
              type="date"
              required
              value={form.from}
              onChange={(e) => e.target.value && setForm({ ...form, from: e.target.value })}
            />
          )}
        </Field>
        <Field label="To">
          {(id) => (
            <input
              id={id}
              type="date"
              required
              min={form.from}
              value={body.to}
              onChange={(e) => e.target.value && setForm({ ...form, to: e.target.value })}
            />
          )}
        </Field>
      </div>
      <div className="check-row">
        <label className="check">
          <input
            type="checkbox"
            checked={form.startHalf === 'second'}
            disabled={single && form.endHalf === 'first'}
            onChange={(e) => setForm({ ...form, startHalf: e.target.checked ? 'second' : 'full' })}
          />
          {single ? 'Afternoon only' : 'First day from the afternoon'}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.endHalf === 'first'}
            disabled={single && form.startHalf === 'second'}
            onChange={(e) => setForm({ ...form, endHalf: e.target.checked ? 'first' : 'full' })}
          />
          {single ? 'Morning only' : 'Last day until midday'}
        </label>
      </div>
      <Field label="Reason" hint="Optional, for your manager">
        {(id) => (
          <input
            id={id}
            maxLength={500}
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
          />
        )}
      </Field>
      {p && (
        <div className="leave-preview" role="status" aria-label="What this leave is">
          <strong>{plural(p.days)}</strong>
          {p.balanceAfter !== null && (
            <span>
              Balance {p.balanceBefore} →{' '}
              {form.lopForShortfall || p.shortfall === 0 ? p.balanceAfter : '—'}
            </span>
          )}
          {p.lop > 0 && form.lopForShortfall && <span>{plural(p.lop)} as loss of pay</span>}
          {p.needsSecondApproval && <span>Needs a second approval (over 5 days)</span>}
          {p.unplanned && <span>Counts as unplanned</span>}
          {p.needsCertificate && (
            <span>
              A medical certificate is needed: add it after sending; approval waits for it
            </span>
          )}
        </div>
      )}
      {p && p.shortfall > 0 && (
        <label className="check">
          <input
            type="checkbox"
            checked={form.lopForShortfall}
            onChange={(e) => setForm({ ...form, lopForShortfall: e.target.checked })}
          />
          Take {plural(p.shortfall)} beyond my balance as loss of pay
        </label>
      )}
      {blocking.map((problem) => (
        <Note key={problem} kind="error">
          {problem}
        </Note>
      ))}
      <button
        className="button button-primary button-large"
        disabled={!typeId || send.isPending || preview.isFetching || blocking.length > 0}
      >
        {send.isPending ? 'Sending…' : 'Send to my manager'}
      </button>
      {send.error && <Note kind="error">{errorMessage(send.error)}</Note>}
    </form>
  );
}

function Certificate(props: {
  request: LeaveRequestView;
  onAttached: (request: LeaveRequestView) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const upload = useMutation({
    mutationFn: () => {
      const data = new FormData();
      data.append('file', file!);
      return api<LeaveRequestView>(`/leave/requests/${props.request.id}/certificate`, {
        form: data,
      });
    },
    onSuccess: props.onAttached,
  });
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        upload.mutate();
      }}
    >
      <Field label="Medical certificate" hint="PDF, JPEG or PNG. Only HR can open it.">
        {(id) => (
          <input
            id={id}
            type="file"
            accept=".pdf,image/jpeg,image/png"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        )}
      </Field>
      <button className="button" disabled={!file || upload.isPending}>
        Attach
      </button>
      {upload.error && <Note kind="error">{errorMessage(upload.error)}</Note>}
    </form>
  );
}

/** E5 requests (own, with cancel) or a person's (HR revokes started leave from a day). */
export function LeaveRequestList(props: { personId?: string; canRevoke?: boolean }) {
  const client = useQueryClient();
  const year = Number(todayIso().slice(0, 4));
  const path = props.personId
    ? `/people/${props.personId}/leave/requests?year=${year}`
    : `/leave/requests/mine?year=${year}`;
  const requests = useQuery({
    queryKey: ['leave-requests', props.personId ?? 'mine', year],
    queryFn: () => api<LeaveRequestView[]>(path),
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['leave-requests'] });
    void client.invalidateQueries({ queryKey: ['leave-balances'] });
    void client.invalidateQueries({ queryKey: ['attendance-month'] });
  };
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api<LeaveRequestView>(`/leave/requests/${id}/cancel`, { method: 'POST' }),
    onSuccess: refresh,
  });
  return (
    <section aria-labelledby="leave-requests-title">
      <h2 id="leave-requests-title">Leave requests {year}</h2>
      {requests.error && <Note kind="error">{errorMessage(requests.error)}</Note>}
      {requests.data?.length === 0 && <Empty>No leave requests this year.</Empty>}
      <ul className="rows" aria-label="Leave requests">
        {requests.data?.map((r) => (
          <li key={r.id} className="row row-stack">
            <span className="row-main">
              <strong>
                {r.leaveType.name} · {dates(r)}
              </strong>
              <span className="muted">
                {plural(r.days)}
                {r.lop ? `, ${plural(r.lop)} loss of pay` : ''}
                {r.unplanned ? ' · unplanned' : ''}
                {r.needsCertificate
                  ? r.certificateAttached
                    ? ' · certificate attached'
                    : ' · certificate needed'
                  : ''}
                {r.revokedFrom ? ` · back from ${formatDate(r.revokedFrom)}` : ''}
              </span>
            </span>
            <span className="row-side">
              <Chip tone={requestTone[r.status]}>{requestWords[r.status]}</Chip>
              {r.canCancel && (
                <button
                  className="button button-quiet"
                  disabled={cancel.isPending}
                  onClick={() => {
                    if (window.confirm(`Cancel ${r.leaveType.name}, ${dates(r)}?`))
                      cancel.mutate(r.id);
                  }}
                >
                  Cancel
                </button>
              )}
            </span>
            {props.canRevoke && r.status === 'approved' && <Revoke request={r} onDone={refresh} />}
          </li>
        ))}
      </ul>
      {cancel.error && <Note kind="error">{errorMessage(cancel.error)}</Note>}
    </section>
  );
}

function Revoke({ request, onDone }: { request: LeaveRequestView; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const today = todayIso();
  const [form, setForm] = useState({
    from: today < request.from ? request.from : today > request.to ? request.to : today,
    reason: '',
  });
  const revoke = useMutation({
    mutationFn: () => api(`/leave/requests/${request.id}/revoke`, { body: form }),
    onSuccess: () => {
      setOpen(false);
      onDone();
    },
  });
  if (!open) {
    return (
      <button className="button button-quiet" onClick={() => setOpen(true)}>
        Give back days
      </button>
    );
  }
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        revoke.mutate();
      }}
    >
      <div className="form-grid">
        <Field label="Back from" hint="Days from this one are given back">
          {(id) => (
            <input
              id={id}
              type="date"
              required
              min={request.from}
              max={request.to}
              value={form.from}
              onChange={(e) => setForm({ ...form, from: e.target.value })}
            />
          )}
        </Field>
        <Field label="Reason" hint="Required">
          {(id) => (
            <input
              id={id}
              required
              minLength={3}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          )}
        </Field>
      </div>
      <div className="form-actions">
        <button className="button button-primary" disabled={revoke.isPending}>
          Give back
        </button>
        <button type="button" className="button button-quiet" onClick={() => setOpen(false)}>
          Keep
        </button>
      </div>
      {revoke.error && <Note kind="error">{errorMessage(revoke.error)}</Note>}
    </form>
  );
}
