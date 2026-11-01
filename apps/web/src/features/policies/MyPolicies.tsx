import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { MyPolicyView } from '@ipro/shared';
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

  return (
    <main className="page">
      <h1>Policies</h1>
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
