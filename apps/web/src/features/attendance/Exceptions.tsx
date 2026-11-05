import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { AttendanceCorrectionInput, AttendanceExceptionView } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { hasRole, useMe } from '../../auth.js';
import {
  Chip,
  Empty,
  Field,
  formatDate,
  ListDetail,
  Note,
  todayIso,
} from '../../design-system/index.js';
import { flagWords, statusWords } from './Attendance.js';

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const keyOf = (e: Pick<AttendanceExceptionView, 'personId' | 'date'>) => `${e.personId}:${e.date}`;

/**
 * H9 Attendance exceptions: absent days, half days and flagged days not yet regularised, newest
 * first. HR corrects one or many at once with a reason; managers see their team's.
 */
export function AttendanceExceptions() {
  const me = useMe().data;
  const canCorrect = hasRole(me, 'hr', 'hr_head');
  const [range, setRange] = useState({ from: addDays(todayIso(), -7), to: todayIso() });
  const [kind, setKind] = useState<'all' | 'absent' | 'flagged'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const list = useQuery({
    queryKey: ['attendance-exceptions', range.from, range.to],
    queryFn: () =>
      api<AttendanceExceptionView[]>(`/attendance/exceptions?from=${range.from}&to=${range.to}`),
  });
  const rows = (list.data ?? [])
    .filter((e) =>
      kind === 'all'
        ? true
        : kind === 'absent'
          ? e.status === 'absent' || e.status === 'half_day'
          : e.flags.length > 0,
    )
    .reverse();
  const chosen = rows.filter((e) => selected.has(keyOf(e)));
  const toggle = (e: AttendanceExceptionView) => {
    const next = new Set(selected);
    if (next.has(keyOf(e))) next.delete(keyOf(e));
    else next.add(keyOf(e));
    setSelected(next);
  };

  const content = (
    <>
      <div className="toolbar">
        <h1>Attendance exceptions</h1>
      </div>
      <div className="filters">
        <Field label="From">
          {(id) => (
            <input
              id={id}
              type="date"
              value={range.from}
              onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })}
            />
          )}
        </Field>
        <Field label="To">
          {(id) => (
            <input
              id={id}
              type="date"
              value={range.to}
              onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })}
            />
          )}
        </Field>
        <Field label="Show">
          {(id) => (
            <select id={id} value={kind} onChange={(e) => setKind(e.target.value as 'all')}>
              <option value="all">All exceptions</option>
              <option value="absent">Absent and half days</option>
              <option value="flagged">Flagged days</option>
            </select>
          )}
        </Field>
      </div>
      {list.error && <Note kind="error">{errorMessage(list.error)}</Note>}
      {list.data && rows.length === 0 && <Empty>No exceptions in this range.</Empty>}
      <ul className="rows" aria-label="Attendance exceptions">
        {rows.map((e) => (
          <li key={keyOf(e)} className="row">
            {canCorrect && (
              <input
                type="checkbox"
                className="row-check"
                aria-label={`Select ${e.name}, ${formatDate(e.date)}`}
                checked={selected.has(keyOf(e))}
                onChange={() => toggle(e)}
              />
            )}
            <span className="row-main">
              <strong>
                <Link to={`/people/${e.personId}`}>{e.name}</Link>{' '}
                <span className="muted">{e.employeeCode}</span>
              </strong>
              <span className="muted">
                {formatDate(e.date)}
                {e.flags.length ? ` · ${e.flags.map((f) => flagWords[f]).join(', ')}` : ''}
              </span>
            </span>
            <span className="row-side">
              {e.pendingRegularisation && <Chip tone="info">Regularisation asked</Chip>}
              <Chip tone={e.status === 'absent' || e.status === 'half_day' ? 'warn' : 'ok'}>
                {statusWords[e.status]}
              </Chip>
            </span>
          </li>
        ))}
      </ul>
    </>
  );

  return (
    <ListDetail
      list={content}
      detail={
        canCorrect && chosen.length > 0 ? (
          <Correct days={chosen} onDone={() => setSelected(new Set())} />
        ) : null
      }
      onClose={() => setSelected(new Set())}
      detailLabel="Correct attendance"
    />
  );
}

function Correct(props: { days: AttendanceExceptionView[]; onDone: () => void }) {
  const client = useQueryClient();
  const [form, setForm] = useState({
    status: 'present' as AttendanceCorrectionInput['status'],
    firstIn: '',
    lastOut: '',
    reason: '',
  });
  const correct = useMutation({
    mutationFn: () =>
      api<{ corrected: number }>('/attendance/corrections', {
        body: {
          days: props.days.map((d) => ({ personId: d.personId, date: d.date })),
          status: form.status,
          firstIn: form.firstIn || undefined,
          lastOut: form.lastOut || undefined,
          reason: form.reason,
        },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['attendance-exceptions'] });
      void client.invalidateQueries({ queryKey: ['attendance-month'] });
      props.onDone();
    },
  });
  const people = new Set(props.days.map((d) => d.personId)).size;
  return (
    <article className="record">
      <header className="record-header">
        <h2>
          Correct {props.days.length} {props.days.length === 1 ? 'day' : 'days'}
        </h2>
        <p className="muted">
          {people} {people === 1 ? 'person' : 'people'}. Applies at once and is recorded with your
          reason; any open request for these days is closed.
        </p>
      </header>
      <form
        className="inline-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          correct.mutate();
        }}
      >
        <div className="form-grid">
          <Field label="Mark as">
            {(id) => (
              <select
                id={id}
                value={form.status}
                onChange={(e) =>
                  setForm({
                    ...form,
                    status: e.target.value as AttendanceCorrectionInput['status'],
                  })
                }
              >
                <option value="present">Present (office)</option>
                <option value="wfh">WFH</option>
                <option value="client_site">Client site</option>
                <option value="half_day">Half day</option>
              </select>
            )}
          </Field>
          <Field label="In at" hint="Optional">
            {(id) => (
              <input
                id={id}
                type="time"
                value={form.firstIn}
                onChange={(e) => setForm({ ...form, firstIn: e.target.value })}
              />
            )}
          </Field>
          <Field label="Out at" hint="Optional">
            {(id) => (
              <input
                id={id}
                type="time"
                value={form.lastOut}
                onChange={(e) => setForm({ ...form, lastOut: e.target.value })}
              />
            )}
          </Field>
        </div>
        <Field label="Reason" hint="Required; kept with the correction">
          {(id) => (
            <input
              id={id}
              required
              minLength={3}
              maxLength={500}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          )}
        </Field>
        <button className="button button-primary" disabled={correct.isPending}>
          Correct {props.days.length} {props.days.length === 1 ? 'day' : 'days'}
        </button>
        {correct.error && <Note kind="error">{errorMessage(correct.error)}</Note>}
      </form>
    </article>
  );
}
