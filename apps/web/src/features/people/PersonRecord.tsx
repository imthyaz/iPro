import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  kycTypeLabels,
  type DocumentView,
  type JourneyEntry,
  type KycType,
  type KycView,
} from '@ipro/shared';
import { Link } from 'react-router';
import { api, errorMessage } from '../../api.js';
import { hasRole, useMe } from '../../auth.js';
import {
  Chip,
  Empty,
  Field,
  formatDate,
  MaskedValue,
  Note,
  StatusChip,
  Tabs,
} from '../../design-system/index.js';
import { formatPaise, rateLabel } from '../../money.js';
import { Letters, ShiftHistory } from './PersonExtras.js';
import type { AssignmentRow, CompensationRow, PersonDetail } from './types.js';

type TabId = 'profile' | 'roles' | 'shifts' | 'pay' | 'kyc' | 'documents' | 'letters' | 'journey';

/** Person record (H2; E7 when it's the signed-in person). */
export function PersonRecord({ personId }: { personId: string }) {
  const me = useMe().data;
  const isSelf = me?.personId === personId;
  const isHr = hasRole(me, 'hr', 'hr_head');
  const [tab, setTab] = useState<TabId>('profile');
  const person = useQuery({
    queryKey: ['person', personId],
    queryFn: () => api<PersonDetail>(`/people/${personId}`),
  });

  if (person.error) return <Note kind="error">{errorMessage(person.error)}</Note>;
  if (!person.data) return <p className="muted">Loading…</p>;
  const p = person.data;

  // Tabs follow the permissions table; the API still decides every request.
  const tabs: { id: TabId; label: string }[] = [
    { id: 'profile', label: 'Profile' },
    { id: 'roles', label: 'Role history' },
    { id: 'shifts', label: 'Shifts' },
    ...(isSelf || hasRole(me, 'hr', 'hr_head', 'cxo')
      ? [{ id: 'pay' as const, label: 'Pay' }]
      : []),
    ...(isSelf || isHr ? [{ id: 'kyc' as const, label: 'KYC' }] : []),
    { id: 'documents', label: 'Documents' },
    ...(isHr ? [{ id: 'letters' as const, label: 'Letters' }] : []),
    { id: 'journey', label: 'Journey' },
  ];

  return (
    <article className="record">
      <header className="record-header">
        <h2>{p.preferredName ?? p.legalName}</h2>
        <p className="muted">
          {p.employeeCode} · {p.designation?.title ?? '—'} · {p.department?.name ?? '—'}
        </p>
        <p>
          <StatusChip status={p.status} />{' '}
          <Chip tone="muted">{p.engagementType.replace('_', '-')}</Chip>
        </p>
      </header>
      <Tabs tabs={tabs} active={tab} onChange={setTab} label="Person record sections" />
      <div role="tabpanel" aria-labelledby={`tab-${tab}`} className="tab-panel">
        {tab === 'profile' && <Profile person={p} canChange={isSelf || isHr} isHr={isHr} />}
        {tab === 'roles' && <RoleHistory personId={personId} />}
        {tab === 'shifts' && <ShiftHistory personId={personId} />}
        {tab === 'pay' && <Pay personId={personId} />}
        {tab === 'kyc' && <Kyc personId={personId} canUnmask={isHr} canSubmit={isSelf || isHr} />}
        {tab === 'documents' && <Documents personId={personId} isSelf={isSelf} isHr={isHr} />}
        {tab === 'letters' && <Letters personId={personId} />}
        {tab === 'journey' && <Journey personId={personId} />}
      </div>
    </article>
  );
}

