import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  exitReasonSchema,
  exitInterviewQuestions,
  exitReasonWords,
  type ExitCaseView,
  type ExitReason,
  type ExitStatus,
  type MyExitView,
} from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { hasRole, useMe } from '../../auth.js';
import { Chip, Empty, Field, formatDate, ListDetail, Note } from '../../design-system/index.js';

/** The same words and colours for exits everywhere. */
export const exitWords: Record<ExitStatus, [string, 'ok' | 'info' | 'warn' | 'muted']> = {
  submitted: ['Resignation submitted', 'info'],
  serving_notice: ['Serving notice', 'warn'],
  clearance: ['Clearance', 'warn'],
  exited: ['Exited', 'muted'],
  withdrawn: ['Withdrawn', 'muted'],
};
const waitingWords = {
  manager: 'the manager (retention conversation)',
  hr: 'HR (last working day)',
  hr_head: 'HR head (early release)',
} as const;

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * E10 Resign: the notice that applies, a reason and the last day proposed; afterwards where it
 * stands, and withdraw.
 */
export function Resign() {
  const client = useQueryClient();
  const data = useQuery({ queryKey: ['my-exit'], queryFn: () => api<MyExitView>('/exits/mine') });
  const v = data.data;
  const [form, setForm] = useState<{ reason: ExitReason | ''; note: string; lastDay: string }>({
    reason: '',
    note: '',
    lastDay: '',
  });
  const resign = useMutation({
    mutationFn: () =>
      api<ExitCaseView>('/exits/resign', {
        body: {
          reason: form.reason,
          proposedLastDay: form.lastDay || v!.noticeLastDay,
          ...(form.note.trim() ? { note: form.note.trim() } : {}),
        },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['my-exit'] }),
  });
  return (
    <main className="page">
      <h1>Resign</h1>
      {data.error && <Note kind="error">{errorMessage(data.error)}</Note>}
      {v?.current ? (
        <MyExit exit={v.current} />
      ) : v ? (
        <form
          className="card inline-form"
          aria-label="Resignation"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            // Irreversible without approval once accepted: confirm first (CLAUDE.md design rules).
            if (window.confirm('Send your resignation to your manager and HR?')) resign.mutate();
          }}
        >
          <p>
            Your notice period is <strong>{v.noticeDays} days</strong>
            {v.onProbation ? ' (on probation)' : ''}. Resigning today, it ends on{' '}
            <strong>{formatDate(v.noticeLastDay)}</strong>. An earlier last day needs HR head’s
            approval of a buyout or waiver.
          </p>
          <div className="form-grid">
            <Field label="Main reason">
              {(id) => (
                <select
                  id={id}
                  required
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value as ExitReason })}
                >
                  <option value="">Choose…</option>
                  {exitReasonSchema.options.map((r) => (
                    <option key={r} value={r}>
                      {exitReasonWords[r]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Last working day you propose" hint="Up to the end of your notice">
              {(id) => (
                <input
                  id={id}
                  type="date"
                  max={v.noticeLastDay}
                  value={form.lastDay || v.noticeLastDay}
                  onChange={(e) => setForm({ ...form, lastDay: e.target.value })}
                />
              )}
            </Field>
            <Field label="Anything you’d like to add" hint="Optional; your manager and HR see it">
              {(id) => (
                <textarea
                  id={id}
                  rows={3}
                  maxLength={1000}
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                />
              )}
            </Field>
          </div>
          <button className="button button-primary" disabled={resign.isPending || !form.reason}>
            Send resignation
          </button>
          {resign.error && <Note kind="error">{errorMessage(resign.error)}</Note>}
        </form>
      ) : null}
    </main>
  );
}

function MyExit({ exit: x }: { exit: ExitCaseView }) {
  const client = useQueryClient();
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const withdraw = useMutation({
    mutationFn: () => api<ExitCaseView>(`/exits/${x.id}/withdraw`, { body: { reason } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['my-exit'] }),
  });
  return (
    <section className="card" aria-label="My resignation">
      <div className="card-head">
        <strong>Resigned on {formatDate(x.resignationDate)}</strong>
        <Chip tone={exitWords[x.status][1]}>{exitWords[x.status][0]}</Chip>
      </div>
      <span>
        {x.lastWorkingDate
          ? `Last working day: ${formatDate(x.lastWorkingDate)}`
          : `Last day you proposed: ${formatDate(x.proposedLastDay!)}`}
      </span>
      {x.waitingFor && <span className="muted">Waiting for {waitingWords[x.waitingFor]}.</span>}
      {x.withdrawal && <Chip tone="info">Withdrawal waiting for your manager and HR</Chip>}
      {x.can.withdraw &&
        (open ? (
          <form
            className="inline-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              withdraw.mutate();
            }}
          >
            <Field
              label="Why are you withdrawing?"
              hint={
                x.status === 'serving_notice'
                  ? 'Your manager and HR approve it, as it was already accepted'
                  : 'It is withdrawn at once'
              }
            >
              {(id) => (
                <textarea
                  id={id}
                  required
                  minLength={3}
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              )}
            </Field>
            <div className="form-actions">
              <button className="button button-primary" disabled={withdraw.isPending}>
                Withdraw resignation
              </button>
              <button type="button" className="button button-quiet" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button className="button" onClick={() => setOpen(true)}>
            Withdraw…
          </button>
        ))}
      {withdraw.error && <Note kind="error">{errorMessage(withdraw.error)}</Note>}
    </section>
  );
}

