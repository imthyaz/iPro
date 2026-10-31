import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { CreatePersonInput, PersonFormOptions, PersonSummary } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { Field, Note, todayIso } from '../../design-system/index.js';
import { rupeesToPaise } from '../../money.js';

const engagementTypes = [
  ['permanent', 'Permanent'],
  ['fixed_term', 'Fixed-term'],
  ['intern', 'Intern'],
  ['trainee', 'Trainee'],
  ['retainer', 'Retainer'],
  ['consultant', 'Consultant'],
] as const;

/**
 * New person in one screen (done-when: under 3 minutes): person, engagement and first assignment.
 * The employee code, probation end and notice period come from policy, so they aren't asked.
 */
export function NewPerson() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const options = useQuery({
    queryKey: ['person-form-options'],
    queryFn: () => api<PersonFormOptions>('/people/form-options'),
  });
  const [form, setForm] = useState({
    legalName: '',
    workEmail: '',
    personalEmail: '',
    type: 'permanent' as CreatePersonInput['engagement']['type'],
    joiningDate: todayIso(),
    legalEntityId: '',
    designationId: '',
    departmentId: '',
    locationId: '',
    managerEngagementId: '',
    bucket: 'billable',
    ctc: '',
  });
  const [ctcError, setCtcError] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const o = options.data;

  const create = useMutation({
    mutationFn: (input: CreatePersonInput) => api<PersonSummary>('/people', { body: input }),
    onSuccess: async (person) => {
      await client.invalidateQueries({ queryKey: ['people'] });
      navigate(`/people/${person.personId}`);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const paise = form.ctc.trim() ? rupeesToPaise(form.ctc) : null;
    setCtcError(Boolean(form.ctc.trim()) && !paise);
    if (form.ctc.trim() && !paise) return;
    create.mutate({
      person: { legalName: form.legalName, personalEmail: form.personalEmail || null },
      engagement: {
        // With one legal entity (Phase 1) there is nothing to choose.
        legalEntityId: form.legalEntityId || (o?.legalEntities[0]?.id ?? ''),
        type: form.type,
        workEmail: form.workEmail || null,
        joiningDate: form.joiningDate,
      },
      assignment: {
        designationId: form.designationId,
        departmentId: form.departmentId,
        locationId: form.locationId,
        managerEngagementId: form.managerEngagementId || null,
        bucket: form.bucket,
      },
      ...(paise
        ? {
            compensation: {
              amount: paise,
              rateUnit: form.type === 'retainer' || form.type === 'consultant' ? 'month' : 'year',
            },
          }
        : {}),
    });
  }

  if (options.error) return <Note kind="error">{errorMessage(options.error)}</Note>;
  const retainerLike = form.type === 'retainer' || form.type === 'consultant';

  return (
    <main className="page">
      <h1>New person</h1>
      <p className="muted">
        Creates the person, their engagement and first role, and a Joined event. The employee code
        is issued automatically.
      </p>
      <form className="form-grid" onSubmit={submit}>
        <Field label="Legal name">
          {(id) => (
            <input id={id} value={form.legalName} onChange={set('legalName')} required autoFocus />
          )}
        </Field>
        <Field
          label="Work email"
          hint="Their Microsoft sign-in; links their account to this record"
        >
          {(id) => (
            <input id={id} type="email" value={form.workEmail} onChange={set('workEmail')} />
          )}
        </Field>
        <Field label="Personal email">
          {(id) => (
            <input
              id={id}
              type="email"
              value={form.personalEmail}
              onChange={set('personalEmail')}
            />
          )}
        </Field>
        <Field label="Engagement type">
          {(id) => (
            <select id={id} value={form.type} onChange={set('type')}>
              {engagementTypes.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Joining date">
          {(id) => (
            <input
              id={id}
              type="date"
              value={form.joiningDate}
              onChange={set('joiningDate')}
              required
            />
          )}
        </Field>
        {o && o.legalEntities.length > 1 && (
          <Field label="Legal entity">
            {(id) => (
              <select id={id} value={form.legalEntityId} onChange={set('legalEntityId')} required>
                <option value="">Choose…</option>
                {o.legalEntities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label="Designation">
          {(id) => (
            <select id={id} value={form.designationId} onChange={set('designationId')} required>
              <option value="">Choose…</option>
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
            <select id={id} value={form.departmentId} onChange={set('departmentId')} required>
              <option value="">Choose…</option>
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
            <select id={id} value={form.locationId} onChange={set('locationId')} required>
              <option value="">Choose…</option>
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
              {o?.managers.map((m) => (
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
        <Field
          label={retainerLike ? 'Monthly retainer (₹, optional)' : 'Annual CTC (₹, optional)'}
          hint="Encrypted; visible to HR, CXO and the person"
        >
          {(id) => (
            <input
              id={id}
              inputMode="decimal"
              value={form.ctc}
              onChange={set('ctc')}
              aria-invalid={ctcError}
              placeholder="12,00,000"
            />
          )}
        </Field>
        {ctcError && <Note kind="error">Enter the amount in rupees, e.g. 12,00,000</Note>}
        <div className="form-actions">
          <button className="button button-primary" disabled={create.isPending || !o}>
            Create person
          </button>
          <button type="button" className="button button-quiet" onClick={() => navigate('/people')}>
            Cancel
          </button>
        </div>
        {create.error && <Note kind="error">{errorMessage(create.error)}</Note>}
      </form>
    </main>
  );
}
