import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  AttendanceDayView,
  AttendanceFlag,
  AttendanceStatus,
  CheckInInput,
  TodayView,
  WorkMode,
} from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { useMe } from '../../auth.js';
import { Chip, Field, formatDate, ListDetail, Note, todayIso } from '../../design-system/index.js';

/** The same words and colours for attendance in every module. */
export const statusWords: Record<AttendanceStatus, string> = {
  present: 'Present',
  absent: 'Absent',
  half_day: 'Half day',
  leave: 'On leave',
  holiday: 'Holiday',
  weekly_off: 'Weekly off',
  wfh: 'WFH',
  client_site: 'Client site',
};
const statusTone: Record<AttendanceStatus, 'ok' | 'info' | 'warn' | 'muted'> = {
  present: 'ok',
  wfh: 'ok',
  client_site: 'ok',
  half_day: 'warn',
  absent: 'warn',
  leave: 'info',
  holiday: 'muted',
  weekly_off: 'muted',
};
const flagWords: Record<AttendanceFlag, string> = {
  late: 'Late',
  outside_geofence: 'Outside the office area',
  no_location: 'No location',
  missing_check_out: 'No check-out',
  worked_on_day_off: 'Worked on a day off',
};
const modeWords: Record<WorkMode, string> = {
  office: 'Office',
  wfh: 'WFH',
  client_site: 'Client site',
};