/** The exit as the manager and HR see it, with what they record to accept it. */
export function ExitDetail({ id }: { id: string }) {
  const data = useQuery({
    queryKey: ['exit', id],
    queryFn: () => api<ExitCaseView>(`/exits/${id}`),
  });
  if (data.error) return <Note kind="error">{errorMessage(data.error)}</Note>;
  const x = data.data;
  if (!x) return <p className="muted">Loading…</p>;
  const rows: [string, string][] = [
    ['Kind', x.kind === 'resignation' ? 'Resignation' : 'Termination'],
    [x.kind === 'resignation' ? 'Resigned on' : 'Started on', formatDate(x.resignationDate)],
    ['Notice', `${x.noticeDays} days, to ${formatDate(x.noticeLastDay)}`],
  ];
  if (x.proposedLastDay) rows.push(['Last day proposed', formatDate(x.proposedLastDay)]);
  if (x.lastWorkingDate) rows.push(['Last working day', formatDate(x.lastWorkingDate)]);
  if (x.earlyRelease) {
    rows.push([
      'Early release',
      x.earlyRelease === 'buyout' ? `Buyout of ${x.buyoutDays} notice days` : 'Notice waived',
    ]);
  }
  if (x.reason) {
    rows.push(['Reason', [exitReasonWords[x.reason], x.reasonNote].filter(Boolean).join(': ')]);
  }
  if (x.retentionNote) rows.push(['Retention conversation', x.retentionNote]);
  if (x.checklist)
    rows.push(['Exit checklist', `${x.checklist.done} of ${x.checklist.total} done`]);
  if (x.clearanceDoneAt) rows.push(['Clearance', `Done ${formatDate(x.clearanceDoneAt)}`]);
  if (x.interview) {
    rows.push([
      'Exit interview',
      x.interview.declined
        ? `Declined by the employee (${formatDate(x.interview.recordedAt)})`
        : `Recorded ${formatDate(x.interview.recordedAt)}`,
    ]);
    rows.push(['Can be rehired', x.interview.rehireEligible ? 'Yes' : 'No']);
    if (x.interview.answers) {
      rows.push([exitInterviewQuestions.reason, x.interview.answers.reason]);
      if (x.interview.answers.improve) {
        rows.push([exitInterviewQuestions.improve, x.interview.answers.improve]);
      }
      rows.push([exitInterviewQuestions.wouldReturn, returnWords[x.interview.answers.wouldReturn]]);
    }
  }
  if (x.access) {
    rows.push([
      'Access',
      x.access.method === 'entra'
        ? `Entra and iPro accounts disabled ${formatDate(x.access.disabledAt)}`
        : `iPro account disabled ${formatDate(x.access.disabledAt)}; IT disables Entra (task raised)`,
    ]);
  }
  if (x.exitedAt) rows.push(['Exited', formatDate(x.exitedAt)]);
  return (
    <article className="record" aria-label={`Exit: ${x.name}`}>
      <header className="record-header">
        <h2>{x.name}</h2>
        <p className="muted">
          {x.employeeCode} · <Link to={`/people/${x.personId}`}>Open record</Link>
        </p>
        <p>
          <Chip tone={exitWords[x.status][1]}>{exitWords[x.status][0]}</Chip>
          {x.waitingFor && <> Waiting for {waitingWords[x.waitingFor]}</>}
        </p>
      </header>
      <dl className="facts">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {x.withdrawal && (
        <Note kind="info">
          {x.name} asked to withdraw; it is waiting in the Action inbox for the manager and HR.
        </Note>
      )}
      {x.can.managerAccept && <ManagerAccept exit={x} />}
      {x.can.hrAccept && <HrAccept exit={x} />}
      {x.blockers.length > 0 && (
        <div className="note note-info" role="status" aria-label="Before the exit">
          <strong>Before the exit can be completed:</strong>
          <ul>
            {x.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}
      {x.can.recordInterview && !x.interview && <Interview exit={x} />}
      {x.can.completeExit && <CompleteExit exit={x} />}
    </article>
  );
}

const returnWords = { yes: 'Yes', maybe: 'Maybe', no: 'No' } as const;

/** HR records the exit interview (decision #81), or that the employee declined; and the rehire flag. */
function Interview({ exit: x }: { exit: ExitCaseView }) {
  const [form, setForm] = useState({
    declined: false,
    reason: '',
    improve: '',
    wouldReturn: '' as '' | 'yes' | 'maybe' | 'no',
    rehireEligible: true,
  });
  const save = useExitMutation<object>(x.id, 'interview');
  return (
    <form
      className="inline-form"
      aria-label="Exit interview"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate({
          declined: form.declined,
          rehireEligible: form.rehireEligible,
          ...(form.declined
            ? {}
            : {
                answers: {
                  reason: form.reason,
                  improve: form.improve,
                  wouldReturn: form.wouldReturn,
                },
              }),
        });
      }}
    >
      <h3>Exit interview</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={form.declined}
          onChange={(e) => setForm({ ...form, declined: e.target.checked })}
        />
        The employee declined the interview
      </label>
      {!form.declined && (
        <div className="form-grid">
          <Field label={exitInterviewQuestions.reason}>
            {(id) => (
              <textarea
                id={id}
                required
                rows={3}
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
              />
            )}
          </Field>
          <Field label={exitInterviewQuestions.improve}>
            {(id) => (
              <textarea
                id={id}
                rows={3}
                value={form.improve}
                onChange={(e) => setForm({ ...form, improve: e.target.value })}
              />
            )}
          </Field>
          <Field label={exitInterviewQuestions.wouldReturn}>
            {(id) => (
              <select
                id={id}
                required
                value={form.wouldReturn}
                onChange={(e) =>
                  setForm({ ...form, wouldReturn: e.target.value as 'yes' | 'maybe' | 'no' })
                }
              >
                <option value="">Choose…</option>
                <option value="yes">Yes</option>
                <option value="maybe">Maybe</option>
                <option value="no">No</option>
              </select>
            )}
          </Field>
        </div>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={form.rehireEligible}
          onChange={(e) => setForm({ ...form, rehireEligible: e.target.checked })}
        />
        Can be rehired
      </label>
      <p className="muted field-hint">The answers are seen by HR only.</p>
      <button className="button button-primary" disabled={save.isPending}>
        Save the interview
      </button>
      {save.error && <Note kind="error">{errorMessage(save.error)}</Note>}
    </form>
  );
}

/** HR completes the exit: letters and the Exit event. Irreversible, so it confirms first. */
function CompleteExit({ exit: x }: { exit: ExitCaseView }) {
  const complete = useExitMutation<object>(x.id, 'complete');
  return (
    <div className="form-actions">
      <button
        className="button button-primary"
        disabled={complete.isPending}
        onClick={() => {
          if (
            window.confirm(
              `Complete ${x.name}'s exit? Relieving and experience letters are generated.`,
            )
          ) {
            complete.mutate({});
          }
        }}
      >
        Complete exit
      </button>
      {complete.error && <Note kind="error">{errorMessage(complete.error)}</Note>}
    </div>
  );
}

function useExitMutation<T>(id: string, path: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: T) => api<ExitCaseView>(`/exits/${id}/${path}`, { body }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['exit', id] }),
        client.invalidateQueries({ queryKey: ['exits'] }),
        client.invalidateQueries({ queryKey: ['approvals'] }),
      ]),
  });
}

