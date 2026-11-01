import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  describeWorkingWeek,
  type LetterTemplateView,
  type LetterView,
  type ShiftAllocationView,
} from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { Chip, Empty, Field, formatDate, Note } from '../../design-system/index.js';

/** A person's shifts over time (decision #46). */
export function ShiftHistory({ personId }: { personId: string }) {
  const rows = useQuery({
    queryKey: ['person-shifts', personId],
    queryFn: () => api<ShiftAllocationView[]>(`/people/${personId}/shifts`),
  });
  if (rows.error) return <Note kind="error">{errorMessage(rows.error)}</Note>;
  if (rows.data?.length === 0) return <Empty>On the default shift; no allocations.</Empty>;
  return (
    <ol className="timeline" aria-label="Shifts">
      {[...(rows.data ?? [])].reverse().map((a) => (
        <li key={a.id}>
          <strong>{a.shiftName}</strong> · {describeWorkingWeek(a.weeklyOffs)} · {a.startTime}–
          {a.endTime} {a.customTimes && <Chip tone="info">Own times</Chip>}
          <div className="muted">
            {formatDate(a.effectiveFrom)} – {a.effectiveTo ? formatDate(a.effectiveTo) : 'now'} ·{' '}
            {a.reason}
          </div>
        </li>
      ))}
    </ol>
  );
}

const letterWords: Record<LetterView['status'], [string, 'ok' | 'info' | 'warn' | 'muted']> = {
  pending_approval: ['Waiting for approval', 'info'],
  ready: ['Ready', 'info'],
  sent: ['Sent for signature', 'info'],
  signed: ['Signed', 'ok'],
  declined: ['Declined', 'warn'],
  returned: ['Returned', 'warn'],
  cancelled: ['Cancelled', 'muted'],
};

/** Letters for a person (HR): generate from a template, send for e-signature, open the PDF. */
export function Letters({ personId }: { personId: string }) {
  const client = useQueryClient();
  const letters = useQuery({
    queryKey: ['letters', personId],
    queryFn: () => api<LetterView[]>(`/people/${personId}/letters`),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['letters', personId] });
  const open = useMutation({
    mutationFn: (documentId: string) =>
      api<{ url: string }>(`/people/${personId}/documents/${documentId}/link`, { method: 'POST' }),
    onSuccess: ({ url }) => window.open(url, '_blank', 'noopener'),
  });
  const send = useMutation({
    mutationFn: (id: string) => api(`/letters/${id}/send`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/letters/${id}/cancel`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const error = open.error ?? send.error ?? cancel.error;

  return (
    <>
      <NewLetter personId={personId} onDone={refresh} />
      {letters.error && <Note kind="error">{errorMessage(letters.error)}</Note>}
      {letters.data?.length === 0 && <Empty>No letters yet.</Empty>}
      <ul className="rows" aria-label="Letters">
        {letters.data?.map((l) => {
          const [word, tone] = letterWords[l.status];
          const live = !['signed', 'cancelled', 'declined'].includes(l.status);
          return (
            <li key={l.id} className="row">
              <span className="row-main">
                <strong>{l.title}</strong>
                <span className="muted">
                  {formatDate(l.createdAt)} · template v{l.templateVersion}
                  {l.signedAt ? ` · signed ${formatDate(l.signedAt)}` : ''}
                </span>
              </span>
              <span className="row-side">
                <Chip tone={tone}>{word}</Chip>
                <button
                  className="button button-quiet"
                  onClick={() => open.mutate(l.signedDocumentId ?? l.documentId)}
                >
                  Open
                </button>
                {l.status === 'ready' && l.needsSignature && (
                  <button
                    className="button"
                    disabled={send.isPending}
                    onClick={() => send.mutate(l.id)}
                  >
                    Send for signature
                  </button>
                )}
                {live && (
                  <button
                    className="button button-quiet"
                    disabled={cancel.isPending}
                    onClick={() => {
                      if (window.confirm(`Cancel “${l.title}”? This can’t be undone.`)) {
                        cancel.mutate(l.id);
                      }
                    }}
                  >
                    Cancel
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {error && <Note kind="error">{errorMessage(error)}</Note>}
    </>
  );
}

function NewLetter({ personId, onDone }: { personId: string; onDone: () => void }) {
  const [templateKey, setTemplateKey] = useState('');
  const [extra, setExtra] = useState<Record<string, string>>({});
  const templates = useQuery({
    queryKey: ['letter-templates'],
    queryFn: () => api<LetterTemplateView[]>('/letter-templates'),
  });
  const template = templates.data?.find((t) => t.key === templateKey);
  const extraFields = (template?.fields ?? [])
    .filter((f) => f.startsWith('extra.'))
    .map((f) => f.slice(6));
  const generate = useMutation({
    mutationFn: () =>
      api<LetterView>(`/people/${personId}/letters`, {
        body: {
          templateKey,
          extra: Object.fromEntries(extraFields.map((f) => [f, extra[f] ?? ''])),
        },
      }),
    onSuccess: () => {
      setTemplateKey('');
      setExtra({});
      onDone();
    },
  });
  if (templates.error || templates.data?.length === 0) return null;

  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        generate.mutate();
      }}
    >
      <Field label="New letter from template">
        {(id) => (
          <select id={id} value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
            <option value="">Choose a template</option>
            {templates.data?.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      {extraFields.map((f) => (
        <Field key={f} label={f.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}>
          {(id) => (
            <input
              id={id}
              required
              value={extra[f] ?? ''}
              onChange={(e) => setExtra({ ...extra, [f]: e.target.value })}
            />
          )}
        </Field>
      ))}
      {template && (
        <p className="muted field-hint">
          {template.approverRole
            ? `Needs ${template.approverRole === 'hr' ? 'HR' : 'HR head'} approval before it can be sent.`
            : 'No approval needed.'}{' '}
          {template.signature === 'employee' ? 'The person signs it electronically.' : ''}
        </p>
      )}
      <button className="button button-primary" disabled={!template || generate.isPending}>
        Generate letter
      </button>
      {generate.error && <Note kind="error">{errorMessage(generate.error)}</Note>}
    </form>
  );
}
