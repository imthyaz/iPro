import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../../api.js';
import { hasRole, useMe } from '../../auth.js';
import { Empty, Field, formatDate, Note, Tabs, todayIso } from '../../design-system/index.js';
import { formatPaise } from '../../money.js';

type Kind =
  | 'departments'
  | 'business-units'
  | 'locations'
  | 'designations'
  | 'grades'
  | 'cost-centres'
  | 'legal-entities';

const dated = new Set<Kind>(['departments', 'business-units', 'locations']);
const labels: Record<Kind, string> = {
  departments: 'Departments',
  'business-units': 'Business units',
  locations: 'Locations',
  designations: 'Designations',
  grades: 'Grades',
  'cost-centres': 'Cost centres',
  'legal-entities': 'Legal entities',
};

type Row = Record<string, unknown> & { id: string };

/** Organisation setup (A1). HR and HR head read; admins change. Dated units show as of a date. */
export function OrgSetup() {
  const me = useMe().data;
  const canEdit = hasRole(me, 'admin');
  const [kind, setKind] = useState<Kind>('departments');
  const [asOf, setAsOf] = useState(todayIso());
  const rows = useQuery({
    queryKey: ['org', kind, dated.has(kind) ? asOf : null],
    queryFn: () =>
      api<Row[]>(dated.has(kind) ? `/org/units/${kind}?asOf=${asOf}` : `/org/catalog/${kind}`),
  });

  return (
    <main className="page">
      <div className="toolbar">
        <h1>Organisation setup</h1>
        {dated.has(kind) && (
          <Field label="As of">
            {(id) => (
              <input id={id} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            )}
          </Field>
        )}
      </div>
      <Tabs
        label="Organisation records"
        active={kind}
        onChange={setKind}
        tabs={(Object.keys(labels) as Kind[]).map((id) => ({ id, label: labels[id] }))}
      />
      <section className="tab-panel" role="tabpanel" aria-labelledby={`tab-${kind}`}>
        {rows.error && <Note kind="error">{errorMessage(rows.error)}</Note>}
        {rows.data?.length === 0 && <Empty>None yet.</Empty>}
        <ul className="rows" aria-label={labels[kind]}>
          {rows.data?.map((row) => (
            <li key={row.id} className="row">
              <span className="row-main">
                <strong>{String(row.name ?? row.title ?? row.code)}</strong>
                <span className="muted">{describe(kind, row)}</span>
              </span>
              {canEdit && kind === 'departments' && <ChangeFromDate row={row} />}
            </li>
          ))}
        </ul>
        {canEdit && kind === 'departments' && <AddDepartment />}
      </section>
    </main>
  );
}

function describe(kind: Kind, row: Row): string {
  if (dated.has(kind)) {
    const until = row.effectiveTo ? `until ${formatDate(row.effectiveTo as string)}` : 'open';
    return `${row.code} · from ${formatDate(row.effectiveFrom as string)}, ${until}`;
  }
  if (kind === 'grades') {
    const band =
      row.bandMin && row.bandMax
        ? `${formatPaise(row.bandMin as string)} – ${formatPaise(row.bandMax as string)} a year`
        : 'no band';
    return `${row.code} · ${band}`;
  }
  if (kind === 'designations') return String(row.designationBand).replace('_', ' ');
  return String(row.code ?? row.country ?? '');
}

/** Rename (or other change) effective from a date: closes the current version, history kept. */
function ChangeFromDate({ row }: { row: Row }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(String(row.name));
  const [from, setFrom] = useState(todayIso());
  const change = useMutation({
    mutationFn: () =>
      api(`/org/units/departments/${row.id}/changes`, { body: { effectiveFrom: from, name } }),
    onSuccess: () => {
      setOpen(false);
      return client.invalidateQueries({ queryKey: ['org'] });
    },
  });
  if (!open) {
    return (
      <button className="button" onClick={() => setOpen(true)}>
        Change from a date
      </button>
    );
  }
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        change.mutate();
      }}
    >
      <Field label="New name">
        {(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Effective from">
        {(id) => (
          <input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        )}
      </Field>
      <button className="button button-primary" disabled={change.isPending}>
        Save
      </button>
      {change.error && <Note kind="error">{errorMessage(change.error)}</Note>}
    </form>
  );
}

function AddDepartment() {
  const client = useQueryClient();
  const units = useQuery({
    queryKey: ['org', 'business-units', 'today'],
    queryFn: () => api<Row[]>('/org/units/business-units'),
  });
  const [form, setForm] = useState({
    code: '',
    name: '',
    businessUnitId: '',
    effectiveFrom: todayIso(),
  });
  const add = useMutation({
    mutationFn: () => api('/org/units/departments', { body: form }),
    onSuccess: () => {
      setForm((f) => ({ ...f, code: '', name: '' }));
      return client.invalidateQueries({ queryKey: ['org'] });
    },
  });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <h3>Add a department</h3>
      <Field label="Code">
        {(id) => <input id={id} value={form.code} onChange={set('code')} required />}
      </Field>
      <Field label="Name">
        {(id) => <input id={id} value={form.name} onChange={set('name')} required />}
      </Field>
      <Field label="Business unit">
        {(id) => (
          <select id={id} value={form.businessUnitId} onChange={set('businessUnitId')} required>
            <option value="">Choose…</option>
            {units.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {String(u.name)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Effective from">
        {(id) => (
          <input id={id} type="date" value={form.effectiveFrom} onChange={set('effectiveFrom')} />
        )}
      </Field>
      <button className="button button-primary" disabled={add.isPending}>
        Add
      </button>
      {add.error && <Note kind="error">{errorMessage(add.error)}</Note>}
    </form>
  );
}
