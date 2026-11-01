import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type {
  InLifeChangeInput,
  LetterTemplateView,
  PersonFormOptions,
  PersonSummary,
} from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { Field, Note, todayIso } from '../../design-system/index.js';

type Result = { requestId: string } | { applied: true };

/**
 * Change wizard (H6, spec workflow 8): designation, department, location, manager or bucket from a
 * date, with an optional letter. HR head approves it; HR head's own change applies at once.
 */
export function ChangeWizard({ person, isHrHead }: { person: PersonSummary; isHrHead: boolean }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const options = useQuery({
    queryKey: ['person-form-options'],
    queryFn: () => api<PersonFormOptions>('/people/form-options'),
    enabled: open,
  });
  const templates = useQuery({
    queryKey: ['letter-templates'],
    queryFn: () => api<LetterTemplateView[]>('/letter-templates'),
    enabled: open,
  });
  const current = {
    designationId: person.designation?.id ?? '',
    departmentId: person.department?.id ?? '',
    locationId: person.location?.id ?? '',
    managerEngagementId: person.manager?.engagementId ?? '',
    bucket: person.bucket ?? '',
  };
  const [form, setForm] = useState({ ...current, effectiveFrom: todayIso(), reason: '' });
  const [templateKey, setTemplateKey] = useState('');
  const [extra, setExtra] = useState<Record<string, string>>({});
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const template = templates.data?.find((t) => t.key === templateKey);
  const extraFields = (template?.fields ?? [])
    .filter((f) => f.startsWith('extra.'))
    .map((f) => f.slice(6));
  const changed = (Object.keys(current) as (keyof typeof current)[]).filter(
    (k) => form[k] !== current[k],
  );

  const submit = useMutation({
    mutationFn: () => {
      const body: InLifeChangeInput = {
        effectiveFrom: form.effectiveFrom,
        reason: form.reason,
        ...Object.fromEntries(
          changed.map((k) => [k, k === 'managerEngagementId' && !form[k] ? null : form[k]]),
        ),
        ...(templateKey
          ? {
              letterTemplateKey: templateKey,
              extra: Object.fromEntries(extraFields.map((f) => [f, extra[f] ?? ''])),
            }
          : {}),
      };
      return api<Result>(`/people/${person.personId}/changes`, { body });
    },
    onSuccess: () => {
      setOpen(false);
      return Promise.all([
        client.invalidateQueries({ queryKey: ['assignments', person.personId] }),
        client.invalidateQueries({ queryKey: ['person', person.personId] }),
        client.invalidateQueries({ queryKey: ['requests'] }),
      ]);
    },
  });
  const o = options.data;

  if (!open) {
    return (
      <>
        {submit.data && 'requestId' in submit.data && (
          <Note kind="info">
            Sent to HR head for approval.{' '}
            <Link to={`/requests/${submit.data.requestId}`}>Follow the request</Link>
          </Note>
        )}
        {submit.data && 'applied' in submit.data && <Note kind="info">Change recorded.</Note>}
        <button className="button" onClick={() => setOpen(true)}>
          Change role…
        </button>
      </>
    );
  }

  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        submit.mutate();
      }}
    >
      <h3>Change role</h3>
      <p className="muted">
        {isHrHead
          ? 'As HR head, your change is recorded at once.'
          : 'HR head approves the change before it applies.'}{' '}
        A future date shows as upcoming on the journey and applies by itself that day.
      </p>
      <div className="form-grid">
        <Field label="Effective from">
          {(id) => (
            <input
              id={id}
              type="date"
              required
              value={form.effectiveFrom}
              onChange={set('effectiveFrom')}
            />
          )}
        </Field>
        <Field label="Reason" hint="Shown on the journey, e.g. Promotion">
          {(id) => <input id={id} required value={form.reason} onChange={set('reason')} />}
        </Field>
        <Field label="Designation">
          {(id) => (
            <select id={id} value={form.designationId} onChange={set('designationId')}>
              {o?.designations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Department">
          {(id) => (
            <select id={id} value={form.departmentId} onChange={set('departmentId')}>
              {o?.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Location">
          {(id) => (
            <select id={id} value={form.locationId} onChange={set('locationId')}>
              {o?.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Reports to">
          {(id) => (
            <select id={id} value={form.managerEngagementId} onChange={set('managerEngagementId')}>
              <option value="">No manager</option>
              {o?.managers
                .filter((m) => m.engagementId !== person.engagementId)
                .map((m) => (
                  <option key={m.engagementId} value={m.engagementId}>
                    {m.name} ({m.employeeCode})
                  </option>
                ))}
            </select>
          )}
        </Field>
        <Field label="Bucket">
          {(id) => (
            <select id={id} value={form.bucket} onChange={set('bucket')}>
              {o?.buckets.map((b) => (
                <option key={b} value={b}>
                  {b.replace('_', '-')}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Letter" hint="Optional; made when the change is approved">
          {(id) => (
            <select
              id={id}
              value={templateKey}
              onChange={(e) => {
                setTemplateKey(e.target.value);
                setExtra({});
              }}
            >
              <option value="">No letter</option>
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
      </div>
      <div className="form-actions">
        <button
          className="button button-primary"
          disabled={submit.isPending || changed.length === 0}
        >
          {isHrHead ? 'Record change' : 'Send for approval'}
        </button>
        <button type="button" className="button button-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {changed.length === 0 && <span className="muted field-hint">Change at least one thing.</span>}
      {submit.error && <Note kind="error">{errorMessage(submit.error)}</Note>}
    </form>
  );
}
