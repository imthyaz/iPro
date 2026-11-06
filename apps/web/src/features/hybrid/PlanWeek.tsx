import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { SeatAvailability, WeekDayView, WeekPlanView, WorkMode } from '@ipro/shared';
import { api, ApiError, errorMessage } from '../../api.js';
import { hasRole, useMe } from '../../auth.js';
import { Chip, Field, Note, todayIso } from '../../design-system/index.js';

const modeWords: Record<WorkMode, string> = {
  office: 'Office',
  wfh: 'WFH',
  client_site: 'Client site',
};
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (iso: string) =>
  addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
const dayName = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`));
const time = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(iso));

interface Draft {
  mode: WorkMode | null;
  locationId?: string;
  seatId?: string;
}

const draftOf = (d: WeekDayView): Draft => ({
  mode: d.booking?.mode ?? null,
  ...(d.booking?.locationId ? { locationId: d.booking.locationId } : {}),
  ...(d.booking?.seatId ? { seatId: d.booking.seatId } : {}),
});
const same = (a: Draft, b: Draft) =>
  a.mode === b.mode && a.locationId === b.locationId && a.seatId === b.seatId;

/**
 * E6 Plan my week (spec workflow 6; decision #78): WFH, office (optionally a seat) or client site
 * for each working day, with the policy meter. A week within policy is confirmed at once; one
 * below asks for a reason and goes to the manager. Days lock at 18:00 the day before.
 */
export function PlanWeek() {
  const me = useMe().data;
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const week = mondayOf(params.get('week') ?? addDays(todayIso(), 7));
  const [saved, setSaved] = useState<string | null>(null);
  const data = useQuery({
    queryKey: ['hybrid-week', week],
    queryFn: () => api<WeekPlanView>(`/hybrid/week?start=${week}`),
  });
  const go = (to: string) => {
    setSaved(null);
    setParams({ week: to });
  };
  return (
    <main className="page">
      <div className="toolbar">
        <h1>Plan my week</h1>
      </div>
      <div className="form-actions" role="group" aria-label="Week">
        <button className="button button-quiet" onClick={() => go(addDays(week, -7))}>
          ← Previous
        </button>
        <strong>
          {dayName(week)} – {dayName(addDays(week, 6))}
        </strong>
        <button className="button button-quiet" onClick={() => go(addDays(week, 7))}>
          Next →
        </button>
      </div>
      {data.error && <Note kind="error">{errorMessage(data.error)}</Note>}
      {data.data && !data.data.policy && (
        <Note kind="info">No hybrid policy applies to you; ask HR.</Note>
      )}
      {data.data?.policy && (
        // A fresh editor for each week as loaded or saved, so its drafts start from the server.
        <WeekEditor
          key={`${week}:${data.dataUpdatedAt}`}
          view={data.data}
          onSaved={(view) => {
            client.setQueryData(['hybrid-week', week], view);
            void client.invalidateQueries({ queryKey: ['approvals'] });
            setSaved(
              view.exception?.status === 'pending'
                ? 'Sent to your manager.'
                : 'Saved and confirmed.',
            );
          }}
        />
      )}
      {saved && <span role="status">{saved}</span>}
      {hasRole(me, 'manager') && <TeamAnchor />}
    </main>
  );
}

function WeekEditor({
  view: v,
  onSaved,
}: {
  view: WeekPlanView;
  onSaved: (v: WeekPlanView) => void;
}) {
  const policy = v.policy!;
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(v.days.map((d) => [d.date, draftOf(d)])),
  );
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const changed = v.days.filter((d) => drafts[d.date] && !same(drafts[d.date]!, draftOf(d)));
  const save = useMutation({
    mutationFn: () =>
      api<WeekPlanView>('/hybrid/week', {
        method: 'PUT',
        body: {
          weekStart: v.weekStart,
          days: changed.map((d) => ({ date: d.date, ...drafts[d.date]! })),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      }),
    onSuccess: onSaved,
    onError: (error) => {
      if (error instanceof ApiError && error.body?.problems) setProblems(error.body.problems);
    },
  });

  // The meter counts what is on screen, before saving.
  const available = v.days.filter((d) => d.working && d.leave !== 'full');
  const target = Math.min(policy.requiredDays, available.length);
  const booked = available.filter((d) => drafts[d.date]?.mode === policy.requiredMode).length;
  const anchorDay =
    policy.anchorDayRequired && policy.requiredMode === 'office' && v.anchorWeekday
      ? v.days[v.anchorWeekday - 1]
      : undefined;
  const needsReason = problems.length > 0;

  return (
    <>
      <section className="card" aria-label="Policy meter">
        <div className="card-head">
          <strong>{policy.name}</strong>
          <Chip tone={booked >= target ? 'ok' : 'warn'}>
            {booked} of {target} {policy.requiredMode === 'office' ? 'office' : 'client-site'} days
          </Chip>
        </div>
        <span className="muted">
          {policy.requiredDays} a week
          {target < policy.requiredDays ? `, ${target} this week after leave and holidays` : ''}
          {anchorDay ? ` · team anchor day: ${WEEKDAYS[v.anchorWeekday! - 1]}` : ''}
        </span>
        {v.exception && (
          <span>
            {v.exception.status === 'pending' && (
              <Chip tone="info">Below policy: waiting for your manager</Chip>
            )}
            {v.exception.status === 'approved' && <Chip tone="ok">Approved by your manager</Chip>}
            {v.exception.status === 'returned' && (
              <Chip tone="warn">Returned by your manager: plan again</Chip>
            )}
          </span>
        )}
      </section>
      <ul className="cards" aria-label="Days">
        {v.days.map((d) => (
          <DayCard
            key={d.date}
            day={d}
            view={v}
            draft={drafts[d.date] ?? { mode: null }}
            anchor={anchorDay?.date === d.date}
            onChange={(draft) => {
              setDrafts({ ...drafts, [d.date]: draft });
              setProblems([]);
            }}
          />
        ))}
      </ul>
      {needsReason && (
        <div className="note note-info" role="status" aria-label="Below policy">
          <strong>This week is below your policy:</strong>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <Field label="Why? Your manager sees this">
            {(id) => (
              <textarea
                id={id}
                rows={2}
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
        </div>
      )}
      <div className="form-actions">
        <button
          className="button button-primary"
          disabled={save.isPending || changed.length === 0 || (needsReason && !note.trim())}
          onClick={() => save.mutate()}
        >
          {needsReason ? 'Send to my manager' : 'Save my week'}
        </button>
      </div>
      {save.error && !needsReason && <Note kind="error">{errorMessage(save.error)}</Note>}
    </>
  );
}

function DayCard(props: {
  day: WeekDayView;
  view: WeekPlanView;
  draft: Draft;
  anchor: boolean;
  onChange: (draft: Draft) => void;
}) {
  const { day: d, view: v, draft } = props;
  const label = dayName(d.date);
  if (!d.working || d.leave === 'full') {
    return (
      <li className="card day-off" aria-label={label}>
        <strong>{label}</strong>
        <span className="muted">
          {d.holiday ?? (d.leave === 'full' ? 'On leave' : 'Weekly off')}
        </span>
      </li>
    );
  }
  const modes = v.policy!.allowedModes;
  const offices = v.places.filter((p) => p.type === 'office');
  const sites = v.places.filter((p) => p.type === 'client_site');
  const pick = (mode: WorkMode | null) => {
    if (mode === 'office') {
      props.onChange({
        mode,
        locationId: offices.find((o) => o.id === v.homeLocationId)?.id ?? offices[0]?.id,
      });
    } else if (mode === 'client_site') {
      const home = sites.find((s) => s.id === v.homeLocationId);
      props.onChange({ mode, ...(home ? { locationId: home.id } : {}) });
    } else {
      props.onChange({ mode });
    }
  };
  return (
    <li className="card" aria-label={label}>
      <div className="card-head">
        <strong>
          {label}
          {props.anchor ? ' · anchor day' : ''}
          {d.leave ? ` · half-day leave` : ''}
        </strong>
        {d.booking?.status === 'pending' && <Chip tone="info">Waiting</Chip>}
        {d.booking?.status === 'confirmed' && <Chip tone="ok">Confirmed</Chip>}
        {d.booking?.status === 'rejected' && <Chip tone="warn">Returned</Chip>}
      </div>
      <div className="segmented" role="radiogroup" aria-label={`${label}: where`}>
        {modes.map((m) => (
          <label key={m} className={`segment${draft.mode === m ? ' segment-on' : ''}`}>
            <input
              type="radio"
              name={`mode-${d.date}`}
              checked={draft.mode === m}
              disabled={!d.editable}
              onChange={() => pick(m)}
            />
            {modeWords[m]}
          </label>
        ))}
        {draft.mode && d.editable && (
          <button type="button" className="button button-quiet" onClick={() => pick(null)}>
            Clear
          </button>
        )}
      </div>
      {draft.mode === 'office' && (
        <OfficePicker day={d} draft={draft} offices={offices} onChange={props.onChange} />
      )}
      {draft.mode === 'client_site' && sites.length > 0 && (
        <Field label="Client site">
          {(id) => (
            <select
              id={id}
              disabled={!d.editable}
              value={draft.locationId ?? ''}
              onChange={(e) =>
                props.onChange({
                  mode: 'client_site',
                  ...(e.target.value ? { locationId: e.target.value } : {}),
                })
              }
            >
              <option value="">Not listed</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <span className="muted">
        {d.editable ? `Can change until ${time(d.cutoffAt)}` : 'Locked (past 18:00 the day before)'}
      </span>
    </li>
  );
}

function OfficePicker(props: {
  day: WeekDayView;
  draft: Draft;
  offices: WeekPlanView['places'];
  onChange: (draft: Draft) => void;
}) {
  const { day: d, draft } = props;
  const seats = useQuery({
    queryKey: ['hybrid-seats', draft.locationId, d.date],
    queryFn: () =>
      api<SeatAvailability[]>(`/hybrid/seats?locationId=${draft.locationId}&date=${d.date}`),
    enabled: Boolean(draft.locationId) && d.editable,
  });
  return (
    <div className="form-grid">
      <Field label="Office">
        {(id) => (
          <select
            id={id}
            disabled={!d.editable}
            value={draft.locationId ?? ''}
            onChange={(e) => props.onChange({ mode: 'office', locationId: e.target.value })}
          >
            {props.offices.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      {Boolean(seats.data?.length) && (
        <Field label="Seat" hint="Optional">
          {(id) => (
            <select
              id={id}
              disabled={!d.editable}
              value={draft.seatId ?? ''}
              onChange={(e) =>
                props.onChange({
                  mode: 'office',
                  ...(draft.locationId ? { locationId: draft.locationId } : {}),
                  ...(e.target.value ? { seatId: e.target.value } : {}),
                })
              }
            >
              <option value="">Any free seat</option>
              {seats.data!.map((s) => (
                <option key={s.id} value={s.id} disabled={s.taken && s.id !== draft.seatId}>
                  {s.label}
                  {s.zone ? ` (${s.zone})` : ''}
                  {s.taken && s.id !== d.booking?.seatId ? ' — taken' : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
    </div>
  );
}

/** A manager sets their team's anchor day: the day everyone who reports to them comes in. */
function TeamAnchor() {
  const client = useQueryClient();
  const current = useQuery({
    queryKey: ['team-anchor'],
    queryFn: () => api<{ weekday: number | null }>('/hybrid/team-anchor'),
  });
  const set = useMutation({
    mutationFn: (weekday: number | null) =>
      api<{ weekday: number | null }>('/hybrid/team-anchor', { method: 'PUT', body: { weekday } }),
    onSuccess: (value) => {
      client.setQueryData(['team-anchor'], value);
      void client.invalidateQueries({ queryKey: ['hybrid-week'] });
    },
  });
  if (current.error) return null;
  return (
    <section className="card" aria-label="Team anchor day">
      <strong>My team’s anchor day</strong>
      <span className="muted">The day everyone who reports to you comes into the office.</span>
      <Field label="Anchor day">
        {(id) => (
          <select
            id={id}
            disabled={set.isPending || !current.data}
            value={current.data?.weekday ?? ''}
            onChange={(e) => set.mutate(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">None</option>
            {WEEKDAYS.slice(0, 5).map((w, i) => (
              <option key={w} value={i + 1}>
                {w}
              </option>
            ))}
          </select>
        )}
      </Field>
      {set.isSuccess && <span role="status">Saved.</span>}
      {set.error && <Note kind="error">{errorMessage(set.error)}</Note>}
    </section>
  );
}
