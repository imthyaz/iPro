import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { SeatView, WorkMode, WorkPolicyInput, WorkPolicyView } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { hasRole, useMe } from '../../auth.js';
import { Chip, Empty, Field, ListDetail, Note } from '../../design-system/index.js';
import { AppliesToEditor, describeAppliesTo, useOrgLookups } from '../admin/AppliesTo.js';

const modeWords: Record<WorkMode, string> = {
  office: 'Office',
  wfh: 'WFH',
  client_site: 'Client site',
};
const placeWords = { office: 'Offices', client_site: 'Client sites', remote: 'Remote' } as const;

const blank: WorkPolicyInput = {
  code: '',
  name: '',
  requiredMode: 'office',
  requiredDays: 3,
  anchorDayRequired: false,
  allowedModes: ['office', 'wfh', 'client_site'],
  appliesTo: {},
  locationTypes: [],
  priority: 50,
  active: true,
};

/** One line on what a policy asks, e.g. "3 office days a week · anchor day · Office, WFH". */
function summary(p: WorkPolicyView): string {
  const parts = [
    p.requiredDays === 0
      ? 'No set days'
      : `${p.requiredDays} ${p.requiredMode === 'office' ? 'office' : 'client-site'} days a week`,
  ];
  if (p.anchorDayRequired) parts.push('team anchor day');
  parts.push(p.allowedModes.map((m) => modeWords[m]).join(', '));
  return parts.join(' · ');
}

/**
 * A2 Work policies (decision #78): who works where how often. The first active policy by priority
 * that matches a person applies. Admins add; admins and HR head edit.
 */
export function WorkPolicies() {
  const { policyId } = useParams();
  const navigate = useNavigate();
  const me = useMe().data;
  const lookups = useOrgLookups();
  const policies = useQuery({
    queryKey: ['work-policies'],
    queryFn: () => api<WorkPolicyView[]>('/work-policies'),
  });
  const creating = policyId === 'new';
  const chosen = policies.data?.find((p) => p.id === policyId) ?? null;
  const list = (
    <>
      <div className="toolbar">
        <h1>Work policies</h1>
        {hasRole(me, 'admin') && (
          <Link className="button button-primary" to="/work-policies/new">
            Add policy
          </Link>
        )}
      </div>
      <p className="muted">
        The first active policy, in this order, that matches a person applies.
      </p>
      {policies.error && <Note kind="error">{errorMessage(policies.error)}</Note>}
      <ul className="rows" aria-label="Work policies">
        {policies.data?.map((p) => (
          <li key={p.id}>
            <Link
              to={`/work-policies/${p.id}`}
              className={p.id === policyId ? 'row row-selected' : 'row'}
            >
              <span className="row-main">
                <strong>
                  {p.name} <span className="muted">{p.code}</span>
                </strong>
                <span className="muted">
                  {summary(p)} · {describeAppliesTo(p.appliesTo, lookups)}
                  {p.locationTypes.length
                    ? ` · ${p.locationTypes.map((t) => placeWords[t]).join(', ')}`
                    : ''}
                </span>
              </span>
              {!p.active && <Chip tone="muted">Inactive</Chip>}
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
        creating ? (
          <EditPolicy
            key="new"
            initial={blank}
            canEdit
            onDone={(id) => navigate(`/work-policies/${id}`)}
          />
        ) : chosen ? (
          <EditPolicy
            key={chosen.id}
            id={chosen.id}
            initial={chosen}
            canEdit={hasRole(me, 'admin', 'hr_head')}
          />
        ) : null
      }
      onClose={() => navigate('/work-policies')}
      detailLabel="Work policy"
    />
  );
}

function EditPolicy(props: {
  id?: string;
  initial: WorkPolicyInput;
  canEdit: boolean;
  onDone?: (id: string) => void;
}) {
  const client = useQueryClient();
  const { id: _id, ...start } = props.initial as WorkPolicyView;
  const [form, setForm] = useState<WorkPolicyInput>(start);
  const save = useMutation({
    mutationFn: () =>
      props.id
        ? api<WorkPolicyView>(`/work-policies/${props.id}`, { method: 'PUT', body: form })
        : api<WorkPolicyView>('/work-policies', { body: form }),
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: ['work-policies'] });
      props.onDone?.(saved.id);
    },
  });
  const toggle = <T extends string>(list: T[], value: T, on: boolean) =>
    on ? [...list, value] : list.filter((x) => x !== value);
  return (
    <article className="record">
      <header className="record-header">
        <h2>{props.id ? form.name : 'New work policy'}</h2>
      </header>
      <form
        className="inline-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <fieldset className="form-grid" disabled={!props.canEdit}>
          {!props.id && (
            <Field label="Code" hint="Capitals, e.g. SALES">
              {(id) => (
                <input
                  id={id}
                  required
                  pattern="[A-Z0-9_]+"
                  maxLength={12}
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                />
              )}
            </Field>
          )}
          <Field label="Name">
            {(id) => (
              <input
                id={id}
                required
                maxLength={80}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Days a week at">
            {(id) => (
              <select
                id={id}
                value={form.requiredMode}
                onChange={(e) =>
                  setForm({
                    ...form,
                    requiredMode: e.target.value as WorkPolicyInput['requiredMode'],
                  })
                }
              >
                <option value="office">The office</option>
                <option value="client_site">A client site</option>
              </select>
            )}
          </Field>
          <Field label="How many days" hint="0 for no set days">
            {(id) => (
              <input
                id={id}
                type="number"
                min={0}
                max={7}
                value={form.requiredDays}
                onChange={(e) => setForm({ ...form, requiredDays: Number(e.target.value) })}
              />
            )}
          </Field>
          <Field label="Priority" hint="Lower is checked first">
            {(id) => (
              <input
                id={id}
                type="number"
                min={0}
                max={1000}
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
              />
            )}
          </Field>
        </fieldset>
        <fieldset className="check-group" disabled={!props.canEdit}>
          <legend>Allowed</legend>
          {(['office', 'wfh', 'client_site'] as const).map((m) => (
            <label key={m} className="check">
              <input
                type="checkbox"
                checked={form.allowedModes.includes(m)}
                onChange={(e) =>
                  setForm({ ...form, allowedModes: toggle(form.allowedModes, m, e.target.checked) })
                }
              />
              {modeWords[m]}
            </label>
          ))}
        </fieldset>
        <fieldset className="check-group" disabled={!props.canEdit}>
          <legend>For people based at (leave empty for anywhere)</legend>
          {(['office', 'client_site', 'remote'] as const).map((t) => (
            <label key={t} className="check">
              <input
                type="checkbox"
                checked={form.locationTypes.includes(t)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    locationTypes: toggle(form.locationTypes, t, e.target.checked),
                  })
                }
              />
              {placeWords[t]}
            </label>
          ))}
        </fieldset>
        <AppliesToEditor
          value={form.appliesTo}
          disabled={!props.canEdit}
          onChange={(appliesTo) => setForm({ ...form, appliesTo })}
        />
        <label className="check">
          <input
            type="checkbox"
            disabled={!props.canEdit}
            checked={form.anchorDayRequired}
            onChange={(e) => setForm({ ...form, anchorDayRequired: e.target.checked })}
          />
          The team’s anchor day must be an office day
        </label>
        <label className="check">
          <input
            type="checkbox"
            disabled={!props.canEdit}
            checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          />
          Active
        </label>
        {props.canEdit && (
          <button className="button button-primary" disabled={save.isPending}>
            Save
          </button>
        )}
        {save.isSuccess && props.id && (
          <Note kind="info">Saved. It applies to weeks planned from now.</Note>
        )}
        {save.error && <Note kind="error">{errorMessage(save.error)}</Note>}
      </form>
    </article>
  );
}

