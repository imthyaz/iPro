import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { CompOffRequestView, LeaveTypeView } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { Chip, Field, formatDate, Note, todayIso } from '../../design-system/index.js';
import { requestTone, requestWords } from './LeaveRequests.js';

const plural = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
const dayKind = (r: CompOffRequestView) =>
  r.dayKind === 'Weekly off' ? 'weekly off' : `holiday: ${r.dayKind}`;

/**
 * Ask for comp-off (decision #76) for a weekly off or holiday worked: the day, full or half, and
 * why. The manager approves it in the Action inbox.
 */
export function AskCompOff({ onDone }: { onDone?: () => void }) {
  const client = useQueryClient();
  const types = useQuery({
    queryKey: ['leave-types'],
    queryFn: () => api<LeaveTypeView[]>('/leave-types'),
  });
  const compOff = types.data?.find((t) => t.kind === 'granted' && t.active);
  const [form, setForm] = useState({ workedOn: '', days: '1', reason: '' });
  const ask = useMutation({
    mutationFn: () =>
      api<CompOffRequestView>('/leave/comp-off', {
        body: {
          workedOn: form.workedOn,
          days: Number(form.days),
          ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
        },
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['comp-off'] });
      onDone?.();
    },
  });
  return (
    <form
      className="card inline-form"
      aria-label="Ask for comp-off"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        ask.mutate();
      }}
    >
      <h2>Ask for comp-off</h2>
      <p className="muted">
        For a weekly off or holiday you worked. Your manager approves it
        {compOff?.expiresAfterDays
          ? `; it can be used for ${compOff.expiresAfterDays} days after that.`
          : '.'}
      </p>
      <div className="form-grid">
        <Field label="Day you worked">
          {(id) => (
            <input
              id={id}
              type="date"
              required
              max={todayIso()}
              value={form.workedOn}
              onChange={(e) => setForm({ ...form, workedOn: e.target.value })}
            />
          )}
        </Field>
        <Field label="How much">
          {(id) => (
            <select
              id={id}
              value={form.days}
              onChange={(e) => setForm({ ...form, days: e.target.value })}
            >
              <option value="1">A full day</option>
              <option value="0.5">Half a day</option>
            </select>
          )}
        </Field>
        <Field label="What you worked on" hint="Optional; your manager sees it">
          {(id) => (
            <input
              id={id}
              maxLength={500}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          )}
        </Field>
      </div>
      <div className="form-actions">
        <button className="button button-primary" disabled={ask.isPending || !form.workedOn}>
          Send
        </button>
        {onDone && (
          <button type="button" className="button button-quiet" onClick={onDone}>
            Close
          </button>
        )}
      </div>
      {ask.error && <Note kind="error">{errorMessage(ask.error)}</Note>}
    </form>
  );
}

/** My comp-off requests: what was asked, what was granted and until when, what ran out. */
export function CompOffList() {
  const client = useQueryClient();
  const year = Number(todayIso().slice(0, 4));
  const requests = useQuery({
    queryKey: ['comp-off', year],
    queryFn: () => api<CompOffRequestView[]>(`/leave/comp-off/mine?year=${year}`),
  });
  const withdraw = useMutation({
    mutationFn: (id: string) =>
      api<CompOffRequestView>(`/leave/comp-off/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['comp-off'] }),
  });
  if (requests.data?.length === 0) return null;
  return (
    <section aria-labelledby="comp-off-title">
      <h2 id="comp-off-title">Comp-off {year}</h2>
      {requests.error && <Note kind="error">{errorMessage(requests.error)}</Note>}
      <ul className="rows" aria-label="Comp-off requests">
        {requests.data?.map((r) => (
          <li key={r.id} className="row">
            <span className="row-main">
              <strong>
                Worked {formatDate(r.workedOn)} ({dayKind(r)})
              </strong>
              <span className="muted">
                {plural(r.days)}
                {r.expiredDays !== null
                  ? r.expiredDays > 0
                    ? ` · ${plural(r.expiredDays)} expired unused`
                    : ' · used'
                  : r.validUntil
                    ? ` · usable until ${formatDate(r.validUntil)}`
                    : ''}
              </span>
            </span>
            <span className="row-side">
              <Chip tone={requestTone[r.status]}>{requestWords[r.status]}</Chip>
              {r.canCancel && (
                <button
                  className="button button-quiet"
                  disabled={withdraw.isPending}
                  onClick={() => {
                    if (window.confirm(`Withdraw comp-off for ${formatDate(r.workedOn)}?`))
                      withdraw.mutate(r.id);
                  }}
                >
                  Withdraw
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {withdraw.error && <Note kind="error">{errorMessage(withdraw.error)}</Note>}
    </section>
  );
}
