import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import {
  timelineCategories,
  timelineCategoryColours,
  timelineCategoryWords,
  timelineHiddenByDefault,
  type TeamJourneyEvent,
  type TeamJourneyPerson,
  type TeamJourneysView,
  type TimelineCategory,
} from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { hasRole, useMe } from '../../auth.js';
import { Chip, Empty, Field, formatDate, Note, todayIso } from '../../design-system/index.js';
import { countdown } from './Journey.js';

/**
 * Team journeys (slice 10b; M6 managers, H11 HR and CXO; decision #85), after the design: summary
 * tiles, group by reportees, department, band or tenure, and one row a person with their events.
 */

type GroupBy = 'manager' | 'department' | 'band' | 'tenure' | 'none';
const groupWords: Record<GroupBy, string> = {
  manager: 'Reportees',
  department: 'Department',
  band: 'Designation band',
  tenure: 'Tenure',
  none: 'None',
};
const bandOrder = ['manager_plus', 'senior_lead', 'associate'];
const bandWords: Record<string, string> = {
  manager_plus: 'Manager & above',
  senior_lead: 'Senior / Lead',
  associate: 'Associate / Engineer',
};
const tenureOrder = ['10+ years', '6–10 years', '3–5 years', '0–2 years'];
const tenureBand = (years: number) =>
  years >= 10 ? '10+ years' : years >= 6 ? '6–10 years' : years >= 3 ? '3–5 years' : '0–2 years';

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const monthYear = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );
const tenureWords = (from: string, to: string) => {
  const months = Math.max(0, Math.floor(daysBetween(from, to) / 30.44));
  return months >= 12
    ? `${Math.floor(months / 12)} yr${months >= 24 ? 's' : ''}${months % 12 ? ` ${months % 12} mo` : ''}`
    : `${months} mo`;
};
const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
const catStyle = (c: TimelineCategory) =>
  ({ '--cat': timelineCategoryColours[c] }) as CSSProperties;

const RANGES = {
  long: { label: 'Last 3 yrs + next 6 mo', back: 3 * 365, ahead: 183 },
  short: { label: 'Last 12 mo + next 6 mo', back: 365, ahead: 183 },
} as const;
const TRACK = 1760;