/** Seats at each office (spec data model: Seat): picked optionally when booking an office day. */
export function Seats() {
  const client = useQueryClient();
  const me = useMe().data;
  const lookups = useOrgLookups();
  const [locationId, setLocationId] = useState('');
  const [form, setForm] = useState({ label: '', zone: '' });
  const seats = useQuery({
    queryKey: ['seats', locationId],
    queryFn: () => api<SeatView[]>(`/seats?locationId=${locationId}`),
    enabled: Boolean(locationId),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['seats', locationId] });
  const add = useMutation({
    mutationFn: () =>
      api<SeatView>('/seats', {
        body: { locationId, label: form.label, ...(form.zone ? { zone: form.zone } : {}) },
      }),
    onSuccess: async () => {
      setForm({ label: '', zone: form.zone });
      await refresh();
    },
  });
  const setActive = useMutation({
    mutationFn: (seat: SeatView) =>
      api<SeatView>(`/seats/${seat.id}`, { method: 'PATCH', body: { active: !seat.active } }),
    onSuccess: refresh,
  });
  const canAdd = hasRole(me, 'admin');
  const canEdit = hasRole(me, 'admin', 'hr_head');
  return (
    <main className="page">
      <div className="toolbar">
        <h1>Seats</h1>
      </div>
      <p className="muted">
        A named seat is optional when booking an office day; the office’s seat count sets how many
        can come in.
      </p>
      <div className="filters">
        <Field label="Office">
          {(id) => (
            <select id={id} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Choose an office</option>
              {lookups.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {seats.error && <Note kind="error">{errorMessage(seats.error)}</Note>}
      {locationId && seats.data?.length === 0 && <Empty>No named seats here yet.</Empty>}
      <ul className="rows" aria-label="Seats">
        {seats.data?.map((s) => (
          <li key={s.id} className="row">
            <span className="row-main">
              <strong>{s.label}</strong>
              <span className="muted">{s.zone ?? 'No zone'}</span>
            </span>
            <span className="row-side">
              {!s.active && <Chip tone="muted">Inactive</Chip>}
              {canEdit && (
                <button
                  className="button button-quiet"
                  disabled={setActive.isPending}
                  onClick={() => setActive.mutate(s)}
                >
                  {s.active ? 'Make inactive' : 'Make active'}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {locationId && canAdd && (
        <form
          className="inline-form"
          aria-label="Add a seat"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <div className="form-grid">
            <Field label="Seat">
              {(id) => (
                <input
                  id={id}
                  required
                  maxLength={20}
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                />
              )}
            </Field>
            <Field label="Zone" hint="Optional, e.g. North wing">
              {(id) => (
                <input
                  id={id}
                  maxLength={40}
                  value={form.zone}
                  onChange={(e) => setForm({ ...form, zone: e.target.value })}
                />
              )}
            </Field>
          </div>
          <button className="button button-primary" disabled={add.isPending}>
            Add seat
          </button>
          {add.error && <Note kind="error">{errorMessage(add.error)}</Note>}
        </form>
      )}
      {setActive.error && <Note kind="error">{errorMessage(setActive.error)}</Note>}
    </main>
  );
}
