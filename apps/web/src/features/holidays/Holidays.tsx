import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { HolidayCalendarView } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { hasRole, useMe } from '../../auth.js';
import {
  Chip,
  Empty,
  Field,
  formatDate,
  ListDetail,
  Note,
  todayIso,
} from '../../design-system/index.js';

const thisYear = () => Number(todayIso().slice(0, 4));

/**
 * Holiday calendars (A2; decisions #48, #66): the company's, followed by locations, and customers',
 * chosen on a shift allocation. Admins and HR head keep them; HR reads them.
 */
export function Holidays() {
  const { calendarId } = useParams();
  const navigate = useNavigate();
  const me = useMe().data;
  const canEdit = hasRole(me, 'admin', 'hr_head');
  const [year, setYear] = useState(thisYear());
  const [adding, setAdding] = useState(false);
  const calendars = useQuery({
    queryKey: ['holiday-calendars', year],
    queryFn: () => api<HolidayCalendarView[]>(`/holiday-calendars?year=${year}`),
  });

  const list = (
    <>
      <div className="toolbar">
        <h1>Holidays</h1>
        {hasRole(me, 'admin') && !adding && (
          <button className="button button-primary" onClick={() => setAdding(true)}>
            New calendar
          </button>
        )}
      </div>
      <div className="filters">
        <Field label="Year">
          {(id) => (
            <select id={id} value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[thisYear() - 1, thisYear(), thisYear() + 1].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {adding && <NewCalendar onDone={() => setAdding(false)} />}
      {calendars.error && <Note kind="error">{errorMessage(calendars.error)}</Note>}
      {calendars.data?.length === 0 && <Empty>No holiday calendars yet.</Empty>}
      <ul className="rows" aria-label="Holiday calendars">
        {calendars.data?.map((c) => (
          <li key={c.id}>
            <Link
              to={`/holidays/${c.id}`}
              className={c.id === calendarId ? 'row row-selected' : 'row'}
            >
              <span className="row-main">
                <strong>{c.name}</strong>
                <span className="muted">
                  {c.holidays.length} holidays in {year}
                  {c.locations.length ? ` · ${c.locations.map((l) => l.name).join(', ')}` : ''}
                </span>
              </span>
              <Chip tone={c.kind === 'company' ? 'info' : 'muted'}>
                {c.kind === 'company' ? 'Company' : 'Customer'}
              </Chip>
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
        calendarId ? (
          <CalendarDetail key={calendarId} calendarId={calendarId} year={year} canEdit={canEdit} />
        ) : null
      }
      onClose={() => navigate('/holidays')}
      detailLabel="Holiday calendar"
    />
  );
}

function NewCalendar({ onDone }: { onDone: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    code: '',
    name: '',
    kind: 'company' as 'company' | 'customer',
  });
  const create = useMutation({
    mutationFn: () => api<HolidayCalendarView>('/holiday-calendars', { body: form }),
    onSuccess: (calendar) => {
      void client.invalidateQueries({ queryKey: ['holiday-calendars'] });
      onDone();
      navigate(`/holidays/${calendar.id}`);
    },
  });
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h3>New holiday calendar</h3>
      <div className="form-grid">
        <Field label="Code">
          {(id) => (
            <input
              id={id}
              required
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          )}
        </Field>
        <Field label="Name" hint="e.g. Chennai, or the customer's name">
          {(id) => (
            <input
              id={id}
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          )}
        </Field>
        <Field label="Kind">
          {(id) => (
            <select
              id={id}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as 'company' })}
            >
              <option value="company">Company (followed by locations)</option>
              <option value="customer">Customer (chosen on shift allocations)</option>
            </select>
          )}
        </Field>
      </div>
      <div className="form-actions">
        <button className="button button-primary" disabled={create.isPending}>
          Create calendar
        </button>
        <button type="button" className="button button-quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
      {create.error && <Note kind="error">{errorMessage(create.error)}</Note>}
    </form>
  );
}

