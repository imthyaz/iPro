import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { AppliesTo, PolicyStatusView } from '@ipro/shared';
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
import { AppliesToEditor, describeAppliesTo, useOrgLookups } from './AppliesTo.js';

/**
 * Policy documents (A2): admins and HR head publish versions; HR sees who has accepted the current
 * version and who is still pending.
 */
export function PolicyAdmin() {
  const { policyId } = useParams();
  const navigate = useNavigate();
  const me = useMe().data;
  const canEdit = hasRole(me, 'admin', 'hr_head');
  const lookups = useOrgLookups();
  const [adding, setAdding] = useState(false);
  const policies = useQuery({
    queryKey: ['policies'],
    queryFn: () => api<PolicyStatusView[]>('/policies'),
  });

  const list = (
    <>
      <div className="toolbar">
        <h1>Policy documents</h1>
        {canEdit && !adding && (
          <button className="button button-primary" onClick={() => setAdding(true)}>
            New policy
          </button>
        )}
      </div>
      {adding && <NewPolicy onDone={() => setAdding(false)} />}
      {policies.error && <Note kind="error">{errorMessage(policies.error)}</Note>}
      {policies.data?.length === 0 && <Empty>No policies yet.</Empty>}
      <ul className="rows" aria-label="Policies">
        {policies.data?.map((p) => (
          <li key={p.policyId}>
            <Link
              to={`/policy-admin/${p.policyId}`}
              className={p.policyId === policyId ? 'row row-selected' : 'row'}
              aria-current={p.policyId === policyId ? 'true' : undefined}
            >
              <span className="row-main">
                <strong>{p.title}</strong>
                <span className="muted">
                  {p.code} · {describeAppliesTo(p.appliesTo, lookups)} ·{' '}
                  {p.current ? `v${p.current.version}` : 'not published'}
                </span>
              </span>
              <span className="row-side">
                {p.current && p.requiresAcknowledgement && (
                  <Chip tone={p.pending.length ? 'warn' : 'ok'}>
                    {p.pending.length
                      ? `${p.pending.length} pending`
                      : `${p.accepted.length} accepted`}
                  </Chip>
                )}
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
      detail={policyId ? <PolicyDetail policyId={policyId} canEdit={canEdit} /> : null}
      onClose={() => navigate('/policy-admin')}
      detailLabel="Policy"
    />
  );
}

function NewPolicy({ onDone }: { onDone: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [appliesTo, setAppliesTo] = useState<AppliesTo>({});
  const [requiresAcknowledgement, setRequires] = useState(true);
  const create = useMutation({
    mutationFn: () =>
      api<PolicyStatusView>('/policies', {
        body: { code, title, appliesTo, requiresAcknowledgement },
      }),
    onSuccess: (policy) => {
      // Open it now; the list refreshes behind (it can take a while with many policies).
      void client.invalidateQueries({ queryKey: ['policies'] });
      onDone();
      navigate(`/policy-admin/${policy.policyId}`);
    },
  });
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h3>New policy</h3>
      <div className="form-grid">
        <Field label="Code" hint="Letters, digits, - and _">
          {(id) => (
            <input id={id} required value={code} onChange={(e) => setCode(e.target.value)} />
          )}
        </Field>
        <Field label="Title">
          {(id) => (
            <input id={id} required value={title} onChange={(e) => setTitle(e.target.value)} />
          )}
        </Field>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={requiresAcknowledgement}
          onChange={(e) => setRequires(e.target.checked)}
        />
        People must read and accept it
      </label>
      <AppliesToEditor value={appliesTo} onChange={setAppliesTo} />
      <div className="form-actions">
        <button className="button button-primary" disabled={create.isPending}>
          Create policy
        </button>
        <button type="button" className="button button-quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
      {create.error && <Note kind="error">{errorMessage(create.error)}</Note>}
    </form>
  );
}

function PolicyDetail({ policyId, canEdit }: { policyId: string; canEdit: boolean }) {
  const lookups = useOrgLookups();
  const policy = useQuery({
    queryKey: ['policy', policyId],
    queryFn: () => api<PolicyStatusView>(`/policies/${policyId}`),
  });
  if (policy.error) return <Note kind="error">{errorMessage(policy.error)}</Note>;
  if (!policy.data) return <p className="muted">Loading…</p>;
  const p = policy.data;

  return (
    <article className="record">
      <header className="record-header">
        <h2>{p.title}</h2>
        <p className="muted">
          {p.code} · applies to {describeAppliesTo(p.appliesTo, lookups)}
        </p>
        <p>
          {p.requiresAcknowledgement ? (
            <Chip tone="info">Acceptance required</Chip>
          ) : (
            <Chip tone="muted">For information</Chip>
          )}
        </p>
      </header>
      {canEdit && <Publish policyId={p.policyId} nextVersion={(p.current?.version ?? 0) + 1} />}

      {p.current && p.requiresAcknowledgement && (
        <>
          <h3>
            Version {p.current.version}: {p.pending.length} pending, {p.accepted.length} accepted
          </h3>
          {p.pending.length > 0 && (
            <ul className="rows" aria-label="Pending">
              {p.pending.map((person) => (
                <li key={person.personId} className="row">
                  <span className="row-main">
                    <Link to={`/people/${person.personId}`}>{person.name}</Link>
                    <span className="muted">{person.employeeCode}</span>
                  </span>
                  <Chip tone="warn">Pending</Chip>
                </li>
              ))}
            </ul>
          )}
          {p.accepted.length > 0 && (
            <ul className="rows" aria-label="Accepted">
              {p.accepted.map((person) => (
                <li key={person.personId} className="row">
                  <span className="row-main">{person.name}</span>
                  <Chip tone="ok">Accepted {formatDate(person.acceptedAt)}</Chip>
                </li>
              ))}
            </ul>
          )}
          {p.pending.length + p.accepted.length === 0 && (
            <Empty>Names show for people you may see (HR and HR head).</Empty>
          )}
        </>
      )}

      <h3>Versions</h3>
      {p.versions.length === 0 ? (
        <Empty>Not published yet.</Empty>
      ) : (
        <ol className="timeline" aria-label="Versions">
          {p.versions.map((v) => (
            <li key={v.id}>
              <strong>Version {v.version}</strong> · in force from {formatDate(v.effectiveFrom)} ·{' '}
              {v.fileName}
              <div className="muted">
                Published {formatDate(v.publishedAt)}
                {v.summary ? ` · ${v.summary}` : ''}
              </div>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

/** Publishing a new version asks everyone it applies to for acceptance again (decision #52). */
function Publish({ policyId, nextVersion }: { policyId: string; nextVersion: number }) {
  const client = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [summary, setSummary] = useState('');
  const publish = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.set('file', file!);
      form.set('effectiveFrom', effectiveFrom);
      if (summary.trim()) form.set('summary', summary.trim());
      return api<PolicyStatusView>(`/policies/${policyId}/versions`, { form });
    },
    onSuccess: (view) => {
      setFile(null);
      setSummary('');
      client.setQueryData(['policy', policyId], view);
      return client.invalidateQueries({ queryKey: ['policies'] });
    },
  });
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (
          nextVersion === 1 ||
          window.confirm(
            `Publish version ${nextVersion}? Everyone it applies to will be asked to accept it again.`,
          )
        ) {
          publish.mutate();
        }
      }}
    >
      <h3>Publish version {nextVersion}</h3>
      <div className="form-grid">
        <Field label="PDF">
          {(id) => (
            <input
              id={id}
              type="file"
              accept="application/pdf"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          )}
        </Field>
        <Field label="In force from">
          {(id) => (
            <input
              id={id}
              type="date"
              required
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          )}
        </Field>
      </div>
      <Field label="What changed" hint="Optional; people see this with the policy.">
        {(id) => (
          <textarea id={id} rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} />
        )}
      </Field>
      <button className="button button-primary" disabled={!file || publish.isPending}>
        Publish
      </button>
      {publish.error && <Note kind="error">{errorMessage(publish.error)}</Note>}
    </form>
  );
}
