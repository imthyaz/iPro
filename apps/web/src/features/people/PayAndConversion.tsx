import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type {
  ChangeRequestResult,
  ConversionRequestInput,
  PayChangeInput,
  PersonSummary,
} from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { Field, Note, todayIso } from '../../design-system/index.js';
import { rupeesToPaise } from '../../money.js';

function Sent({ result }: { result: ChangeRequestResult | undefined }) {
  if (!result) return null;
  return 'requestId' in result ? (
    <Note kind="info">
      Sent for approval. <Link to={`/requests/${result.requestId}`}>Follow the request</Link>
    </Note>
  ) : (
    <Note kind="info">Recorded.</Note>
  );
}

/** New pay from a date, e.g. an unpaid intern becoming paid (decision #64). HR head approves. */
export function PayChange({ person, isHrHead }: { person: PersonSummary; isHrHead: boolean }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    effectiveFrom: todayIso(),
    reason: '',
    amount: '',
    rateUnit: (person.engagementType === 'permanent'
      ? 'year'
      : 'month') as PayChangeInput['rateUnit'],
  });
  const [amountError, setAmountError] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = useMutation({
    mutationFn: (amount: string) =>
      api<ChangeRequestResult>(`/people/${person.personId}/pay-changes`, {
        body: { ...form, amount } satisfies PayChangeInput,
      }),
    onSuccess: () => {
      setOpen(false);
      return Promise.all([
        client.invalidateQueries({ queryKey: ['compensation', person.personId] }),
        client.invalidateQueries({ queryKey: ['requests'] }),
      ]);
    },
  });

  if (!open) {
    return (
      <>
        <Sent result={submit.data} />
        <button className="button" onClick={() => setOpen(true)}>
          Change pay…
        </button>
      </>
    );
  }
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const paise = rupeesToPaise(form.amount);
        setAmountError(!paise);
        if (paise) submit.mutate(paise);
      }}
    >
      <h3>Change pay</h3>
      <p className="muted">
        {isHrHead ? 'As HR head, your change is recorded at once.' : 'HR head approves it first.'}{' '}
        The amount is encrypted; every view of it is logged.
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
        <Field label="Reason" hint="e.g. Stipend, Annual revision">
          {(id) => <input id={id} required value={form.reason} onChange={set('reason')} />}
        </Field>
        <Field label="Paid per">
          {(id) => (
            <select id={id} value={form.rateUnit} onChange={set('rateUnit')}>
              <option value="year">Year</option>
              <option value="month">Month</option>
              <option value="day">Day</option>
            </select>
          )}
        </Field>
        <Field label="Amount (₹)">
          {(id) => (
            <input
              id={id}
              inputMode="decimal"
              required
              value={form.amount}
              onChange={set('amount')}
              aria-invalid={amountError}
              placeholder="15,000"
            />
          )}
        </Field>
      </div>
      {amountError && <Note kind="error">Enter the amount in rupees, e.g. 15,000</Note>}
      <div className="form-actions">
        <button className="button button-primary" disabled={submit.isPending}>
          {isHrHead ? 'Record pay change' : 'Send for approval'}
        </button>
        <button type="button" className="button button-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {submit.error && <Note kind="error">{errorMessage(submit.error)}</Note>}
    </form>
  );
}

/**
 * Conversion request (decisions #42, #64): retainer or consultant to payroll, intern or trainee to
 * employee. HR head, then CXO, approve; a future date applies on the day.
 */
export function ConversionRequest({ person }: { person: PersonSummary }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    effectiveFrom: todayIso(),
    reason: '',
    type: 'permanent' as ConversionRequestInput['type'],
    probation: '' as '' | ConversionRequestInput['probation'],
    amount: '',
  });
  const [amountError, setAmountError] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = useMutation({
    mutationFn: (paise: string | null) =>
      api<ChangeRequestResult>(`/people/${person.personId}/conversion-requests`, {
        body: {
          effectiveFrom: form.effectiveFrom,
          reason: form.reason,
          type: form.type,
          probation: form.probation as ConversionRequestInput['probation'],
          ...(paise ? { compensation: { amount: paise, rateUnit: 'year' as const } } : {}),
        } satisfies ConversionRequestInput,
      }),
    onSuccess: () => {
      setOpen(false);
      return client.invalidateQueries({ queryKey: ['requests'] });
    },
  });

  if (!open) {
    return (
      <>
        <Sent result={submit.data} />
        <button className="button" onClick={() => setOpen(true)}>
          Convert…
        </button>
      </>
    );
  }
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const paise = form.amount.trim() ? rupeesToPaise(form.amount) : null;
        setAmountError(Boolean(form.amount.trim()) && !paise);
        if (form.amount.trim() && !paise) return;
        submit.mutate(paise);
      }}
    >
      <h3>Convert {person.preferredName ?? person.legalName}</h3>
      <p className="muted">
        Same person, same employee code, one journey. HR head then CXO approve; a future date
        applies by itself on the day.
      </p>
      <div className="form-grid">
        <Field label="Becomes">
          {(id) => (
            <select id={id} value={form.type} onChange={set('type')}>
              <option value="permanent">Permanent</option>
              <option value="fixed_term">Fixed-term</option>
            </select>
          )}
        </Field>
        <Field label="From">
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
        <Field label="Probation" hint="Decided per conversion by HR and CXO">
          {(id) => (
            <select id={id} required value={form.probation} onChange={set('probation')}>
              <option value="">Choose…</option>
              <option value="policy">Serves probation (policy length)</option>
              <option value="none">No probation</option>
            </select>
          )}
        </Field>
        <Field label="Annual CTC (₹, optional)" hint="Encrypted; every view is logged">
          {(id) => (
            <input
              id={id}
              inputMode="decimal"
              value={form.amount}
              onChange={set('amount')}
              aria-invalid={amountError}
              placeholder="9,00,000"
            />
          )}
        </Field>
        <Field label="Reason">
          {(id) => <input id={id} required value={form.reason} onChange={set('reason')} />}
        </Field>
      </div>
      {amountError && <Note kind="error">Enter the amount in rupees, e.g. 9,00,000</Note>}
      <div className="form-actions">
        <button className="button button-primary" disabled={submit.isPending}>
          Send for approval
        </button>
        <button type="button" className="button button-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {submit.error && <Note kind="error">{errorMessage(submit.error)}</Note>}
    </form>
  );
}
