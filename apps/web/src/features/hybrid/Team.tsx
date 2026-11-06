import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type {
  ComplianceView,
  ComplianceWeek,
  TeamCalendarView,
  TeamScope,
  TeamTodayStatus,
  TeamTodayView,
  WorkMode,
} from '@ipro/shared';
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

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (iso: string) =>
  addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
const short = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );
const time = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(iso));

/**
 * Whose people a team screen shows: a manager's own reports by default; HR and HR head can also show
 * everyone in their entities.
 */
function useTeamScope(): [TeamScope, ReactNode] {
  const me = useMe().data;
  const isHr = hasRole(me, 'hr', 'hr_head');
  const [scope, setScope] = useState<TeamScope | null>(null);
  const current: TeamScope = scope ?? (hasRole(me, 'manager') || !isHr ? 'team' : 'all');
  const control = isHr ? (
    <Field label="Show">
      {(id) => (
        <select id={id} value={current} onChange={(e) => setScope(e.target.value as TeamScope)}>
          <option value="team">My team</option>
          <option value="all">Everyone I can see</option>
        </select>
      )}
    </Field>
  ) : null;
  return [current, control];
}

const modeWords: Record<WorkMode, string> = {
  office: 'Office',
  wfh: 'WFH',
  client_site: 'Client site',
};

/** The same words and colours for where people are, on every team screen. */
const todayWords: Record<TeamTodayStatus, [string, 'ok' | 'info' | 'warn' | 'muted']> = {
  office: ['In the office', 'ok'],
  wfh: ['WFH', 'info'],
  client_site: ['Client site', 'info'],
  leave: ['On leave', 'muted'],
  off: ['Day off', 'muted'],
  absent: ['Absent', 'warn'],
  not_checked_in: ['Not checked in', 'warn'],
};

