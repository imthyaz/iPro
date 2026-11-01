import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  describeWorkingWeek,
  weekdayNames,
  type PersonSummary,
  type ShiftInput,
  type ShiftView,
} from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { hasRole, useMe } from '../../auth.js';
import { Chip, Empty, Field, ListDetail, Note, Tabs, todayIso } from '../../design-system/index.js';

const useShifts = () =>
  useQuery({ queryKey: ['shifts'], queryFn: () => api<ShiftView[]>('/shifts') });

const describeShift = (s: Pick<ShiftView, 'startTime' | 'endTime' | 'weeklyOffs'>) =>
  `${describeWorkingWeek(s.weeklyOffs)} · ${s.startTime}–${s.endTime}`;

/**
 * Shifts (A2) and who works them. Admins define shifts; HR puts people (or a whole project team) on a
 * shift from a date; managers ask HR to (decisions #46, #47).
 */
export function Shifts() {
  const me = useMe().data;
  const { shiftId } = useParams();
  const navigate = useNavigate();
  const canConfigure = hasRole(me, 'admin', 'hr_head');
  const canAllocate = hasRole(me, 'hr', 'hr_head');
  const canRequest = !canAllocate && hasRole(me, 'manager');
  const [tab, setTab] = useState<'shifts' | 'allocate'>(
    hasRole(me, 'admin', 'hr', 'hr_head', 'cxo') ? 'shifts' : 'allocate',
  );
  const shifts = useShifts();

  const tabs = [
    { id: 'shifts' as const, label: 'Shifts' },
    ...(canAllocate || canRequest
      ? [{ id: 'allocate' as const, label: canAllocate ? 'Allocate' : 'Request a change' }]
      : []),
  ];

  const list = (
    <>
      <div className="toolbar">
        <h1>Shifts</h1>
        {hasRole(me, 'admin') && tab === 'shifts' && (
          <Link className="button button-primary" to="/shifts/new">
            New shift
          </Link>
        )}
      </div>
      {tabs.length > 1 && (
        <Tabs label="Shift sections" tabs={tabs} active={tab} onChange={setTab} />
      )}
      <section className="tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {shifts.error && <Note kind="error">{errorMessage(shifts.error)}</Note>}
        {tab === 'shifts' && (
          <ul className="rows" aria-label="Shifts">
            {shifts.data?.map((s) => (
              <li key={s.id}>
                <Link
                  to={`/shifts/${s.id}`}
                  className={s.id === shiftId ? 'row row-selected' : 'row'}
                >
                  <span className="row-main">
                    <strong>{s.name}</strong>
                    <span className="muted">
                      {s.code} · {describeShift(s)}
                    </span>
                  </span>
                  {s.isDefault && <Chip tone="info">Default</Chip>}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {tab === 'allocate' && shifts.data && (
          <Allocate shifts={shifts.data} asRequest={canRequest} />
        )}
      </section>
    </>
  );

  const detail =
    tab === 'shifts' && shiftId ? (
      <ShiftEditor
        key={shiftId}
        shift={shiftId === 'new' ? null : (shifts.data?.find((s) => s.id === shiftId) ?? null)}
        isNew={shiftId === 'new'}
        canEdit={canConfigure}
      />
    ) : null;

  return (
    <ListDetail
      list={list}
      detail={detail}
      onClose={() => navigate('/shifts')}
      detailLabel="Shift"
    />
  );
}

const blankShift: ShiftInput = {
  code: '',
  name: '',
  startTime: '09:30',
  endTime: '18:30',
  breakMinutes: 60,
  graceMinutes: 15,
  halfDayMinutes: 240,
  weeklyOffs: [6, 7],
  isDefault: false,
};

function ShiftEditor(props: { shift: ShiftView | null; isNew: boolean; canEdit: boolean }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState<ShiftInput>(() =>
    props.shift ? { ...props.shift } : { ...blankShift },
  );
  const set = (patch: Partial<ShiftInput>) => setForm({ ...form, ...patch });
  const save = useMutation({
    mutationFn: () =>
      props.isNew
        ? api<ShiftView>('/shifts', { body: form })
        : api<ShiftView>(`/shifts/${props.shift!.id}`, { method: 'PATCH', body: form }),
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: ['shifts'] });
      if (props.isNew) navigate(`/shifts/${saved.id}`);
    },
  });
  if (!props.isNew && !props.shift) return <p className="muted">Loading…</p>;
  const minutes = (key: 'breakMinutes' | 'graceMinutes' | 'halfDayMinutes', label: string) => (
    <Field label={label}>
      {(id) => (
        <input
          id={id}
          type="number"
          min={0}
          value={form[key] ?? 0}
          onChange={(e) => set({ [key]: Number(e.target.value) })}
        />
      )}
    </Field>
  );

  return (
    <form
      className="record"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <header className="record-header">
        <h2>{props.isNew ? 'New shift' : props.shift!.name}</h2>
        <p className="muted">{describeShift(form)}</p>
      </header>
      <fieldset disabled={!props.canEdit} className="plain-fieldset">
        <div className="form-grid">
          <Field label="Code">
            {(id) => (
              <input
                id={id}
                required
                value={form.code}
                onChange={(e) => set({ code: e.target.value })}
              />
            )}
          </Field>
          <Field label="Name">
            {(id) => (
              <input
                id={id}
                required
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Starts">
            {(id) => (
              <input
                id={id}
                type="time"
                required
                value={form.startTime}
                onChange={(e) => set({ startTime: e.target.value })}
              />
            )}
          </Field>
          <Field label="Ends">
            {(id) => (
              <input
                id={id}
                type="time"
                required
                value={form.endTime}
                onChange={(e) => set({ endTime: e.target.value })}
              />
            )}
          </Field>
          {minutes('breakMinutes', 'Break (minutes)')}
          {minutes('graceMinutes', 'Late grace (minutes)')}
          {minutes('halfDayMinutes', 'Half day below (minutes)')}
        </div>
        <fieldset className="check-group">
          <legend>Days off</legend>
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <label key={d} className="check">
              <input
                type="checkbox"
                checked={form.weeklyOffs.includes(d)}
                onChange={(e) =>
                  set({
                    weeklyOffs: e.target.checked
                      ? [...form.weeklyOffs, d].sort()
                      : form.weeklyOffs.filter((x) => x !== d),
                  })
                }
              />
              {weekdayNames[d]}
            </label>
          ))}
        </fieldset>
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(form.isDefault)}
            onChange={(e) => set({ isDefault: e.target.checked })}
          />
          Default shift for people with no allocation
        </label>
        {props.canEdit && (
          <div className="form-actions">
            <button className="button button-primary" disabled={save.isPending}>
              Save shift
            </button>
          </div>
        )}
      </fieldset>
      {save.isSuccess && !props.isNew && <Note kind="info">Saved.</Note>}
      {save.error && <Note kind="error">{errorMessage(save.error)}</Note>}
    </form>
  );
}