function Profile({
  person,
  canChange,
  isHr,
}: {
  person: PersonDetail;
  canChange: boolean;
  isHr: boolean;
}) {
  const rows: [string, string][] = [
    ['Legal name', person.legalName],
    ['Work email', person.workEmail ?? '—'],
    ['Joined', formatDate(person.joiningDate)],
    ['Location', person.location?.name ?? '—'],
    ['Manager', person.manager?.name ?? '—'],
    ['Bucket', person.bucket ?? '—'],
    ['Date of birth', formatDate(person.profile.dateOfBirth)],
    ['Personal email', person.profile.personalEmail ?? '—'],
    ['Phone', person.profile.phone ?? '—'],
  ];
  return (
    <>
      <dl className="facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {canChange && <ChangeDetails person={person} isHr={isHr} />}
      <h3>Emergency contacts</h3>
      {person.emergencyContacts.length === 0 ? (
        <Empty>None recorded.</Empty>
      ) : (
        <ul className="plain">
          {person.emergencyContacts.map((c) => (
            <li key={c.id}>
              {c.name} ({c.relation}) · {c.phone}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function RoleHistory({ personId }: { personId: string }) {
  const rows = useQuery({
    queryKey: ['assignments', personId],
    queryFn: () => api<AssignmentRow[]>(`/people/${personId}/assignments`),
  });
  if (rows.error) return <Note kind="error">{errorMessage(rows.error)}</Note>;
  return (
    <ol className="timeline">
      {[...(rows.data ?? [])].reverse().map((row) => (
        <li key={row.id}>
          <strong>{row.designation.title}</strong> · {row.department.name} · {row.location.name}
          <div className="muted">
            {formatDate(row.effectiveFrom)} –{' '}
            {row.effectiveTo ? formatDate(row.effectiveTo) : 'now'} · {row.changeReason} ·{' '}
            {row.engagementType.replace('_', '-')}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Pay({ personId }: { personId: string }) {
  const rows = useQuery({
    queryKey: ['compensation', personId],
    queryFn: () => api<CompensationRow[]>(`/people/${personId}/compensation`),
    // Every read is audited, so don't refetch in the background.
    staleTime: Infinity,
  });
  if (rows.error) return <Note kind="error">{errorMessage(rows.error)}</Note>;
  if (rows.data?.length === 0) return <Empty>No pay recorded.</Empty>;
  return (
    <>
      <p className="muted">Each time pay is shown, it is recorded in the audit log.</p>
      <ol className="timeline">
        {[...(rows.data ?? [])].reverse().map((row) => (
          <li key={row.id}>
            <strong>
              {formatPaise(row.amount)} {rateLabel(row.rateUnit)}
            </strong>
            <div className="muted">
              {formatDate(row.effectiveFrom)} –{' '}
              {row.effectiveTo ? formatDate(row.effectiveTo) : 'now'}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

/** Personal details: HR changes them directly; a person's own change goes to HR for approval. */
function ChangeDetails({ person, isHr }: { person: PersonDetail; isHr: boolean }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [preferredName, setPreferredName] = useState(person.preferredName ?? '');
  const [personalEmail, setPersonalEmail] = useState(person.profile.personalEmail ?? '');
  const [phone, setPhone] = useState(person.profile.phone ?? '');
  const change = useMutation({
    mutationFn: () => {
      const body: Record<string, string | null> = {};
      const set = (key: string, value: string, was: string | null) => {
        if (value.trim() !== (was ?? '')) body[key] = value.trim() || null;
      };
      set('preferredName', preferredName, person.preferredName);
      set('personalEmail', personalEmail, person.profile.personalEmail);
      set('phone', phone, person.profile.phone);
      return api<{ applied: true } | { requestId: string }>(`/people/${person.personId}/profile`, {
        method: 'PATCH',
        body,
      });
    },
    onSuccess: () => {
      setOpen(false);
      return Promise.all([
        client.invalidateQueries({ queryKey: ['person', person.personId] }),
        client.invalidateQueries({ queryKey: ['requests'] }),
      ]);
    },
  });

  if (!open) {
    return (
      <>
        {change.data && 'requestId' in change.data && (
          <Note kind="info">
            Sent to HR for approval. Follow it in{' '}
            <Link to={`/requests/${change.data.requestId}`}>My requests</Link>.
          </Note>
        )}
        <button className="button" onClick={() => setOpen(true)}>
          {isHr ? 'Change details' : 'Request a change'}
        </button>
      </>
    );
  }
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        change.mutate();
      }}
    >
      <h3>{isHr ? 'Change details' : 'Request a change'}</h3>
      {!isHr && <p className="muted">HR approves changes to your details.</p>}
      <Field label="Preferred name">
        {(id) => (
          <input id={id} value={preferredName} onChange={(e) => setPreferredName(e.target.value)} />
        )}
      </Field>
      <Field label="Personal email">
        {(id) => (
          <input
            id={id}
            type="email"
            value={personalEmail}
            onChange={(e) => setPersonalEmail(e.target.value)}
          />
        )}
      </Field>
      <Field label="Phone">
        {(id) => (
          <input id={id} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        )}
      </Field>
      <div className="form-actions">
        <button className="button button-primary" disabled={change.isPending}>
          {isHr ? 'Save' : 'Send to HR'}
        </button>
        <button type="button" className="button button-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {change.error && <Note kind="error">{errorMessage(change.error)}</Note>}
    </form>
  );
}

function Kyc(props: { personId: string; canUnmask: boolean; canSubmit: boolean }) {
  const client = useQueryClient();
  const records = useQuery({
    queryKey: ['kyc', props.personId],
    queryFn: () => api<KycView[]>(`/people/${props.personId}/kyc`),
    staleTime: Infinity,
  });
  const [type, setType] = useState<KycType>('pan');
  const [value, setValue] = useState('');
  const [ifsc, setIfsc] = useState('');
  const submit = useMutation({
    mutationFn: () =>
      api<KycView[]>(`/people/${props.personId}/kyc`, {
        body: { type, value, ...(type === 'bank' ? { ifsc } : {}) },
      }),
    onSuccess: (data) => {
      client.setQueryData(['kyc', props.personId], data);
      setValue('');
      setIfsc('');
    },
  });
  const verify = useMutation({
    mutationFn: (kycId: string) =>
      api<KycView[]>(`/people/${props.personId}/kyc/${kycId}/verify`, { method: 'POST' }),
    onSuccess: (data) => client.setQueryData(['kyc', props.personId], data),
  });

  if (records.error) return <Note kind="error">{errorMessage(records.error)}</Note>;
  return (
    <>
      {records.data?.length === 0 && <Empty>No KYC details yet.</Empty>}
      <ul className="rows" aria-label="KYC details">
        {records.data?.map((record) => (
          <li key={record.id} className="row">
            <span className="row-main">
              <strong>{kycTypeLabels[record.type]}</strong>
              <MaskedValue
                masked={record.maskedValue}
                label={kycTypeLabels[record.type]}
                canUnmask={props.canUnmask}
                onUnmask={async () =>
                  (
                    await api<{ value: string }>(
                      `/people/${props.personId}/kyc/${record.id}/unmask`,
                      { method: 'POST' },
                    )
                  ).value
                }
              />
              {record.extra.ifsc && <span className="muted">IFSC {record.extra.ifsc}</span>}
            </span>
            <span className="row-side">
              {record.verified ? (
                <Chip tone="ok">Verified</Chip>
              ) : props.canUnmask ? (
                <button className="button" onClick={() => verify.mutate(record.id)}>
                  Mark verified
                </button>
              ) : (
                <Chip tone="info">Awaiting HR</Chip>
              )}
            </span>
          </li>
        ))}
      </ul>
      {props.canSubmit && (
        <form
          className="inline-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            submit.mutate();
          }}
        >
          <h3>Add or update a KYC detail</h3>
          <Field label="Type">
            {(id) => (
              <select id={id} value={type} onChange={(e) => setType(e.target.value as KycType)}>
                {Object.entries(kycTypeLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={type === 'bank' ? 'Account number' : 'Number'}>
            {(id) => (
              <input
                id={id}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
                required
              />
            )}
          </Field>
          {type === 'bank' && (
            <Field label="IFSC">
              {(id) => (
                <input id={id} value={ifsc} onChange={(e) => setIfsc(e.target.value)} required />
              )}
            </Field>
          )}
          <button className="button button-primary" disabled={submit.isPending}>
            Save
          </button>
          {submit.error && <Note kind="error">{errorMessage(submit.error)}</Note>}
        </form>
      )}
    </>
  );
}

function Documents(props: { personId: string; isSelf: boolean; isHr: boolean }) {
  const client = useQueryClient();
  const documents = useQuery({
    queryKey: ['documents', props.personId],
    queryFn: () => api<DocumentView[]>(`/people/${props.personId}/documents`),
  });
  const [type, setType] = useState<DocumentView['type']>(props.isHr ? 'letter' : 'kyc_scan');
  const [title, setTitle] = useState('');
  const [confidential, setConfidential] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.set('type', type);
      form.set('title', title);
      form.set('confidential', String(confidential));
      form.set('file', file!);
      return api<DocumentView>(`/people/${props.personId}/documents`, { form });
    },
    onSuccess: () => {
      setTitle('');
      setFile(null);
      return client.invalidateQueries({ queryKey: ['documents', props.personId] });
    },
  });
  const open = useMutation({
    mutationFn: (documentId: string) =>
      api<{ url: string }>(`/people/${props.personId}/documents/${documentId}/link`, {
        method: 'POST',
      }),
    onSuccess: ({ url }) => window.open(url, '_blank', 'noopener'),
  });
  const types: DocumentView['type'][] = props.isHr
    ? ['letter', 'certificate', 'kyc_scan', 'photo', 'other']
    : ['kyc_scan'];

  return (
    <>
      {documents.error && <Note kind="error">{errorMessage(documents.error)}</Note>}
      {documents.data?.length === 0 && <Empty>No documents.</Empty>}
      <ul className="rows" aria-label="Documents">
        {documents.data?.map((doc) => (
          <li key={doc.id} className="row">
            <span className="row-main">
              <strong>{doc.title}</strong>
              <span className="muted">
                {doc.fileName} · {formatDate(doc.uploadedAt)} · {Math.ceil(doc.sizeBytes / 1024)} KB
              </span>
            </span>
            <span className="row-side">
              {doc.type === 'kyc_scan' && <Chip tone="warn">KYC</Chip>}
              <button className="button" onClick={() => open.mutate(doc.id)}>
                Open
              </button>
            </span>
          </li>
        ))}
      </ul>
      {open.error && <Note kind="error">{errorMessage(open.error)}</Note>}
      {(props.isSelf || props.isHr) && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            upload.mutate();
          }}
        >
          <h3>Upload</h3>
          <Field label="Kind">
            {(id) => (
              <select
                id={id}
                value={type}
                onChange={(e) => setType(e.target.value as DocumentView['type'])}
              >
                {types.map((t) => (
                  <option key={t} value={t}>
                    {t === 'kyc_scan' ? 'KYC scan' : t[0]!.toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Title">
            {(id) => (
              <input id={id} value={title} onChange={(e) => setTitle(e.target.value)} required />
            )}
          </Field>
          <Field label="File" hint="PDF, JPEG or PNG, up to 10 MB">
            {(id) => (
              <input
                id={id}
                type="file"
                accept="application/pdf,image/jpeg,image/png"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                required
              />
            )}
          </Field>
          {props.isHr && type !== 'kyc_scan' && (
            <label className="check">
              <input
                type="checkbox"
                checked={confidential}
                onChange={(e) => setConfidential(e.target.checked)}
              />
              Confidential (hidden from managers)
            </label>
          )}
          <button className="button button-primary" disabled={upload.isPending || !file}>
            Upload
          </button>
          {upload.error && <Note kind="error">{errorMessage(upload.error)}</Note>}
        </form>
      )}
    </>
  );
}

function Journey({ personId }: { personId: string }) {
  const events = useQuery({
    queryKey: ['journey', personId],
    queryFn: () => api<JourneyEntry[]>(`/people/${personId}/journey`),
  });
  if (events.error) return <Note kind="error">{errorMessage(events.error)}</Note>;
  if (events.data?.length === 0) return <Empty>No events yet.</Empty>;
  return (
    <>
      <p className="muted">The full journey timeline arrives with slice 10.</p>
      <ol className="timeline">
        {[...(events.data ?? [])].reverse().map((event) => (
          <li key={event.id}>
            <strong>{event.title}</strong> {event.isPlanned && <Chip tone="info">Upcoming</Chip>}
            <div className="muted">{formatDate(event.occurredOn)}</div>
          </li>
        ))}
      </ol>
    </>
  );
}
