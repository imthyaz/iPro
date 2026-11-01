import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ChecklistRunView, ChecklistTaskView, PersonSummary } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { hasRole, useMe } from '../../auth.js';
import {
  Chip,
  DueChip,
  Empty,
  Field,
  formatDate,
  ListDetail,
  Note,
  todayIso,
} from '../../design-system/index.js';

const useRuns = () =>
  useQuery({
    queryKey: ['checklist-runs'],
    queryFn: () => api<ChecklistRunView[]>('/checklist-runs'),
  });

/** Open checklists (onboarding, exit, transfer), overdue first, with the tasks in the side panel. */
export function ChecklistRuns() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const me = useMe().data;
  const canManage = hasRole(me, 'hr', 'hr_head');
  const [starting, setStarting] = useState(false);
  const [stage, setStage] = useState('');
  const runs = useRuns();
  const sorted = [...(runs.data ?? [])]
    .filter((r) => !stage || r.stage === stage)
    .sort(
      (a, b) => b.progress.overdue - a.progress.overdue || a.anchorDate.localeCompare(b.anchorDate),
    );
  const run = runs.data?.find((r) => r.id === runId);

  const list = (
    <>
      <div className="toolbar">
        <h1>Checklists</h1>
        {canManage && !starting && (
          <button className="button button-primary" onClick={() => setStarting(true)}>
            Start a checklist
          </button>
        )}
      </div>
      {starting && <StartChecklist onDone={() => setStarting(false)} />}
      <div className="filters">
        <Field label="Stage">
          {(id) => (
            <select id={id} value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="">All</option>
              <option value="onboarding">Onboarding</option>
              <option value="exit">Exit</option>
              <option value="transfer">Transfer</option>
              <option value="access">Access (IT)</option>
            </select>
          )}
        </Field>
      </div>
      {runs.error && <Note kind="error">{errorMessage(runs.error)}</Note>}
      {runs.data?.length === 0 && <Empty>No open checklists.</Empty>}
      <ul className="rows" aria-label="Checklists">
        {sorted.map((r) => (
          <li key={r.id}>
            <Link
              to={`/checklists/${r.id}`}
              className={r.id === runId ? 'row row-selected' : 'row'}
              aria-current={r.id === runId ? 'true' : undefined}
            >
              <span className="row-main">
                <strong>{r.person.name}</strong>
                <span className="muted">
                  {r.templateName} · from {formatDate(r.anchorDate)}
                </span>
              </span>
              <span className="row-side">
                {r.progress.overdue > 0 && <Chip tone="warn">{r.progress.overdue} overdue</Chip>}
                <Chip tone="muted">
                  {r.progress.done}/{r.progress.total} done
                </Chip>
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
      detail={
        runId ? (
          run ? (
            <RunDetail run={run} canManage={canManage} />
          ) : (
            <p className="muted">{runs.data ? 'This checklist is closed.' : 'Loading…'}</p>
          )
        ) : null
      }
      onClose={() => navigate('/checklists')}
      detailLabel="Checklist"
    />
  );
}

function RunDetail({ run, canManage }: { run: ChecklistRunView; canManage: boolean }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => api(`/checklist-runs/${run.id}/cancel`, { body: { reason } }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['checklist-runs'] });
      navigate('/checklists');
    },
  });
  return (
    <article className="record">
      <header className="record-header">
        <h2>
          {run.templateName}: <Link to={`/people/${run.person.personId}`}>{run.person.name}</Link>
        </h2>
        <p className="muted">
          Template v{run.templateVersion} · from {formatDate(run.anchorDate)} · {run.progress.done}{' '}
          of {run.progress.total} done
        </p>
      </header>
      <ul className="cards" aria-label="Tasks">
        {run.tasks.map((task) => (
          <RunTask key={task.id} task={task} canWaive={canManage} />
        ))}
      </ul>
      {canManage && (
        <form
          className="inline-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (
              window.confirm('Cancel this checklist? Open tasks close and this can’t be undone.')
            ) {
              cancel.mutate();
            }
          }}
        >
          <Field label="Reason to cancel the checklist">
            {(id) => (
              <input id={id} required value={reason} onChange={(e) => setReason(e.target.value)} />
            )}
          </Field>
          <button className="button" disabled={cancel.isPending || !reason.trim()}>
            Cancel checklist
          </button>
          {cancel.error && <Note kind="error">{errorMessage(cancel.error)}</Note>}
        </form>
      )}
    </article>
  );
}

