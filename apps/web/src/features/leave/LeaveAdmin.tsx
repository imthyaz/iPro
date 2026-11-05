import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { LeaveImportResult, LeaveTypeInput, LeaveTypeView } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { hasRole, useMe } from '../../auth.js';
import { Chip, Empty, Field, ListDetail, Note, todayIso } from '../../design-system/index.js';

const kindWords: Record<LeaveTypeInput['kind'], string> = {
  accrued: 'Accrued monthly',
  granted: 'Granted (e.g. for working a day off)',
  per_request: 'Fixed days per request',
  unlimited: 'Unlimited, unpaid',
};

/** One line on what a type gives, e.g. "15 a year, monthly · after confirmation · carry 30". */
function summary(t: LeaveTypeView): string {
  const parts: string[] = [];
  if (t.kind === 'accrued') {
    parts.push(
      `${t.daysPerYear} a year, credited at the ${t.creditOn === 'month_start' ? 'start' : 'end'} of each month`,
    );
  }
  if (t.maxBalance !== null) parts.push(`up to ${t.maxBalance} held`);
  if (t.kind === 'per_request') parts.push(`up to ${t.maxDaysPerRequest} days a request`);
  if (t.kind === 'granted') parts.push('granted');
  if (t.kind === 'unlimited') parts.push('unpaid');
  if (t.accruesAfterConfirmation) parts.push('after confirmation');
  if (!t.availableOnProbation) parts.push('not on probation');
  if (t.kind === 'accrued' || t.kind === 'granted') {
    parts.push(
      t.carryForwardCap === null
        ? 'carries forward'
        : t.carryForwardCap === 0
          ? 'lapses at year end'
          : `carries up to ${t.carryForwardCap}`,
    );
  }
  if (t.expiresAfterDays) parts.push(`expires after ${t.expiresAfterDays} days`);
  if (t.documentAfterDays !== null) parts.push(`document after ${t.documentAfterDays} days`);
  if (t.encashable) parts.push('encashable');
  return parts.join(' · ');
}