/** M2 Team today (mobile): who is where, exceptions (not checked in, absent) first. */
export function TeamToday() {
  const [scope, scopeControl] = useTeamScope();
  const data = useQuery({
    queryKey: ['team-today', scope],
    queryFn: () => api<TeamTodayView>(`/hybrid/team-today?scope=${scope}`),
    refetchInterval: 5 * 60_000,
  });
  const v = data.data;
  const order: TeamTodayStatus[] = [
    'not_checked_in',
    'absent',
    'office',
    'client_site',
    'wfh',
    'leave',
    'off',
  ];
  return (
    <main className="page">
      <h1>Team today</h1>
      {scopeControl && <div className="filters">{scopeControl}</div>}
      {data.error && <Note kind="error">{errorMessage(data.error)}</Note>}
      {v && (
        <p className="chip-line" aria-label="Team today totals">
          {order
            .filter((s) => v.counts[s] > 0)
            .map((s) => (
              <Chip key={s} tone={todayWords[s][1]}>
                {v.counts[s]} {todayWords[s][0].toLowerCase()}
              </Chip>
            ))}
        </p>
      )}
      {v && v.rows.length === 0 && <Empty>No one in your team to show.</Empty>}
      {v &&
        order
          .filter((s) => v.rows.some((r) => r.status === s))
          .map((s) => (
            <section key={s} aria-labelledby={`today-${s}`}>
              <h2 id={`today-${s}`}>
                {todayWords[s][0]} ({v.counts[s]})
              </h2>
              <ul className="rows" aria-label={todayWords[s][0]}>
                {v.rows
                  .filter((r) => r.status === s)
                  .map((r) => (
                    <li key={r.personId} className="row">
                      <span className="row-main">
                        <strong>{r.name}</strong>
                        <span className="muted">
                          {[
                            r.checkedInAt ? `Checked in ${time(r.checkedInAt)}` : null,
                            r.planned ? `Planned: ${modeWords[r.planned]}` : null,
                            r.note,
                          ]
                            .filter(Boolean)
                            .join(' · ') || r.employeeCode}
                        </span>
                      </span>
                      <Chip tone={todayWords[r.status][1]}>{todayWords[r.status][0]}</Chip>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
    </main>
  );
}

const cellCode: Record<WorkMode, string> = { office: 'O', wfh: 'H', client_site: 'C' };

/** M3 Team calendar: a month of leave and bookings, one row a person. */
export function TeamCalendar() {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [scope, scopeControl] = useTeamScope();
  const data = useQuery({
    queryKey: ['team-calendar', month, scope],
    queryFn: () => api<TeamCalendarView>(`/hybrid/team-calendar?month=${month}&scope=${scope}`),
  });
  const v = data.data;
  const dates = v?.people[0]?.days.map((d) => d.date) ?? [];
  return (
    <main className="page">
      <h1>Team calendar</h1>
      <div className="filters">
        {scopeControl}
        <Field label="Month">
          {(id) => (
            <input
              id={id}
              type="month"
              value={month}
              onChange={(e) => e.target.value && setMonth(e.target.value)}
            />
          )}
        </Field>
      </div>
      <p className="muted" aria-label="Key">
        O office · H WFH · C client site · a leave code (e.g. CL) is leave; ½ a half day, ? asked
        for and not yet approved, … waiting for approval; shaded days are weekly offs and holidays.
      </p>
      {data.error && <Note kind="error">{errorMessage(data.error)}</Note>}
      {v && v.people.length === 0 && <Empty>No one in your team to show.</Empty>}
      {v && v.people.length > 0 && (
        <div className="calendar-scroll">
          <table className="team-calendar">
            <caption className="visually-hidden">Team calendar for {month}</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                {dates.map((d) => (
                  <th key={d} scope="col" title={formatDate(d)}>
                    {Number(d.slice(8))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {v.people.map((p) => (
                <tr key={p.personId}>
                  <th scope="row">{p.name}</th>
                  {p.days.map((d) => {
                    const leave = d.leave
                      ? `${d.leave.code}${d.leave.half === 'full' ? '' : '½'}${d.leave.approved ? '' : '?'}`
                      : '';
                    const booked = d.booking
                      ? `${cellCode[d.booking.mode]}${d.booking.status === 'pending' ? '…' : ''}`
                      : '';
                    const text = leave || booked;
                    const label = [
                      formatDate(d.date),
                      d.holiday ?? (d.working ? null : 'weekly off'),
                      d.leave
                        ? `${d.leave.code} leave${d.leave.half === 'full' ? '' : ', half day'}${d.leave.approved ? '' : ', not yet approved'}`
                        : null,
                      d.booking
                        ? `${modeWords[d.booking.mode]}${d.booking.status === 'pending' ? ', waiting for approval' : ''}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(': ');
                    return (
                      <td
                        key={d.date}
                        className={`${d.working ? '' : 'cal-off'}${d.leave ? ' cal-leave' : ''}`}
                        title={label}
                        aria-label={label}
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

const weekTone = (w: ComplianceWeek) => (w.met ? 'ok' : w.approvedBelow ? 'info' : 'warn');
const weekWords = (w: ComplianceWeek) =>
  `${w.actual} of ${w.target}${w.met ? '' : w.approvedBelow ? ' (approved)' : ''}`;

/**
 * M4 Hybrid compliance (desktop): planned vs actual office days per person per week, from the
 * nightly record. People who missed a week without approval come first; open one to see why.
 */
export function HybridCompliance() {
  const thisWeek = mondayOf(todayIso());
  const [range, setRange] = useState({ from: addDays(thisWeek, -28), to: addDays(thisWeek, -7) });
  const [selected, setSelected] = useState<string | null>(null);
  const [scope, scopeControl] = useTeamScope();
  const data = useQuery({
    queryKey: ['hybrid-compliance', range.from, range.to, scope],
    queryFn: () =>
      api<ComplianceView>(`/hybrid/compliance?from=${range.from}&to=${range.to}&scope=${scope}`),
  });
  const v = data.data;
  const weeks = v?.summary.map((s) => s.weekStart) ?? [];
  const chosen = v?.people.find((p) => p.personId === selected) ?? null;
  const list = (
    <>
      <h1>Hybrid compliance</h1>
      <div className="filters">
        {scopeControl}
        <Field label="From week of">
          {(id) => (
            <input
              id={id}
              type="date"
              value={range.from}
              onChange={(e) =>
                e.target.value && setRange({ ...range, from: mondayOf(e.target.value) })
              }
            />
          )}
        </Field>
        <Field label="To week of">
          {(id) => (
            <input
              id={id}
              type="date"
              value={range.to}
              onChange={(e) =>
                e.target.value && setRange({ ...range, to: mondayOf(e.target.value) })
              }
            />
          )}
        </Field>
      </div>
      <p className="muted">
        Office days from attendance against each person’s policy: an office day counts 1, a half day
        in the office 0.5; leave and holidays lower the week’s target. Recorded each night.
      </p>
      {data.error && <Note kind="error">{errorMessage(data.error)}</Note>}
      {v && (
        <ul className="rows" aria-label="Weeks">
          {v.summary.map((s) => (
            <li key={s.weekStart} className="row">
              <span className="row-main">
                <strong>Week of {short(s.weekStart)}</strong>
              </span>
              <span className="row-chips">
                <Chip tone={s.met === s.people ? 'ok' : 'warn'}>
                  {s.met} of {s.people} met
                </Chip>
                {s.approvedBelow > 0 && <Chip tone="info">{s.approvedBelow} approved below</Chip>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {v && v.people.length === 0 && <Empty>Nothing recorded for these weeks.</Empty>}
      <ul className="rows" aria-label="People">
        {v?.people.map((p) => (
          <li key={p.personId}>
            <button
              className={`row row-button${p.personId === selected ? ' row-selected' : ''}`}
              onClick={() => setSelected(p.personId)}
            >
              <span className="row-main">
                <strong>{p.name}</strong>
                <span className="muted">{p.employeeCode}</span>
              </span>
              <span className="row-chips">
                {weeks.map((w) => {
                  const week = p.weeks.find((x) => x.weekStart === w);
                  return week ? (
                    <Chip key={w} tone={weekTone(week)}>
                      {short(w)}: {weekWords(week)}
                    </Chip>
                  ) : null;
                })}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
  return (
    <main className="page">
      <ListDetail
        list={list}
        detail={chosen ? <ComplianceDetail person={chosen} /> : null}
        onClose={() => setSelected(null)}
        detailLabel="Compliance detail"
      />
    </main>
  );
}

/** The "why": each week's target, plan and what happened, day by day. */
function ComplianceDetail({ person }: { person: ComplianceView['people'][number] }) {
  return (
    <article className="record">
      <header className="record-header">
        <h2>{person.name}</h2>
        <p className="muted">{person.employeeCode}</p>
      </header>
      {person.weeks.map((w) => (
        <section key={w.weekStart} aria-label={`Week of ${short(w.weekStart)}`}>
          <h3>
            Week of {short(w.weekStart)} <Chip tone={weekTone(w)}>{weekWords(w)}</Chip>
          </h3>
          <p className="muted">
            {w.policyName}: target {w.target}{' '}
            {w.requiredMode === 'office' ? 'office' : 'client-site'} days · planned {w.planned} ·
            actual {w.actual}
            {w.approvedBelow ? ' · the manager approved this week below policy' : ''}
          </p>
          <ul className="rows">
            {w.days.map((d) => (
              <li key={d.date} className="row">
                <span className="row-main">
                  <strong>{formatDate(d.date)}</strong>
                  <span className="muted">{d.why}</span>
                </span>
                {d.units > 0 && <Chip tone="ok">+{d.units}</Chip>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}