function RunTask({ task, canWaive }: { task: ChecklistTaskView; canWaive: boolean }) {
  const client = useQueryClient();
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState('');
  const waive = useMutation({
    mutationFn: () => api(`/checklist-tasks/${task.id}/waive`, { body: { reason } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['checklist-runs'] }),
  });
  return (
    <li className="card" aria-label={task.title}>
      <div className="card-head">
        <strong>{task.title}</strong>
        {task.status === 'done' && <Chip tone="ok">Done {formatDate(task.doneAt)}</Chip>}
        {task.status === 'waived' && <Chip tone="muted">Waived</Chip>}
        {task.status === 'open' && <DueChip dueOn={task.dueOn} overdue={task.overdue} />}
      </div>
      <span className="muted">
        {task.owner}
        {task.mandatory ? '' : ' · optional'}
        {task.requiresDocument ? ' · needs a document' : ''}
        {task.doneBy ? ` · by ${task.doneBy}` : ''}
        {task.waiveReason ? ` · ${task.waiveReason}` : ''}
      </span>
      {canWaive && task.status === 'open' && !waiving && (
        <div className="form-actions">
          <button className="button button-quiet" onClick={() => setWaiving(true)}>
            Waive…
          </button>
        </div>
      )}
      {waiving && (
        <form
          className="inline-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            waive.mutate();
          }}
        >
          <Field label="Why is it not needed?">
            {(id) => (
              <input id={id} required value={reason} onChange={(e) => setReason(e.target.value)} />
            )}
          </Field>
          <div className="form-actions">
            <button className="button" disabled={waive.isPending || !reason.trim()}>
              Waive task
            </button>
            <button type="button" className="button button-quiet" onClick={() => setWaiving(false)}>
              Keep it
            </button>
          </div>
          {waive.error && <Note kind="error">{errorMessage(waive.error)}</Note>}
        </form>
      )}
    </li>
  );
}

function StartChecklist({ onDone }: { onDone: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [personId, setPersonId] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [anchorDate, setAnchorDate] = useState(todayIso());
  const people = useQuery({
    queryKey: ['people', q, ''],
    queryFn: () =>
      api<PersonSummary[]>(`/people?${new URLSearchParams(q.trim() ? { q: q.trim() } : {})}`),
  });
  const templates = useQuery({
    queryKey: ['checklist-templates'],
    queryFn: () => api<{ key: string; name: string }[]>('/checklist-templates'),
  });
  const start = useMutation({
    mutationFn: () =>
      api<ChecklistRunView>(`/people/${personId}/checklists`, {
        body: { templateKey, anchorDate },
      }),
    onSuccess: async (run) => {
      await client.invalidateQueries({ queryKey: ['checklist-runs'] });
      onDone();
      navigate(`/checklists/${run.id}`);
    },
  });
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        start.mutate();
      }}
    >
      <h3>Start a checklist</h3>
      <div className="form-grid">
        <Field label="Find a person">
          {(id) => <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} />}
        </Field>
        <Field label="Person">
          {(id) => (
            <select id={id} required value={personId} onChange={(e) => setPersonId(e.target.value)}>
              <option value="">Choose a person</option>
              {people.data?.map((p) => (
                <option key={p.personId} value={p.personId}>
                  {p.preferredName ?? p.legalName} ({p.employeeCode})
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Checklist">
          {(id) => (
            <select
              id={id}
              required
              value={templateKey}
              onChange={(e) => setTemplateKey(e.target.value)}
            >
              <option value="">Choose a template</option>
              {templates.data?.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Count due dates from" hint="E.g. the joining date or last working day.">
          {(id) => (
            <input
              id={id}
              type="date"
              required
              value={anchorDate}
              onChange={(e) => setAnchorDate(e.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="form-actions">
        <button className="button button-primary" disabled={start.isPending}>
          Start
        </button>
        <button type="button" className="button button-quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
      {start.error && <Note kind="error">{errorMessage(start.error)}</Note>}
    </form>
  );
}