const timeFormat = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});
const time = (iso: string | null) => (iso ? timeFormat.format(new Date(iso)) : '—');
const hours = (minutes: number) => `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

/** The phone's position if it gives one within a few seconds; check-in never waits on it. */
function position(): Promise<Pick<CheckInInput, 'latitude' | 'longitude' | 'accuracy'>> {
  if (!('geolocation' in navigator)) return Promise.resolve({});
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracy: p.coords.accuracy,
        }),
      () => resolve({}),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 },
    ),
  );
}
const device = (): CheckInInput['device'] =>
  window.matchMedia?.('(pointer: coarse)').matches ? 'mobile' : 'web';

export function useToday(enabled: boolean) {
  return useQuery({
    queryKey: ['attendance-today'],
    queryFn: () => api<TodayView>('/attendance/today'),
    enabled,
  });
}

/** E1/E2: check in or out with one tap, in the mode last used (change it first if needed). */
export function TodayCard() {
  const me = useMe().data;
  const client = useQueryClient();
  const today = useToday(Boolean(me?.personId));
  const [chosen, setChosen] = useState<WorkMode | null>(null);
  const punch = useMutation({
    mutationFn: async (direction: 'in' | 'out') => {
      const mode = chosen ?? today.data?.lastMode ?? 'office';
      const where = mode === 'wfh' ? {} : await position();
      return api<TodayView>(`/attendance/check-${direction}`, {
        body: { mode, device: device(), ...where },
      });
    },
    onSuccess: (view) => {
      client.setQueryData(['attendance-today'], view);
      void client.invalidateQueries({ queryKey: ['attendance-month'] });
    },
  });
  if (!me?.personId || !today.data) return null;
  const t = today.data;
  const mode = chosen ?? t.lastMode ?? 'office';
  const last = t.punches.at(-1);
  const dayOff = !t.working;
  return (
    <section className="card today-card" aria-labelledby="today-title">
      <div className="today-head">
        <h2 id="today-title">Today · {formatDate(t.date)}</h2>
        <span className="muted">
          {t.holiday
            ? t.holiday
            : dayOff
              ? 'Weekly off'
              : t.shift
                ? `${t.shift.code} ${t.shift.startTime}–${t.shift.endTime}`
                : ''}
        </span>
      </div>
      {!t.checkedIn && (
        <div className="segmented" role="radiogroup" aria-label="Where are you working today?">
          {(Object.keys(modeWords) as WorkMode[]).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={m === mode}
              className={m === mode ? 'segment segment-active' : 'segment'}
              onClick={() => setChosen(m)}
            >
              {modeWords[m]}
            </button>
          ))}
        </div>
      )}
      <button
        className="button button-primary button-large"
        disabled={punch.isPending}
        onClick={() => punch.mutate(t.checkedIn ? 'out' : 'in')}
      >
        {punch.isPending ? 'Recording…' : t.checkedIn ? 'Check out' : 'Check in'}
      </button>
      {last && (
        <p className="muted" role="status">
          {last.direction === 'out' ? 'Checked out' : 'Checked in'} at {time(last.at)}
          {last.mode ? ` · ${modeWords[last.mode]}` : ''}
          {last.source === 'biometric' ? ' · biometric' : ''}
        </p>
      )}
      {last?.outsideGeofence && (
        <Note kind="info">
          You were about {last.distanceMetres} m from the office, so this is marked for your manager
          to see. Choose Client site or WFH if you aren’t at the office.
        </Note>
      )}
      {punch.error && <Note kind="error">{errorMessage(punch.error)}</Note>}
    </section>
  );
}

/** E3 My attendance; also the Attendance tab of a person record. */
export function AttendanceMonth({ personId }: { personId: string }) {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [selected, setSelected] = useState<string | null>(null);
  const days = useQuery({
    queryKey: ['attendance-month', personId, month],
    queryFn: () => api<AttendanceDayView[]>(`/people/${personId}/attendance?month=${month}`),
  });
  const counts = new Map<AttendanceStatus, number>();
  for (const d of days.data ?? [])
    if (d.status) counts.set(d.status, (counts.get(d.status) ?? 0) + 1);
  const flagged = (days.data ?? []).filter((d) => d.flags.length > 0).length;
  // Monday-first grid: blanks before the 1st.
  const lead = (new Date(`${month}-01T00:00:00Z`).getUTCDay() + 6) % 7;
  const day = days.data?.find((d) => d.date === selected) ?? null;

  const list = (
    <>
      <div className="filters">
        <Field label="Month">
          {(id) => (
            <input
              id={id}
              type="month"
              value={month}
              onChange={(e) => {
                if (e.target.value) setMonth(e.target.value);
                setSelected(null);
              }}
            />
          )}
        </Field>
      </div>
      {days.error && <Note kind="error">{errorMessage(days.error)}</Note>}
      {days.data && (
        <>
          <p className="month-summary">
            {[...counts.entries()].map(([status, n]) => (
              <Chip key={status} tone={statusTone[status]}>
                {statusWords[status]} {n}
              </Chip>
            ))}
            {flagged > 0 && <Chip tone="warn">Flagged {flagged}</Chip>}
          </p>
          <div className="month-grid" role="grid" aria-label={`Attendance for ${month}`}>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => (
              <span key={w} className="month-weekday" aria-hidden="true">
                {w}
              </span>
            ))}
            {Array.from({ length: lead }, (_, i) => (
              <span key={`blank-${i}`} />
            ))}
            {days.data.map((d) => (
              <button
                key={d.date}
                className={`month-day${d.status ? ` day-${statusTone[d.status]}` : ''}${
                  d.date === selected ? ' month-day-selected' : ''
                }`}
                aria-label={`${formatDate(d.date)}: ${d.status ? statusWords[d.status] : 'not yet'}${
                  d.flags.length ? `, ${d.flags.map((f) => flagWords[f]).join(', ')}` : ''
                }`}
                onClick={() => setSelected(d.date)}
              >
                <span className="month-day-number">{Number(d.date.slice(8))}</span>
                <span className="month-day-status">{d.status ? statusWords[d.status] : ''}</span>
                {d.flags.length > 0 && <span className="month-day-flag" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
  return (
    <ListDetail
      list={list}
      detail={day ? <DayDetail day={day} /> : null}
      onClose={() => setSelected(null)}
      detailLabel="Attendance day"
    />
  );
}

/** One day, with the "why": the times it was built from and the rule that gave the status. */
function DayDetail({ day }: { day: AttendanceDayView }) {
  return (
    <article className="record">
      <header className="record-header">
        <h2>{formatDate(day.date)}</h2>
        {day.status && <Chip tone={statusTone[day.status]}>{statusWords[day.status]}</Chip>}
      </header>
      <dl className="facts">
        <dt>First in</dt>
        <dd>{time(day.firstIn)}</dd>
        <dt>Last out</dt>
        <dd>{time(day.lastOut)}</dd>
        <dt>Worked</dt>
        <dd>{day.workedMinutes === null ? '—' : hours(day.workedMinutes)}</dd>
        <dt>Mode</dt>
        <dd>{day.mode ? modeWords[day.mode] : '—'}</dd>
      </dl>
      <h3>Why</h3>
      <p className="muted">{why(day)}</p>
      {day.flags.length > 0 && (
        <ul className="flag-list" aria-label="Flags">
          {day.flags.map((f) => (
            <li key={f}>
              <Chip tone="warn">{flagWords[f]}</Chip>
            </li>
          ))}
        </ul>
      )}
      {day.regularised && <Note kind="info">This day was corrected by a regularisation.</Note>}
    </article>
  );
}

function why(day: AttendanceDayView): string {
  if (day.regularised) return 'Set by an approved regularisation.';
  switch (day.status) {
    case 'holiday':
      return `${day.holiday ?? 'A holiday'} on your holiday calendar.`;
    case 'weekly_off':
      return 'Not a working day on your shift.';
    case 'absent':
      return 'A working day with no check-in or biometric punch.';
    case 'leave':
      return 'Approved leave.';
    case null:
      return day.working ? 'Not built yet: it fills in as you check in.' : 'Not a working day.';
    default:
      return day.workedMinutes === null
        ? `Checked in at ${time(day.firstIn)}; no check-out yet.`
        : `From ${time(day.firstIn)} to ${time(day.lastOut)}, less the shift’s break: ${hours(
            day.workedMinutes,
          )}${day.status === 'half_day' ? ', under the half-day threshold' : ''}.`;
  }
}

export function MyAttendance() {
  const me = useMe().data;
  if (!me?.personId)
    return <Note kind="info">Attendance is for people with a record in iPro.</Note>;
  return (
    <main className="page">
      <h1>My attendance</h1>
      <TodayCard />
      <AttendanceMonth personId={me.personId} />
    </main>
  );
}