/** A2 Leave types (decision #71): configuration; admins and HR head edit, admins add. */
export function LeaveTypes() {
  const { typeId } = useParams();
  const navigate = useNavigate();
  const me = useMe().data;
  const types = useQuery({
    queryKey: ['leave-types'],
    queryFn: () => api<LeaveTypeView[]>('/leave-types'),
  });
  const chosen = types.data?.find((t) => t.id === typeId) ?? null;
  const list = (
    <>
      <div className="toolbar">
        <h1>Leave types</h1>
      </div>
      {types.error && <Note kind="error">{errorMessage(types.error)}</Note>}
      <ul className="rows" aria-label="Leave types">
        {types.data?.map((t) => (
          <li key={t.id}>
            <Link
              to={`/leave-types/${t.id}`}
              className={t.id === typeId ? 'row row-selected' : 'row'}
            >
              <span className="row-main">
                <strong>
                  {t.name} <span className="muted">{t.code}</span>
                </strong>
                <span className="muted">{summary(t)}</span>
              </span>
              {!t.active && <Chip tone="muted">Inactive</Chip>}
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
        chosen ? (
          <EditType key={chosen.id} type={chosen} canEdit={hasRole(me, 'admin', 'hr_head')} />
        ) : null
      }
      onClose={() => navigate('/leave-types')}
      detailLabel="Leave type"
    />
  );
}

function EditType({ type, canEdit }: { type: LeaveTypeView; canEdit: boolean }) {
  const client = useQueryClient();
  const { id: _id, sortOrder: _s, ...initial } = type;
  const [form, setForm] = useState<LeaveTypeInput>(initial);
  const save = useMutation({
    mutationFn: () => api<LeaveTypeView>(`/leave-types/${type.id}`, { method: 'PUT', body: form }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['leave-types'] }),
  });
  const num = (key: keyof LeaveTypeInput, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      {(id) => (
        <input
          id={id}
          type="number"
          step="0.5"
          min={0}
          disabled={!canEdit}
          value={(form[key] as number | null) ?? ''}
          onChange={(e) =>
            setForm({ ...form, [key]: e.target.value === '' ? null : Number(e.target.value) })
          }
        />
      )}
    </Field>
  );
  const check = (key: keyof LeaveTypeInput, label: string) => (
    <label className="check">
      <input
        type="checkbox"
        disabled={!canEdit}
        checked={Boolean(form[key])}
        onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
      />
      {label}
    </label>
  );
  return (
    <article className="record">
      <header className="record-header">
        <h2>{type.name}</h2>
        <p className="muted">
          {type.code} · {kindWords[type.kind]}
        </p>
      </header>
      <form
        className="inline-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="form-grid">
          <Field label="Name">
            {(id) => (
              <input
                id={id}
                required
                disabled={!canEdit}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            )}
          </Field>
          {type.kind === 'accrued' && num('daysPerYear', 'Days a year', 'Credited monthly')}
          {type.kind === 'accrued' && (
            <Field label="Credited" hint="Each month’s share">
              {(id) => (
                <select
                  id={id}
                  disabled={!canEdit}
                  value={form.creditOn}
                  onChange={(e) =>
                    setForm({ ...form, creditOn: e.target.value as LeaveTypeInput['creditOn'] })
                  }
                >
                  <option value="month_start">At the start of the month, in advance</option>
                  <option value="month_end">At the end of the month, for the month worked</option>
                </select>
              )}
            </Field>
          )}
          {type.kind === 'per_request' && num('maxDaysPerRequest', 'Days a request')}
          {(type.kind === 'accrued' || type.kind === 'granted') &&
            num('carryForwardCap', 'Carry forward up to', '0 lapses all; blank carries all')}
          {type.kind === 'accrued' && num('maxBalance', 'Maximum balance', 'Blank for no cap')}
          {num('documentAfterDays', 'Document after (days)', 'Blank if never needed')}
          {type.kind === 'granted' && num('expiresAfterDays', 'Expires after (days)')}
        </div>
        {type.kind === 'accrued' &&
          check('accruesAfterConfirmation', 'Accrues only after confirmation')}
        {check('availableOnProbation', 'Can be taken on probation')}
        {check('encashable', 'Encashable at exit')}
        {check('allowNegative', 'May go below zero')}
        {check('active', 'Active')}
        {canEdit && (
          <button className="button button-primary" disabled={save.isPending}>
            Save
          </button>
        )}
        {save.isSuccess && <Note kind="info">Saved. It applies from the next accrual.</Note>}
        {save.error && <Note kind="error">{errorMessage(save.error)}</Note>}
      </form>
    </article>
  );
}

/** Cut-over (spec migration step 6): paste or choose the old system's balances, check, then apply. */
export function LeaveImport() {
  const client = useQueryClient();
  const [csv, setCsv] = useState('');
  const [asOf, setAsOf] = useState(todayIso());
  const [result, setResult] = useState<LeaveImportResult | null>(null);
  const send = useMutation({
    mutationFn: (commit: boolean) =>
      api<LeaveImportResult>('/leave/balances/import', { body: { csv, asOf, commit } }),
    onSuccess: (r) => {
      setResult(r);
      if (r.committed) void client.invalidateQueries({ queryKey: ['leave-balances'] });
    },
  });
  return (
    <main className="page">
      <h1>Import leave balances</h1>
      <p className="muted">
        A CSV with the columns <code>employee_code</code>, <code>leave_type</code> (e.g. CL, SL, EL)
        and <code>balance</code> in days. Each balance is set to the file’s value as of the date;
        months up to then aren’t credited again. Check first; nothing changes until you apply.
      </p>
      <form
        className="inline-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          send.mutate(false);
        }}
      >
        <div className="form-grid">
          <Field label="Balances as of">
            {(id) => (
              <input
                id={id}
                type="date"
                required
                value={asOf}
                onChange={(e) => {
                  setAsOf(e.target.value);
                  setResult(null);
                }}
              />
            )}
          </Field>
          <Field label="CSV file">
            {(id) => (
              <input
                id={id}
                type="file"
                accept=".csv,text/csv"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setCsv(await file.text());
                    setResult(null);
                  }
                }}
              />
            )}
          </Field>
        </div>
        <Field label="Or paste the CSV">
          {(id) => (
            <textarea
              id={id}
              rows={8}
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setResult(null);
              }}
            />
          )}
        </Field>
        <div className="form-actions">
          <button className="button" disabled={!csv || send.isPending}>
            Check
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={!result || result.committed || result.errors.length > 0 || send.isPending}
            onClick={() => send.mutate(true)}
          >
            Apply {result?.changes.length ?? 0} changes
          </button>
        </div>
      </form>
      {send.error && <Note kind="error">{errorMessage(send.error)}</Note>}
      {result && (
        <section aria-label="Import check">
          {result.committed && <Note kind="info">Applied {result.changes.length} changes.</Note>}
          {result.errors.length > 0 && (
            <>
              <h2>Fix these first ({result.errors.length})</h2>
              <ul className="rows" aria-label="Import errors">
                {result.errors.map((e) => (
                  <li key={e.line} className="row">
                    <span className="row-main">
                      <strong>Line {e.line}</strong>
                      <span>{e.message}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h2>
            {result.rows} rows; {result.changes.length} balances change
          </h2>
          {result.changes.length === 0 && <Empty>Every balance already matches the file.</Empty>}
          <ul className="rows" aria-label="Balance changes">
            {result.changes.map((c) => (
              <li key={c.line} className="row">
                <span className="row-main">
                  <strong>
                    {c.employeeCode} · {c.leaveType}
                  </strong>
                  <span className="muted">
                    {c.from} → {c.to}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