function ManagerAccept({ exit: x }: { exit: ExitCaseView }) {
  const [note, setNote] = useState('');
  const accept = useExitMutation<{ retentionNote: string }>(x.id, 'manager-accept');
  return (
    <form
      className="inline-form"
      aria-label="Accept as manager"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        accept.mutate({ retentionNote: note });
      }}
    >
      <h3>Accept the resignation</h3>
      <Field
        label="The retention conversation"
        hint="What you discussed and what was offered; HR sees this, the employee doesn’t"
      >
        {(id) => (
          <textarea
            id={id}
            required
            minLength={3}
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
      </Field>
      <button
        className="button button-primary"
        disabled={accept.isPending || note.trim().length < 3}
      >
        Accept and send to HR
      </button>
      {accept.error && <Note kind="error">{errorMessage(accept.error)}</Note>}
    </form>
  );
}

function HrAccept({ exit: x }: { exit: ExitCaseView }) {
  const [form, setForm] = useState({
    lastWorkingDate: x.proposedLastDay ?? x.noticeLastDay,
    earlyRelease: '' as '' | 'buyout' | 'waiver',
    note: '',
  });
  const accept = useExitMutation<object>(x.id, 'hr-accept');
  const early = daysBetween(form.lastWorkingDate, x.noticeLastDay);
  return (
    <form
      className="inline-form"
      aria-label="Accept as HR"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        accept.mutate({
          lastWorkingDate: form.lastWorkingDate,
          earlyRelease: early > 0 ? form.earlyRelease || null : null,
          ...(form.note.trim() ? { note: form.note.trim() } : {}),
        });
      }}
    >
      <h3>Fix the last working day</h3>
      <div className="form-grid">
        <Field label="Last working day" hint={`Up to ${formatDate(x.noticeLastDay)}`}>
          {(id) => (
            <input
              id={id}
              type="date"
              required
              min={x.resignationDate}
              max={x.noticeLastDay}
              value={form.lastWorkingDate}
              onChange={(e) => setForm({ ...form, lastWorkingDate: e.target.value })}
            />
          )}
        </Field>
        {early > 0 && (
          <Field
            label={`${early} days before the end of the notice`}
            hint="HR head approves a buyout or waiver"
          >
            {(id) => (
              <select
                id={id}
                required
                value={form.earlyRelease}
                onChange={(e) =>
                  setForm({ ...form, earlyRelease: e.target.value as 'buyout' | 'waiver' })
                }
              >
                <option value="">Choose…</option>
                <option value="buyout">Buyout ({early} notice days)</option>
                <option value="waiver">Waive the remaining notice</option>
              </select>
            )}
          </Field>
        )}
        <Field label="Note" hint="Optional">
          {(id) => (
            <input
              id={id}
              maxLength={1000}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          )}
        </Field>
      </div>
      <button
        className="button button-primary"
        disabled={accept.isPending || (early > 0 && !form.earlyRelease)}
      >
        {early > 0 ? 'Accept and send to HR head' : 'Accept the resignation'}
      </button>
      {accept.error && <Note kind="error">{errorMessage(accept.error)}</Note>}
    </form>
  );
}

