import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import {
  timelineCategories,
  timelineCategoryColours,
  timelineCategoryWords,
  timelineHiddenByDefault,
  type PersonTimelineView,
  type TimelineCategory,
  type TimelineEvent,
  type TimelineSegment,
} from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { useMe } from '../../auth.js';
import { Chip, Empty, formatDate, Note } from '../../design-system/index.js';

/**
 * Journey timelines (slice 10; E8, H2; decision #84), after the Employee Journey Timeline design:
 * a horizontal track with event cards above and below the axis, lanes for status, designation,
 * team and (for pay readers) CTC, category filters, a Today line and what's coming up.
 */

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
const addMonths = (iso: string, n: number) => {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const monthLabel = (iso: string, withYear: boolean) =>
  new Intl.DateTimeFormat('en-IN', {
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`));

/** "in 6 days", "in 3 weeks", "in 4 months" (design: days under 14, weeks under 60 days). */
export function countdown(today: string, date: string): string {
  const days = daysBetween(today, date);
  if (days < 0) return `${-days} ${days === -1 ? 'day' : 'days'} overdue`;
  if (days === 0) return 'today';
  if (days < 14) return `in ${days} ${days === 1 ? 'day' : 'days'}`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30.4)} months`;
}

/** ₹6.0 L, ₹16.2 L, ₹85,000 (pay as the design shows it; annual figures in lakh). */
export function lakh(paise: string, rateUnit: string): string {
  const rupees = Number(BigInt(paise) / 100n);
  const unit = rateUnit === 'year' ? ' p.a.' : rateUnit === 'month' ? ' /mo' : '';
  if (rupees >= 100_000) return `₹${(rupees / 100_000).toFixed(1)} L${unit}`;
  return `₹${new Intl.NumberFormat('en-IN').format(rupees)}${unit}`;
}

const catStyle = (c: TimelineCategory) =>
  ({ '--cat': timelineCategoryColours[c] }) as CSSProperties;

function useTimeline(personId: string) {
  return useQuery({
    queryKey: ['timeline', personId],
    queryFn: () => api<PersonTimelineView>(`/people/${personId}/timeline`),
  });
}

/** The visible window: from the month of joining to a little past today or the exit. */
function windowOf(v: PersonTimelineView) {
  const last = [v.today, v.person.lastWorkingDate ?? v.today, ...v.events.map((e) => e.date)]
    .sort()
    .at(-1)!;
  const exited = v.person.status === 'exited';
  const from = monthStart(v.person.joiningDate);
  const to = addMonths(exited ? (v.person.lastWorkingDate ?? last) : last, exited ? 1 : 2);
  const months = Math.max(1, daysBetween(from, to) / 30.44);
  const perMonth = Math.min(150, Math.max(30, 2300 / months));
  return { from, to, months, perMonth, width: Math.round(months * perMonth) };
}

/** The full journey: header, tiles or coming up, filters, the track with lanes, and the detail. */
export function FullJourney({ personId }: { personId: string }) {
  const data = useTimeline(personId);
  const [off, setOff] = useState<Set<TimelineCategory>>(() => new Set(timelineHiddenByDefault));
  const [showUpcoming, setShowUpcoming] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const v = data.data;
  const visible = useMemo(
    () => (v?.events ?? []).filter((e) => !off.has(e.category) && (showUpcoming || !e.upcoming)),
    [v, off, showUpcoming],
  );
  if (data.error) return <Note kind="error">{errorMessage(data.error)}</Note>;
  if (!v) return <p className="muted">Loading…</p>;

  const exited = v.person.status === 'exited';
  const counts = new Map<TimelineCategory, number>();
  for (const e of v.events) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  const upcoming = v.events.filter((e) => e.upcoming);
  const chosen = visible.find((e) => e.id === selected) ?? null;
  const toggle = (c: TimelineCategory) => {
    const next = new Set(off);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setOff(next);
  };

  return (
    <section className="journey" aria-label="Journey">
      <JourneyHeader view={v} />
      {exited ? (
        <Tiles view={v} />
      ) : (
        upcoming.length > 0 && (
          <section aria-labelledby="coming-up">
            <h3 id="coming-up">Coming up</h3>
            <ul className="coming-up">
              {upcoming.slice(0, 3).map((e) => {
                const soon = daysBetween(v.today, e.date) <= 14;
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      className={`coming-card${soon ? ' coming-soon' : ''}`}
                      style={catStyle(e.category)}
                      onClick={() => {
                        setShowUpcoming(true);
                        setSelected(e.id);
                      }}
                    >
                      <span className="cat-label">
                        <span className="cat-swatch" aria-hidden="true" />
                        {timelineCategoryWords[e.category]}
                      </span>
                      <Chip tone={soon ? 'warn' : 'muted'}>{countdown(v.today, e.date)}</Chip>
                      <strong>{e.title}</strong>
                      <span className="mono muted">{formatDate(e.date)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )
      )}

      <div className="journey-card">
        <div className="journey-filters" role="group" aria-label="Show events">
          {timelineCategories
            .filter((c) => counts.has(c))
            .map((c) => (
              <button
                key={c}
                type="button"
                className={`cat-chip${off.has(c) ? ' cat-chip-off' : ''}`}
                style={catStyle(c)}
                aria-pressed={!off.has(c)}
                onClick={() => toggle(c)}
              >
                <span className="cat-swatch" aria-hidden="true" />
                {timelineCategoryWords[c]} <span className="muted">{counts.get(c)}</span>
              </button>
            ))}
          {!exited && upcoming.length > 0 && (
            <button
              type="button"
              className={`cat-chip cat-chip-upcoming${showUpcoming ? '' : ' cat-chip-off'}`}
              aria-pressed={showUpcoming}
              onClick={() => setShowUpcoming(!showUpcoming)}
            >
              <span className="cat-swatch cat-swatch-hollow" aria-hidden="true" />
              Upcoming <span className="muted">{upcoming.length}</span>
            </button>
          )}
        </div>
        <Track view={v} events={visible} selected={selected} onSelect={setSelected} />
      </div>

      <Detail view={v} event={chosen} events={visible} onSelect={setSelected} />
    </section>
  );
}

function JourneyHeader({ view: v }: { view: PersonTimelineView }) {
  const p = v.person;
  const status =
    p.status === 'exited'
      ? ['Exited', 'muted']
      : p.status === 'on_notice'
        ? ['On notice', 'warn']
        : ['Active', 'ok'];
  return (
    <header className="journey-header">
      <div>
        <h2>{p.name}</h2>
        <p className="muted">
          {[p.designation, p.department, p.employeeCode, p.location].filter(Boolean).join(' · ')}
        </p>
        <p className="mono muted">
          {formatDate(p.joiningDate)} →{' '}
          {p.status === 'exited' && p.lastWorkingDate ? formatDate(p.lastWorkingDate) : 'today'}
        </p>
      </div>
      <p>
        <Chip tone={status[1] as 'ok' | 'warn' | 'muted'}>{status[0]}</Chip>{' '}
        {p.onProbation && p.status !== 'exited' && <Chip tone="warn">On probation</Chip>}
      </p>
    </header>
  );
}

function Tiles({ view: v }: { view: PersonTimelineView }) {
  const t = v.tiles;
  const tenure = [
    t.tenure.years ? `${t.tenure.years} yr${t.tenure.years === 1 ? '' : 's'}` : null,
    `${t.tenure.months} mo`,
  ]
    .filter(Boolean)
    .join(' ');
  const rate = v.lanes.ctc?.at(-1)?.rateUnit ?? 'year';
  return (
    <ul className="journey-tiles" aria-label="Summary">
      <li>
        <span className="eyebrow">Tenure</span>
        <strong>{tenure}</strong>
      </li>
      <li>
        <span className="eyebrow">Designations</span>
        <strong>{t.designations}</strong>
        <span className="muted">
          {t.designationChanges} {t.designationChanges === 1 ? 'change' : 'changes'}
        </span>
      </li>
      <li>
        <span className="eyebrow">Teams</span>
        <strong>{t.teams}</strong>
      </li>
      {t.ctcGrowth && (
        <li>
          <span className="eyebrow">CTC growth</span>
          <strong>
            {lakh(t.ctcGrowth.fromPaise, rate)} → {lakh(t.ctcGrowth.toPaise, rate)}
          </strong>
          <span className="muted">
            {t.ctcGrowth.revisions} {t.ctcGrowth.revisions === 1 ? 'revision' : 'revisions'}
          </span>
        </li>
      )}
    </ul>
  );
}

const SLOTS = [160, 336, 24, 472];

function Track(props: {
  view: PersonTimelineView;
  events: TimelineEvent[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const v = props.view;
  const w = windowOf(v);
  const x = (date: string) => Math.max(0, (daysBetween(w.from, date) / 30.44) * w.perMonth);
  const exited = v.person.status === 'exited';
  const ticks: { at: string; label: string }[] = [];
  const yearly = w.months > 30;
  for (let m = w.from; m <= w.to; m = addMonths(m, 1)) {
    const isJan = m.slice(5, 7) === '01';
    if (yearly ? isJan || m === w.from : true) {
      ticks.push({ at: m, label: monthLabel(m, isJan || m === w.from) });
    }
  }
  const todayX = x(v.today);
  const lastPast = v.person.lastWorkingDate && exited ? v.person.lastWorkingDate : v.today;
  const furthest =
    props.events
      .map((e) => e.date)
      .sort()
      .at(-1) ?? v.today;
  const lanes: [string, TimelineSegment[], (s: TimelineSegment) => string][] = [
    ['Status', v.lanes.status, (s) => s.label],
    ['Designation', v.lanes.designation, (s) => s.label],
    ['Team', v.lanes.team, (s) => s.label],
  ];
  const ctc = v.lanes.ctc;
  const maxCtc = ctc?.length
    ? Math.max(...ctc.map((c) => Number(BigInt(c.amountPaise) / 100n)))
    : 0;

  return (
    <div className="track-scroll" tabIndex={0} aria-label="Timeline, scrolls sideways">
      <div className="track" style={{ width: w.width + 150 }}>
        <div className="track-ticks" style={{ marginLeft: 150, width: w.width }} aria-hidden="true">
          {ticks.map((t) => (
            <span
              key={t.at}
              className={`tick${t.at > v.today ? ' tick-future' : ''}`}
              style={{ left: x(t.at) }}
            >
              {t.label}
            </span>
          ))}
        </div>
        <div className="track-body" style={{ marginLeft: 150, width: w.width }}>
          {!exited && (
            <>
              <div className="future-shade" style={{ left: todayX }} aria-hidden="true" />
              <div className="today-line" style={{ left: todayX }} aria-hidden="true">
                <span className="today-pill">Today · {formatDate(v.today)}</span>
              </div>
            </>
          )}
          <div className="events-lane">
            <div className="axis" aria-hidden="true" />
            <div
              className="spine"
              style={{
                left: x(v.person.joiningDate),
                width: Math.max(0, x(lastPast) - x(v.person.joiningDate)),
              }}
              aria-hidden="true"
            />
            {!exited && furthest > v.today && (
              <div
                className="spine spine-future"
                style={{ left: todayX, width: Math.max(0, x(furthest) - todayX) }}
                aria-hidden="true"
              />
            )}
            {props.events.length === 0 && (
              <p className="track-empty muted">
                No events in view. Turn on a filter to see events.
              </p>
            )}
            {props.events.map((e, i) => {
              const top = SLOTS[i % SLOTS.length]!;
              const left = x(e.date);
              const isSelected = props.selected === e.id;
              return (
                <div key={e.id} style={catStyle(e.category)}>
                  <span
                    className={`stem${top < 300 ? '' : ' stem-down'}`}
                    style={{
                      left,
                      top: top < 300 ? top + 104 : 300,
                      height: top < 300 ? 300 - top - 104 : top - 300,
                    }}
                    aria-hidden="true"
                  />
                  <span
                    className={`dot${e.upcoming ? ' dot-upcoming' : ''}${isSelected ? ' dot-selected' : ''}`}
                    style={{ left }}
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    className={`event-card${e.upcoming ? ' event-upcoming' : ''}${isSelected ? ' event-selected' : ''}`}
                    style={{ left: Math.min(left - 12, w.width - 172), top }}
                    aria-pressed={isSelected}
                    aria-label={`${e.title}, ${formatDate(e.date)}, ${timelineCategoryWords[e.category]}${e.upcoming ? ', upcoming' : ''}`}
                    onClick={() => props.onSelect(e.id)}
                  >
                    <span className="cat-label">
                      <span className="cat-swatch" aria-hidden="true" />
                      {timelineCategoryWords[e.category]}
                    </span>
                    <span className="mono">{formatDate(e.date)}</span>
                    <strong>{e.title}</strong>
                  </button>
                </div>
              );
            })}
          </div>
          {lanes.map(([name, segments, label]) => (
            <div key={name} className="lane" aria-label={`${name} lane`}>
              <span className="lane-label">{name}</span>
              {segments.map((s) => {
                const end = s.to ?? (exited ? (v.person.lastWorkingDate ?? v.today) : w.to);
                return (
                  <span
                    key={`${s.from}-${s.label}`}
                    className={`lane-bar lane-${name.toLowerCase()}`}
                    style={{ left: x(s.from), width: Math.max(8, x(end) - x(s.from)) }}
                    title={`${label(s)}: ${formatDate(s.from)} – ${s.to ? formatDate(s.to) : 'now'}`}
                  >
                    {label(s)}
                  </span>
                );
              })}
            </div>
          ))}
          {ctc && ctc.length > 0 && (
            <div className="lane lane-ctc-row" aria-label="CTC lane">
              <span className="lane-label">CTC</span>
              {ctc.map((c) => {
                const end = c.to ?? (exited ? (v.person.lastWorkingDate ?? v.today) : v.today);
                const rupees = Number(BigInt(c.amountPaise) / 100n);
                const height = Math.max(10, Math.round((rupees / (maxCtc || 1)) * 56));
                return (
                  <span
                    key={c.from}
                    className="ctc-step"
                    style={{ left: x(c.from), width: Math.max(8, x(end) - x(c.from)), height }}
                  >
                    <span className="ctc-label mono">{lakh(c.amountPaise, c.rateUnit)}</span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Detail(props: {
  view: PersonTimelineView;
  event: TimelineEvent | null;
  events: TimelineEvent[];
  onSelect: (id: string) => void;
}) {
  const e = props.event;
  const i = e ? props.events.findIndex((x) => x.id === e.id) : -1;
  return (
    <section className="journey-detail" aria-live="polite" aria-label="Event detail">
      {!e ? (
        <p className="muted">Choose an event on the timeline to see its details.</p>
      ) : (
        <>
          <div className="detail-head" style={catStyle(e.category)}>
            <span className="cat-label">
              <span className="cat-swatch" aria-hidden="true" />
              {timelineCategoryWords[e.category]}
            </span>
            <span className="mono">{formatDate(e.date)}</span>
            {e.upcoming && (
              <Chip tone="info">Upcoming · {countdown(props.view.today, e.date)}</Chip>
            )}
            {e.overdue && <Chip tone="warn">Overdue</Chip>}
            <span className="detail-nav">
              <button
                type="button"
                className="button button-quiet"
                disabled={i <= 0}
                onClick={() => props.onSelect(props.events[i - 1]!.id)}
              >
                ← Previous
              </button>
              <button
                type="button"
                className="button button-quiet"
                disabled={i >= props.events.length - 1}
                onClick={() => props.onSelect(props.events[i + 1]!.id)}
              >
                Next →
              </button>
            </span>
          </div>
          <h3>{e.title}</h3>
          {e.facts.length > 0 && (
            <dl className="facts">
              {e.facts.map(([k, val]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{val}</dd>
                </div>
              ))}
            </dl>
          )}
          {e.link && <Link to={e.link}>Open the record</Link>}
        </>
      )}
    </section>
  );
}

/** The compact strip on a profile: dots on a line, Today, and the selected event; links to the full view. */
export function CompactJourney({ personId, onOpen }: { personId: string; onOpen: () => void }) {
  const data = useTimeline(personId);
  const [selected, setSelected] = useState<string | null>(null);
  const v = data.data;
  if (data.error || !v) return null;
  const events = v.events.filter((e) => !timelineHiddenByDefault.includes(e.category));
  if (events.length === 0) return <Empty>No journey events yet.</Empty>;
  const w = windowOf(v);
  const pct = (date: string) =>
    Math.min(
      100,
      Math.max(0, (daysBetween(w.from, date) / Math.max(1, daysBetween(w.from, w.to))) * 100),
    );
  const upcoming = events.filter((e) => e.upcoming).length;
  const chosen =
    events.find((e) => e.id === selected) ?? events.find((e) => e.upcoming) ?? events.at(-1)!;
  const exited = v.person.status === 'exited';
  return (
    <section className="journey-compact" aria-label="Journey">
      <div className="card-head">
        <strong>Journey</strong>
        <span className="muted">
          {events.length} events{upcoming ? ` · ${upcoming} upcoming` : ''}
        </span>
        <button type="button" className="button button-quiet" onClick={onOpen}>
          View full journey →
        </button>
      </div>
      <div className="strip">
        <div className="strip-line" aria-hidden="true" />
        {!exited && (
          <span className="strip-today" style={{ left: `${pct(v.today)}%` }} aria-hidden="true" />
        )}
        {events.map((e) => (
          <button
            key={e.id}
            type="button"
            className={`strip-dot${e.upcoming ? ' dot-upcoming' : ''}${chosen.id === e.id ? ' dot-selected' : ''}`}
            style={{ ...catStyle(e.category), left: `${pct(e.date)}%` }}
            aria-label={`${e.title}, ${formatDate(e.date)}`}
            aria-pressed={chosen.id === e.id}
            onClick={() => setSelected(e.id)}
          />
        ))}
      </div>
      <div className="strip-detail" style={catStyle(chosen.category)} aria-live="polite">
        <span className="cat-label">
          <span className="cat-swatch" aria-hidden="true" />
          {timelineCategoryWords[chosen.category]}
        </span>
        <span className="mono">{formatDate(chosen.date)}</span>
        {chosen.upcoming && <Chip tone="info">{countdown(v.today, chosen.date)}</Chip>}
        <strong>{chosen.title}</strong>
      </div>
    </section>
  );
}

/** E8 My journey. */
export function MyJourney() {
  const me = useMe().data;
  if (!me?.personId)
    return <Note kind="info">The journey is for people with a record in iPro.</Note>;
  return (
    <main className="page">
      <h1>My journey</h1>
      <FullJourney personId={me.personId} />
    </main>
  );
}
