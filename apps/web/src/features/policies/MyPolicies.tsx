import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { MyPolicyView, PolicyClausesView } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { Chip, Empty, formatDate, Note } from '../../design-system/index.js';

/**
 * Policies that apply to me (E11 policy sign-offs). Accepting is of the version I opened: the hash
 * goes with it, and a policy changed since is refused so I read the new one (decision #52).
 */
export function MyPolicies() {
  const policies = useQuery({
    queryKey: ['my-policies'],
    queryFn: () => api<MyPolicyView[]>('/policies/mine'),
  });
  const pending = policies.data?.filter((p) => p.pending) ?? [];
  const others = policies.data?.filter((p) => !p.pending) ?? [];
  const [params, setParams] = useSearchParams();
  const reading = params.get('policy');

  return (
    <main className="page">
      <h1>Policies</h1>
      {reading && (
        <Clauses
          key={`${reading}-${params.get('clause') ?? ''}`}
          policyId={reading}
          clause={Number(params.get('clause')) || null}
          onClose={() => setParams({})}
        />
      )}
      {policies.error && <Note kind="error">{errorMessage(policies.error)}</Note>}
      {policies.data?.length === 0 && <Empty>No policies apply to you yet.</Empty>}
      {pending.length > 0 && (
        <section aria-labelledby="policies-pending">
          <h2 id="policies-pending">To read and accept ({pending.length})</h2>
          <ul className="cards" aria-label="Policies to accept">
            {pending.map((p) => (
              <Policy key={p.policyId} policy={p} />
            ))}
          </ul>
        </section>
      )}
      {others.length > 0 && (
        <section aria-labelledby="policies-other">
          <h2 id="policies-other">All my policies</h2>
          <ul className="cards" aria-label="My policies">
            {others.map((p) => (
              <Policy key={p.policyId} policy={p} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

export function Policy({ policy }: { policy: MyPolicyView }) {
  const client = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const open = useMutation({
    mutationFn: () =>
      api<{ url: string }>(`/policies/versions/${policy.current.id}/link`, { method: 'POST' }),
    onSuccess: ({ url }) => {
      setOpened(true);
      window.open(url, '_blank', 'noopener');
    },
  });
  const accept = useMutation({
    mutationFn: () =>
      api<MyPolicyView[]>(`/policies/versions/${policy.current.id}/accept`, {
        body: { contentHash: policy.current.contentHash },
      }),
    onSuccess: (views) => client.setQueryData(['my-policies'], views),
    onError: () => client.invalidateQueries({ queryKey: ['my-policies'] }),
  });
  const v = policy.current;

  return (
    <li className="card" aria-label={policy.title}>
      <div className="card-head">
        <strong>{policy.title}</strong>
        {policy.acceptedAt ? (
          <Chip tone="ok">Accepted {formatDate(policy.acceptedAt)}</Chip>
        ) : policy.pending ? (
          <Chip tone="warn">To accept</Chip>
        ) : (
          <Chip tone="muted">For information</Chip>
        )}
      </div>
      <span className="muted">
        Version {v.version} · in force from {formatDate(v.effectiveFrom)}
      </span>
      {v.summary && <p>{v.summary}</p>}
      <div className="form-actions">
        <button className="button" disabled={open.isPending} onClick={() => open.mutate()}>
          Open {v.fileName}
        </button>
        {v.textStatus === 'ready' && (
          <Link className="button button-quiet" to={`/policies?policy=${policy.policyId}`}>
            Read as text
          </Link>
        )}
      </div>
      {policy.pending && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={agreed}
              disabled={!opened}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            I have read version {v.version} of {policy.title} and accept it
          </label>
          {!opened && <span className="muted field-hint">Open the policy to accept it.</span>}
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={!agreed || accept.isPending}
              onClick={() => accept.mutate()}
            >
              Accept
            </button>
          </div>
        </>
      )}
      {open.error && <Note kind="error">{errorMessage(open.error)}</Note>}
      {accept.error && <Note kind="error">{errorMessage(accept.error)}</Note>}
    </li>
  );
}

/**
 * A policy's text, clause by clause (decision #89): where Ask iPro's answers link to. The clause an
 * answer came from is highlighted and scrolled into view.
 */
function Clauses({
  policyId,
  clause,
  onClose,
}: {
  policyId: string;
  clause: number | null;
  onClose: () => void;
}) {
  const view = useQuery({
    queryKey: ['policy-clauses', policyId],
    queryFn: () => api<PolicyClausesView>(`/policies/${policyId}/clauses`),
  });
  const target = useRef<HTMLLIElement>(null);
  useEffect(() => {
    target.current?.scrollIntoView?.({ block: 'center' });
  }, [view.data]);
  const v = view.data;
  return (
    <section className="card policy-text" aria-label={v ? `${v.title}, as text` : 'Policy text'}>
      <div className="card-head">
        <strong>{v ? `${v.title} · version ${v.version}` : 'Policy'}</strong>
        <button className="button button-quiet" onClick={onClose}>
          Close
        </button>
      </div>
      {view.error && <Note kind="error">{errorMessage(view.error)}</Note>}
      {v && v.clauses.length === 0 && (
        <Empty>No text could be read from {v.fileName}; open the file instead.</Empty>
      )}
      {v && v.clauses.length > 0 && (
        <ol className="clauses" aria-label="Clauses">
          {v.clauses.map((c) => (
            <li
              key={c.position}
              ref={c.position === clause ? target : undefined}
              className={c.position === clause ? 'clause clause-target' : 'clause'}
              aria-current={c.position === clause ? 'true' : undefined}
            >
              <strong>
                {c.number ? `${c.number} ` : ''}
                {c.heading}
              </strong>
              {c.body && <p>{c.body}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