/**
 * Put one person or a whole project team on a shift from a date (optionally until a date, after which
 * their previous shift resumes), with their own day times if different. Managers send it to HR.
 */
function Allocate({ shifts, asRequest }: { shifts: ShiftView[]; asRequest: boolean }) {
  const client = useQueryClient();
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<Map<string, string>>(new Map());
  const [shiftId, setShiftId] = useState('');
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState('');
  const [ownTimes, setOwnTimes] = useState(false);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [reason, setReason] = useState('');
  const people = useQuery({
    queryKey: ['people', q, 'active'],
    queryFn: () => {
      const params = new URLSearchParams({ status: 'active' });
      if (q.trim()) params.set('q', q.trim());
      return api<PersonSummary[]>(`/people?${params}`);
    },
  });
  const submit = useMutation({
    mutationFn: () =>
      api<{ allocated: number } | { requestIds: string[] }>(
        asRequest ? '/shifts/change-requests' : '/shifts/allocations',
        {
          body: {
            personIds: [...chosen.keys()],
            shiftId,
            effectiveFrom: from,
            ...(to ? { effectiveTo: to } : {}),
            ...(ownTimes ? { startTime, endTime } : {}),
            reason,
          },
        },
      ),
    onSuccess: () => {
      setChosen(new Map());
      setReason('');
      return Promise.all([
        client.invalidateQueries({ queryKey: ['person-shifts'] }),
        client.invalidateQueries({ queryKey: ['requests'] }),
      ]);
    },
  });
  const toggle = (person: PersonSummary, on: boolean) => {
    const next = new Map(chosen);
    if (on) next.set(person.personId, person.preferredName ?? person.legalName);
    else next.delete(person.personId);
    setChosen(next);
  };
  const result = submit.data;

  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        submit.mutate();
      }}
    >
      {asRequest && (
        <p className="muted">HR approves shift changes; you’ll see each one in My requests.</p>
      )}
      <Field label="Find people">
        {(id) => (
          <input
            id={id}
            type="search"
            placeholder="Name, code or email"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        )}
      </Field>
      <fieldset className="check-group people-picker">
        <legend>People ({chosen.size} chosen)</legend>
        {people.error && <Note kind="error">{errorMessage(people.error)}</Note>}
        {people.data?.length === 0 && <Empty>No one matches.</Empty>}
        {people.data?.map((p) => (
          <label key={p.personId} className="check">
            <input
              type="checkbox"
              checked={chosen.has(p.personId)}
              onChange={(e) => toggle(p, e.target.checked)}
            />
            {p.preferredName ?? p.legalName} <span className="muted">{p.employeeCode}</span>
          </label>
        ))}
        {[...chosen.entries()]
          .filter(([id]) => !people.data?.some((p) => p.personId === id))
          .map(([id, name]) => (
            <label key={id} className="check">
              <input
                type="checkbox"
                checked
                onChange={() => toggle({ personId: id } as PersonSummary, false)}
              />
              {name}
            </label>
          ))}
      </fieldset>
      <div className="form-grid">
        <Field label="Shift">
          {(id) => (
            <select id={id} required value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
              <option value="">Choose a shift</option>
              {shifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({describeShift(s)})
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="From">
          {(id) => (
            <input
              id={id}
              type="date"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          )}
        </Field>
        <Field label="Until" hint="Optional; their previous shift resumes after.">
          {(id) => (
            <input
              id={id}
              type="date"
              min={from}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          )}
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={ownTimes} onChange={(e) => setOwnTimes(e.target.checked)} />
        They start and end the day at different times
      </label>
      {ownTimes && (
        <div className="form-grid">
          <Field label="Day starts">
            {(id) => (
              <input
                id={id}
                type="time"
                required
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            )}
          </Field>
          <Field label="Day ends">
            {(id) => (
              <input
                id={id}
                type="time"
                required
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            )}
          </Field>
        </div>
      )}
      <Field label="Reason" hint="E.g. the customer project.">
        {(id) => (
          <input id={id} required value={reason} onChange={(e) => setReason(e.target.value)} />
        )}
      </Field>
      <button
        className="button button-primary"
        disabled={submit.isPending || chosen.size === 0 || !shiftId}
      >
        {asRequest ? 'Send to HR' : `Allocate ${chosen.size || ''}`.trim()}
      </button>
      {result && 'allocated' in result && (
        <Note kind="info">
          Shift allocated for {result.allocated} {result.allocated === 1 ? 'person' : 'people'}.
        </Note>
      )}
      {result && 'requestIds' in result && (
        <Note kind="info">
          Sent to HR: {result.requestIds.length} request{result.requestIds.length === 1 ? '' : 's'}.
        </Note>
      )}
      {submit.error && <Note kind="error">{errorMessage(submit.error)}</Note>}
    </form>
  );
}