/** H8 Exit tracker: open exits by last working day (HR: the entity; managers: their team). */
export function ExitTracker() {
  const { exitId } = useParams();
  const navigate = useNavigate();
  const [closed, setClosed] = useState(false);
  const list = useQuery({
    queryKey: ['exits', closed],
    queryFn: () => api<ExitCaseView[]>(`/exits${closed ? '?closed=true' : ''}`),
  });
  const content = (
    <>
      <div className="toolbar">
        <h1>Exits</h1>
      </div>
      <label className="check">
        <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
        Include exited and withdrawn
      </label>
      {list.error && <Note kind="error">{errorMessage(list.error)}</Note>}
      {list.data?.length === 0 && <Empty>No exits in progress.</Empty>}
      <ul className="rows" aria-label="Exits">
        {list.data?.map((x) => (
          <li key={x.id}>
            <Link to={`/exits/${x.id}`} className={x.id === exitId ? 'row row-selected' : 'row'}>
              <span className="row-main">
                <strong>
                  {x.name} · {x.employeeCode}
                </strong>
                <span className="muted">
                  {x.lastWorkingDate
                    ? `Last day ${formatDate(x.lastWorkingDate)}`
                    : `Proposed ${formatDate(x.proposedLastDay ?? x.noticeLastDay)}`}
                  {x.checklist ? ` · checklist ${x.checklist.done}/${x.checklist.total}` : ''}
                  {x.waitingFor ? ` · waiting for ${x.waitingFor.replace('_', ' ')}` : ''}
                </span>
              </span>
              <span className="row-chips">
                {x.kind === 'termination' && <Chip tone="warn">Termination</Chip>}
                <Chip tone={exitWords[x.status][1]}>{exitWords[x.status][0]}</Chip>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
  return (
    <main className="page">
      <ListDetail
        list={content}
        detail={exitId ? <ExitDetail key={exitId} id={exitId} /> : null}
        onClose={() => navigate('/exits')}
        detailLabel="Exit"
      />
    </main>
  );
}

/** The person record's Exit tab: their exits, and for HR head, ending employment. */
export function PersonExit({ personId, active }: { personId: string; active: boolean }) {
  const me = useMe().data;
  const client = useQueryClient();
  const list = useQuery({
    queryKey: ['exits', true],
    queryFn: () => api<ExitCaseView[]>('/exits?closed=true'),
  });
  const mine = list.data?.filter((x) => x.personId === personId) ?? [];
  const [form, setForm] = useState({ lastWorkingDate: '', reason: '' });
  const terminate = useMutation({
    mutationFn: () => api<ExitCaseView>(`/people/${personId}/terminate`, { body: form }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['exits'] }),
        client.invalidateQueries({ queryKey: ['person', personId] }),
      ]),
  });
  return (
    <section aria-label="Exit">
      {mine.length === 0 && <Empty>No exits.</Empty>}
      <ul className="rows">
        {mine.map((x) => (
          <li key={x.id}>
            <Link to={`/exits/${x.id}`} className="row">
              <span className="row-main">
                <strong>
                  {x.kind === 'resignation' ? 'Resignation' : 'Termination'},{' '}
                  {formatDate(x.resignationDate)}
                </strong>
                <span className="muted">
                  {x.lastWorkingDate
                    ? `Last day ${formatDate(x.lastWorkingDate)}`
                    : 'Last day not fixed'}
                </span>
              </span>
              <Chip tone={exitWords[x.status][1]}>{exitWords[x.status][0]}</Chip>
            </Link>
          </li>
        ))}
      </ul>
      {hasRole(me, 'hr_head') && active && (
        <form
          className="inline-form"
          aria-label="End employment"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (
              window.confirm('End this person’s employment? A termination letter is generated.')
            ) {
              terminate.mutate();
            }
          }}
        >
          <h3>End employment</h3>
          <div className="form-grid">
            <Field label="Last working day">
              {(id) => (
                <input
                  id={id}
                  type="date"
                  required
                  value={form.lastWorkingDate}
                  onChange={(e) => setForm({ ...form, lastWorkingDate: e.target.value })}
                />
              )}
            </Field>
            <Field label="Reason" hint="Kept for HR; on the termination record">
              {(id) => (
                <textarea
                  id={id}
                  required
                  minLength={3}
                  rows={2}
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                />
              )}
            </Field>
          </div>
          <button className="button button-primary" disabled={terminate.isPending}>
            End employment
          </button>
          {terminate.error && <Note kind="error">{errorMessage(terminate.error)}</Note>}
        </form>
      )}
    </section>
  );
}