export function TeamJourneys() {
  const me = useMe().data;
  const seesAll = hasRole(me, 'hr', 'hr_head', 'cxo');
  const [scope, setScope] = useState<'team' | 'all'>(
    hasRole(me, 'manager') || !seesAll ? 'team' : 'all',
  );
  const [range, setRange] = useState<keyof typeof RANGES>('long');
  const [showExited, setShowExited] = useState(true);
  const [groupBy, setGroupBy] = useState<GroupBy>(scope === 'team' ? 'manager' : 'department');
  const [off, setOff] = useState<Set<TimelineCategory>>(() => new Set(timelineHiddenByDefault));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tip, setTip] = useState<{
    person: TeamJourneyPerson;
    event: TeamJourneyEvent;
    x: number;
    y: number;
  } | null>(null);
  const today = todayIso();
  const from = addDays(today, -RANGES[range].back);
  const to = addDays(today, RANGES[range].ahead);
  const data = useQuery({
    queryKey: ['team-journeys', scope, from, to, showExited],
    queryFn: () =>
      api<TeamJourneysView>(
        `/journeys/team?scope=${scope}&from=${from}&to=${to}&exited=${showExited}`,
      ),
  });
  const v = data.data;
  const span = daysBetween(from, to);
  const x = (date: string) =>
    Math.min(TRACK, Math.max(0, (daysBetween(from, date) / span) * TRACK));

  const groups = useMemo(() => {
    if (!v) return [];
    const keyOf = (p: TeamJourneyPerson): string =>
      groupBy === 'manager'
        ? p.manager
          ? `Reports to ${p.manager.name}`
          : 'No manager on record'
        : groupBy === 'department'
          ? (p.department ?? 'No department')
          : groupBy === 'band'
            ? (bandWords[p.band ?? ''] ?? 'No band')
            : groupBy === 'tenure'
              ? tenureBand(p.tenureYears)
              : 'Everyone';
    const map = new Map<string, TeamJourneyPerson[]>();
    for (const p of v.people) map.set(keyOf(p), [...(map.get(keyOf(p)) ?? []), p]);
    const entries = [...map.entries()].map(([key, people]) => ({
      key,
      people: [...people].sort((a, b) => a.joiningDate.localeCompare(b.joiningDate)),
    }));
    const order =
      groupBy === 'band'
        ? bandOrder.map((b) => bandWords[b]!)
        : groupBy === 'tenure'
          ? tenureOrder
          : null;
    return order
      ? entries.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
      : entries.sort((a, b) => b.people.length - a.people.length || a.key.localeCompare(b.key));
  }, [v, groupBy]);

  const ticks: { at: string; label: string }[] = [];
  if (range === 'long') {
    for (let y = Number(from.slice(0, 4)) + 1; `${y}-01-01` <= to; y++) {
      ticks.push({ at: `${y}-01-01`, label: String(y) });
    }
  } else {
    const d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
    for (
      d.setUTCMonth(d.getUTCMonth() + 1);
      d.toISOString().slice(0, 10) <= to;
      d.setUTCMonth(d.getUTCMonth() + 3)
    ) {
      const at = d.toISOString().slice(0, 10);
      ticks.push({ at, label: monthYear(at) });
    }
  }
  const t = v?.tiles;
  const in90 = addDays(today, 90);

  return (
    <main className="page page-wide">
      <div className="toolbar">
        <div>
          <h1>Team journeys</h1>
          <p className="muted">
            Milestones for everyone in view, side by side. Hover or focus a marker for details.
          </p>
        </div>
      </div>
      {data.error && <Note kind="error">{errorMessage(data.error)}</Note>}
      {t && (
        <ul className="journey-tiles" aria-label="Summary">
          <li>
            <span className="eyebrow">Active headcount</span>
            <strong>{t.headcount}</strong>
            <span className="muted">{t.exitedInView} exited in view</span>
          </li>
          <li>
            <span className="eyebrow">Probation due</span>
            <strong>{t.probationDue30}</strong>
            <span className="muted">in the next 30 days</span>
          </li>
          <li>
            <span className="eyebrow">On notice</span>
            <strong>{t.onNotice}</strong>
            <span className="muted">serving notice period</span>
          </li>
          <li>
            <span className="eyebrow">Designation changes</span>
            <strong>{t.designationChanges12m}</strong>
            <span className="muted">in the last 12 months</span>
          </li>
          <li>
            <span className="eyebrow">Joiners</span>
            <strong>{t.joiners12m}</strong>
            <span className="muted">in the last 12 months</span>
          </li>
        </ul>
      )}

      <div className="team-controls">
        {seesAll && (
          <Field label="Show">
            {(id) => (
              <select
                id={id}
                value={scope}
                onChange={(e) => {
                  const next = e.target.value as 'team' | 'all';
                  setScope(next);
                  setGroupBy(next === 'team' ? 'manager' : 'department');
                }}
              >
                <option value="team">My team</option>
                <option value="all">Everyone I can see</option>
              </select>
            )}
          </Field>
        )}
        <div className="segmented" role="radiogroup" aria-label="Group by">
          {(Object.keys(groupWords) as GroupBy[]).map((g) => (
            <label key={g} className={`segment${groupBy === g ? ' segment-on' : ''}`}>
              <input
                type="radio"
                name="group-by"
                checked={groupBy === g}
                onChange={() => setGroupBy(g)}
              />
              {groupWords[g]}
            </label>
          ))}
        </div>
        <div className="segmented" role="radiogroup" aria-label="Range">
          {(Object.keys(RANGES) as (keyof typeof RANGES)[]).map((r) => (
            <label key={r} className={`segment${range === r ? ' segment-on' : ''}`}>
              <input type="radio" name="range" checked={range === r} onChange={() => setRange(r)} />
              {RANGES[r].label}
            </label>
          ))}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={showExited}
            onChange={(e) => setShowExited(e.target.checked)}
          />
          Show exited
        </label>
      </div>
      <div className="journey-filters" role="group" aria-label="Show events">
        {timelineCategories.map((c) => (
          <button
            key={c}
            type="button"
            className={`cat-chip${off.has(c) ? ' cat-chip-off' : ''}`}
            style={catStyle(c)}
            aria-pressed={!off.has(c)}
            onClick={() => {
              const next = new Set(off);
              if (next.has(c)) next.delete(c);
              else next.add(c);
              setOff(next);
            }}
          >
            <span className="cat-swatch" aria-hidden="true" />
            {timelineCategoryWords[c]}
          </button>
        ))}
        <span className="muted legend">
          <span className="cat-swatch cat-swatch-hollow" aria-hidden="true" /> Hollow = upcoming
        </span>
      </div>

      {v && v.people.length === 0 && <Empty>No one in view.</Empty>}
      {v && v.people.length > 0 && (
        <div className="team-scroll" onMouseLeave={() => setTip(null)}>
          <div className="team-grid" style={{ width: 280 + TRACK + 48 }}>
            <div className="team-head">
              <div className="team-person-col">
                <strong>{v.people.length} people</strong>
              </div>
              <div className="team-track" style={{ width: TRACK }} aria-hidden="true">
                {ticks.map((tk) => (
                  <span key={tk.at} className="tick" style={{ left: x(tk.at) }}>
                    {tk.label}
                  </span>
                ))}
              </div>
            </div>
            <div className="team-body">
              <div className="team-today" style={{ left: 280 + 24 + x(today) }} aria-hidden="true">
                <span className="today-pill">Today</span>
              </div>
              {groups.map((g) => {
                const closed = collapsed.has(g.key);
                const soon = g.people.reduce(
                  (n, p) => n + p.events.filter((e) => e.date > today && e.date <= in90).length,
                  0,
                );
                return (
                  <section key={g.key} aria-label={g.key}>
                    <button
                      type="button"
                      className="team-group"
                      aria-expanded={!closed}
                      onClick={() => {
                        const next = new Set(collapsed);
                        if (closed) next.delete(g.key);
                        else next.add(g.key);
                        setCollapsed(next);
                      }}
                    >
                      <span aria-hidden="true">{closed ? '▸' : '▾'}</span>
                      <strong>{g.key}</strong>
                      <Chip tone="muted">{g.people.length}</Chip>
                      <span className="muted">{soon} milestones in next 90 days</span>
                    </button>
                    {!closed &&
                      g.people.map((p) => {
                        const exited = p.status === 'exited';
                        const start = p.joiningDate < from ? from : p.joiningDate;
                        const end = exited && p.lastWorkingDate ? p.lastWorkingDate : today;
                        return (
                          <div key={p.personId} className="team-row">
                            <div className="team-person-col">
                              <span
                                className={`avatar${exited ? ' avatar-exited' : ''}`}
                                aria-hidden="true"
                              >
                                {initials(p.name)}
                              </span>
                              <span className="team-person-text">
                                <Link to={`/people/${p.personId}`}>{p.name}</Link>{' '}
                                {exited && <Chip tone="muted">Exited</Chip>}
                                {p.status === 'on_notice' && <Chip tone="warn">On notice</Chip>}
                                {p.onProbation && !exited && <Chip tone="warn">Probation</Chip>}
                                <span className="muted">
                                  {[p.designation, tenureWords(p.joiningDate, end)]
                                    .filter(Boolean)
                                    .join(' · ')}
                                  {p.joiningDate < from
                                    ? ` · since ${monthYear(p.joiningDate)}`
                                    : ''}
                                </span>
                              </span>
                            </div>
                            <div className="team-track" style={{ width: TRACK }}>
                              <span
                                className={`tenure-bar${exited ? ' tenure-exited' : ''}`}
                                style={{ left: x(start), width: Math.max(4, x(end) - x(start)) }}
                                aria-hidden="true"
                              />
                              {!exited && (
                                <span
                                  className="tenure-future"
                                  style={{
                                    left: x(today),
                                    width: Math.max(0, x(p.lastWorkingDate ?? to) - x(today)),
                                  }}
                                  aria-hidden="true"
                                />
                              )}
                              {p.events
                                .filter((e) => !off.has(e.category))
                                .map((e) => (
                                  <button
                                    key={e.id}
                                    type="button"
                                    className={`team-dot${e.upcoming ? ' dot-upcoming' : ''}`}
                                    style={{ ...catStyle(e.category), left: x(e.date) }}
                                    aria-label={`${p.name}: ${e.title}, ${formatDate(e.date)}${e.upcoming ? `, upcoming ${countdown(today, e.date)}` : ''}`}
                                    onMouseEnter={(ev) => {
                                      const box = (
                                        ev.currentTarget.closest('.team-grid') as HTMLElement
                                      ).getBoundingClientRect();
                                      const r = ev.currentTarget.getBoundingClientRect();
                                      setTip({
                                        person: p,
                                        event: e,
                                        x: r.left - box.left,
                                        y: r.bottom - box.top,
                                      });
                                    }}
                                    onFocus={(ev) => {
                                      const box = (
                                        ev.currentTarget.closest('.team-grid') as HTMLElement
                                      ).getBoundingClientRect();
                                      const r = ev.currentTarget.getBoundingClientRect();
                                      setTip({
                                        person: p,
                                        event: e,
                                        x: r.left - box.left,
                                        y: r.bottom - box.top,
                                      });
                                    }}
                                    onBlur={() => setTip(null)}
                                  />
                                ))}
                            </div>
                          </div>
                        );
                      })}
                  </section>
                );
              })}
            </div>
            {tip && (
              <div
                className="team-tip"
                role="tooltip"
                style={{ left: Math.min(tip.x, 280 + TRACK - 240), top: tip.y + 6 }}
              >
                <strong>{tip.person.name}</strong>
                <span>{tip.person.designation ?? ''}</span>
                <span className="mono">{monthYear(tip.event.date)}</span>
                <span className="cat-label" style={catStyle(tip.event.category)}>
                  <span className="cat-swatch" aria-hidden="true" />
                  {timelineCategoryWords[tip.event.category]}
                </span>
                {tip.event.upcoming && (
                  <span className="tip-badge">Upcoming · {countdown(today, tip.event.date)}</span>
                )}
                <span>{tip.event.title}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
