import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type {
  CreateOfferInput,
  LetterTemplateView,
  OfferView,
  PersonFormOptions,
} from '@ipro/shared';
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

type EngagementType = CreateOfferInput['engagement']['type'];
type RateUnit = 'year' | 'month' | 'day';

const defaultRate = (type: EngagementType): RateUnit =>
  type === 'permanent' || type === 'fixed_term' || type === 'trainee' ? 'year' : 'month';

const rateWords: Record<RateUnit, string> = {
  year: 'Annual CTC (₹)',
  month: 'Monthly amount (₹)',
  day: 'Day rate (₹)',
};

/**
 * Create offer (H3): the candidate, role, pay and offer letter on one screen. Saved as a draft, or sent
 * straight to the hiring manager for approval (decision #54).
 */
export function NewOffer() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const options = useQuery({
    queryKey: ['person-form-options'],
    queryFn: () => api<PersonFormOptions>('/people/form-options'),
  });
  const templates = useQuery({
    queryKey: ['letter-templates'],
    queryFn: () => api<LetterTemplateView[]>('/letter-templates'),
  });
  // Only letters the candidate signs can carry an offer: signing is how they accept.
  const offerTemplates = (templates.data ?? [])
    .filter((t) => t.signature === 'employee')
    .sort((a, b) => Number(b.type === 'offer') - Number(a.type === 'offer'));
  const [form, setForm] = useState({
    legalName: '',
    personalEmail: '',
    type: 'permanent' as EngagementType,
    joiningDate: todayIso(),
    endDate: '',
    legalEntityId: '',
    designationId: '',
    departmentId: '',
    locationId: '',
    managerEngagementId: '',
    bucket: 'billable',
    unpaid: false,
    amount: '',
    rateUnit: 'year' as RateUnit,
    templateKey: '',
  });
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [amountError, setAmountError] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const o = options.data;
  const templateKey = form.templateKey || offerTemplates[0]?.key || '';
  const template = offerTemplates.find((t) => t.key === templateKey);
  const extraFields = (template?.fields ?? [])
    .filter((f) => f.startsWith('extra.'))
    .map((f) => f.slice(6));
  const needsEnd = form.type === 'intern' || form.type === 'fixed_term';
  const unpaid = form.type === 'intern' && form.unpaid;

  const save = useMutation({
    mutationFn: async ({ input, send }: { input: CreateOfferInput; send: boolean }) => {
      const offer = await api<OfferView>('/offers', { body: input });
      return send ? api<OfferView>(`/offers/${offer.id}/submit`, { method: 'POST' }) : offer;
    },
    onSuccess: async (offer) => {
      await client.invalidateQueries({ queryKey: ['offers'] });
      navigate(`/offers/${offer.id}`);
    },
  });

  function submit(e: FormEvent, send: boolean) {
    e.preventDefault();
    const paise = unpaid ? null : rupeesToPaise(form.amount);
    setAmountError(!unpaid && !paise);
    if (!unpaid && !paise) return;
    save.mutate({
      send,
      input: {
        person: { legalName: form.legalName, personalEmail: form.personalEmail },
        engagement: {
          legalEntityId: form.legalEntityId || (o?.legalEntities[0]?.id ?? ''),
          type: form.type,
          joiningDate: form.joiningDate,
          ...(needsEnd && form.endDate ? { endDate: form.endDate } : {}),
        },
        assignment: {
          designationId: form.designationId,
          departmentId: form.departmentId,
          locationId: form.locationId,
          managerEngagementId: form.managerEngagementId || null,
          bucket: form.bucket,
        },
        ...(paise ? { compensation: { amount: paise, rateUnit: form.rateUnit } } : {}),
        letterTemplateKey: templateKey,
        ...(extraFields.length
          ? { extra: Object.fromEntries(extraFields.map((f) => [f, extra[f] ?? ''])) }
          : {}),
      },
    });
  }

  if (options.error) return <Note kind="error">{errorMessage(options.error)}</Note>;

  return (
    <main className="page">
      <h1>New offer</h1>
      <p className="muted">
        The hiring manager approves it, and HR head too when the pay is above the grade band. It
        then goes to the candidate’s personal email to sign.
      </p>
      <form className="form-grid" onSubmit={(e) => submit(e, true)}>
        <Field label="Candidate’s legal name">
          {(id) => (
            <input id={id} value={form.legalName} onChange={set('legalName')} required autoFocus />
          )}
        </Field>
        <Field label="Personal email" hint="Receives the offer to sign and the pre-joining sign-in">
          {(id) => (
            <input
              id={id}
              type="email"
              value={form.personalEmail}
              onChange={set('personalEmail')}
              required
            />
          )}
        </Field>
        <Field label="Engagement type">
          {(id) => (
            <select
              id={id}
              value={form.type}
              onChange={(e) => {
                const type = e.target.value as EngagementType;
                setForm((f) => ({ ...f, type, rateUnit: defaultRate(type), unpaid: false }));
              }}
            >
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
              min={todayIso()}
              onChange={set('joiningDate')}
              required
            />
          )}
        </Field>
        {needsEnd && (
          <Field
            label="End date"
            hint={
              form.type === 'intern' ? 'Last day of the internship' : 'Last day of the contract'
            }
          >
            {(id) => (
              <input
                id={id}
                type="date"
                value={form.endDate}
                min={form.joiningDate}
                onChange={set('endDate')}
                required={form.type === 'intern'}
              />
            )}
          </Field>
        )}
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
        <Field label="Hiring manager" hint="Approves the offer and becomes their manager">
          {(id) => (
            <select id={id} value={form.managerEngagementId} onChange={set('managerEngagementId')}>
              <option value="">No manager (HR approves)</option>
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
        {form.type === 'intern' && (
          <label className="check">
            <input
              type="checkbox"
              checked={form.unpaid}
              onChange={(e) => setForm((f) => ({ ...f, unpaid: e.target.checked }))}
            />
            Unpaid internship
          </label>
        )}
        {!unpaid && (
          <>
            <Field label="Paid per">
              {(id) => (
                <select id={id} value={form.rateUnit} onChange={set('rateUnit')}>
                  <option value="year">Year</option>
                  <option value="month">Month</option>
                  <option value="day">Day</option>
                </select>
              )}
            </Field>
            <Field
              label={rateWords[form.rateUnit]}
              hint="Encrypted; checked against the grade band. Day rates go to HR head."
            >
              {(id) => (
                <input
                  id={id}
                  inputMode="decimal"
                  value={form.amount}
                  onChange={set('amount')}
                  aria-invalid={amountError}
                  placeholder="12,00,000"
                  required
                />
              )}
            </Field>
          </>
        )}
        {amountError && <Note kind="error">Enter the amount in rupees, e.g. 12,00,000</Note>}
        <Field label="Offer letter">
          {(id) => (
            <select
              id={id}
              value={templateKey}
              onChange={(e) => {
                setForm((f) => ({ ...f, templateKey: e.target.value }));
                setExtra({});
              }}
              required
            >
              {offerTemplates.length === 0 && <option value="">No signed letter templates</option>}
              {offerTemplates.map((t) => (
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
        <div className="form-actions">
          <button className="button button-primary" disabled={save.isPending || !o || !template}>
            Send for approval
          </button>
          <button
            type="button"
            className="button"
            disabled={save.isPending || !o || !template}
            onClick={(e) => {
              const form = (e.currentTarget as HTMLButtonElement).form!;
              if (form.reportValidity()) submit(e as unknown as FormEvent, false);
            }}
          >
            Save draft
          </button>
          <button type="button" className="button button-quiet" onClick={() => navigate('/offers')}>
            Cancel
          </button>
        </div>
        {save.error && <Note kind="error">{errorMessage(save.error)}</Note>}
      </form>
    </main>
  );
}