function CalendarDetail(props: { calendarId: string; year: number; canEdit: boolean }) {
  const client = useQueryClient();
  const calendar = useQuery({
    queryKey: ['holiday-calendar', props.calendarId, props.year],
    queryFn: () =>
      api<HolidayCalendarView>(`/holiday-calendars/${props.calendarId}?year=${props.year}`),
  });
  const refresh = (view: HolidayCalendarView) => {
    client.setQueryData(['holiday-calendar', props.calendarId, props.year], view);
    return client.invalidateQueries({ queryKey: ['holiday-calendars'] });
  };
  const remove = useMutation({
    mutationFn: (holidayId: string) =>
      api<HolidayCalendarView>(`/holiday-calendars/${props.calendarId}/holidays/${holidayId}`, {
        method: 'DELETE',
      }),
    onSuccess: refresh,
  });
  if (calendar.error) return <Note kind="error">{errorMessage(calendar.error)}</Note>;
  if (!calendar.data) return <p className="muted">Loading…</p>;
  const c = calendar.data;
  return (
    <article className="record">
      <header className="record-header">
        <h2>{c.name}</h2>
        <p className="muted">
          {c.code} · {c.kind === 'company' ? 'Company calendar' : 'Customer calendar'}
        </p>
      </header>
      {c.kind === 'company' && (
        <p className="muted">
          Followed by:{' '}
          {c.locations.length ? c.locations.map((l) => l.name).join(', ') : 'no location yet'}
        </p>
      )}
      <h3>{props.year}</h3>
      {c.holidays.length === 0 && <Empty>No holidays in {props.year}.</Empty>}
      <ul className="rows" aria-label="Holidays">
        {c.holidays.map((h) => (
          <li key={h.id} className="row">
            <span className="row-main">
              <strong>{h.name}</strong>
              <span className="muted">{formatDate(h.date)}</span>
            </span>
            <span className="row-side">
              {h.optional && <Chip tone="muted">Optional</Chip>}
              {props.canEdit && (
                <button
                  className="button button-quiet"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm(`Remove ${h.name}?`)) remove.mutate(h.id);
                  }}
                >
                  Remove
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {remove.error && <Note kind="error">{errorMessage(remove.error)}</Note>}
      {props.canEdit && <AddHoliday calendarId={c.id} onAdded={refresh} />}
      {props.canEdit && c.kind === 'company' && <ApplyToLocation calendarId={c.id} />}
    </article>
  );
}

function AddHoliday(props: {
  calendarId: string;
  onAdded: (view: HolidayCalendarView) => unknown;
}) {
  const [form, setForm] = useState({ date: '', name: '', optional: false });
  const add = useMutation({
    mutationFn: () =>
      api<HolidayCalendarView>(`/holiday-calendars/${props.calendarId}/holidays`, { body: form }),
    onSuccess: (view) => {
      setForm({ date: '', name: '', optional: false });
      return props.onAdded(view);
    },
  });
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <h3>Add a holiday</h3>
      <div className="form-grid">
        <Field label="Date">
          {(id) => (
            <input
              id={id}
              type="date"
              required
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          )}
        </Field>
        <Field label="Holiday">
          {(id) => (
            <input
              id={id}
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          )}
        </Field>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={form.optional}
          onChange={(e) => setForm({ ...form, optional: e.target.checked })}
        />
        Optional (people choose whether to take it)
      </label>
      <button className="button button-primary" disabled={add.isPending}>
        Add holiday
      </button>
      {add.error && <Note kind="error">{errorMessage(add.error)}</Note>}
    </form>
  );
}

/** A location's calendar is part of its dated record (decision #21): changed from a date. */
function ApplyToLocation({ calendarId }: { calendarId: string }) {
  const client = useQueryClient();
  const [locationId, setLocationId] = useState('');
  const [from, setFrom] = useState(`${thisYear()}-01-01`);
  const locations = useQuery({
    queryKey: ['org', 'locations', todayIso()],
    queryFn: () => api<{ id: string; name: string }[]>(`/org/units/locations?asOf=${todayIso()}`),
  });
  const apply = useMutation({
    mutationFn: () =>
      api(`/org/units/locations/${locationId}/changes`, {
        body: { effectiveFrom: from, holidayCalendarId: calendarId },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['holiday-calendar', calendarId] }),
  });
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        apply.mutate();
      }}
    >
      <h3>Use at a location</h3>
      <div className="form-grid">
        <Field label="Location">
          {(id) => (
            <select
              id={id}
              required
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
            >
              <option value="">Choose…</option>
              {locations.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
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
      </div>
      <button className="button" disabled={apply.isPending}>
        Use this calendar
      </button>
      {apply.isSuccess && (
        <Note kind="info">Done. People there follow it from {formatDate(from)}.</Note>
      )}
      {apply.error && <Note kind="error">{errorMessage(apply.error)}</Note>}
    </form>
  );
}
