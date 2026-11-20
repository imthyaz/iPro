import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type {
  AbsenteeismReport,
  AttritionReport,
  CountRow,
  HeadcountReport,
  HybridComplianceReport,
  LeaveLiabilityReport,
  MovementReport,
  SeatOccupancyReport,
} from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { Empty, Field, formatDate, Note, Tabs, todayIso } from '../../design-system/index.js';
import { formatPaise } from '../../money.js';

type Kind =
  'headcount' | 'movement' | 'attrition' | 'absenteeism' | 'liability' | 'hybrid' | 'seats';

const TABS: { id: Kind; label: string }[] = [
  { id: 'headcount', label: 'Headcount' },
  { id: 'movement', label: 'Joiners and leavers' },
  { id: 'attrition', label: 'Attrition' },
  { id: 'absenteeism', label: 'Absenteeism' },
  { id: 'liability', label: 'Leave liability' },
  { id: 'hybrid', label: 'Hybrid compliance' },
  { id: 'seats', label: 'Seat occupancy' },
];

const startOfYear = () => `${todayIso().slice(0, 4)}-01-01`;

/**
 * H12 Phase 1 reports (slice 13a; decision #93), for HR and CXO: aggregates over the companies the
 * viewer may read. Each report says how its figure is worked out (CLAUDE.md: every computed number
 * has a "why"), and lists the people behind joiner and leaver counts.
 */
export function Reports() {
  const [kind, setKind] = useState<Kind>('headcount');
  const [from, setFrom] = useState(startOfYear);
  const [to, setTo] = useState(todayIso);
  const ranged = kind !== 'headcount' && kind !== 'liability';
  return (
    <main className="page page-wide">
      <h1>Reports</h1>
      <Tabs label="Report" tabs={TABS} active={kind} onChange={setKind} />
      <div className="toolbar">
        {ranged ? (
          <>
            <Field label="From">
              {(id) => (
                <input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              )}
            </Field>
            <Field label="To">
              {(id) => (
                <input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              )}
            </Field>
          </>
        ) : kind === 'headcount' ? (
          <Field label="As of">
            {(id) => (
              <input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            )}
          </Field>
        ) : (
          <Field label="Year">
            {(id) => (
              <input
                id={id}
                type="number"
                min={2000}
                max={2100}
                value={to.slice(0, 4)}
                onChange={(e) => setTo(`${e.target.value}-12-31`)}
              />
            )}
          </Field>
        )}
      </div>
      {kind === 'headcount' && <Headcount asOf={to} />}
      {kind === 'movement' && <Movement from={from} to={to} />}
      {kind === 'attrition' && <Attrition from={from} to={to} />}
      {kind === 'absenteeism' && <Absenteeism from={from} to={to} />}
      {kind === 'liability' && <Liability year={Number(to.slice(0, 4))} />}
      {kind === 'hybrid' && <Hybrid from={from} to={to} />}
      {kind === 'seats' && <Seats from={from} to={to} />}
    </main>
  );
}

function useReport<T>(path: string, enabled = true) {
  return useQuery({
    queryKey: ['report', path],
    queryFn: () => api<T>(`/reports/${path}`),
    enabled,
  });
}

function Shell<T>({
  query,
  children,
}: {
  query: { data?: T; error: unknown; isPending: boolean };
  children: (data: T) => ReactNode;
}) {
  if (query.error) return <Note kind="error">{errorMessage(query.error)}</Note>;
  if (!query.data) return <p className="muted">Working it out…</p>;
  return <>{children(query.data)}</>;
}

function Tile({ label, value, why }: { label: string; value: string; why?: string }) {
  return (
    <div className="report-tile">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
      {why && <span className="muted report-why">{why}</span>}
    </div>
  );
}

function Counts({ title, rows }: { title: string; rows: CountRow[] }) {
  return (
    <section aria-label={title}>
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <Empty>None.</Empty>
      ) : (
        <table className="report-table">
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <th scope="row">{r.name}</th>
                <td>{r.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Headcount({ asOf }: { asOf: string }) {
  const q = useReport<HeadcountReport>(`headcount?asOf=${asOf}`);
  return (
    <Shell query={q}>
      {(r) => (
        <>
          <div className="report-tiles">
            <Tile
              label={`Headcount on ${formatDate(r.asOf)}`}
              value={String(r.total)}
              why="People who had joined and were not past their last working day."
            />
          </div>
          <div className="report-grid">
            <Counts title="By department" rows={r.byDepartment} />
            <Counts title="By location" rows={r.byLocation} />
            <Counts title="By type" rows={r.byType} />
          </div>
          <p>
            <Link to="/people">Open the people directory</Link>
          </p>
        </>
      )}
    </Shell>
  );
}

function People({ title, rows }: { title: string; rows: MovementReport['joinerList'] }) {
  return (
    <section aria-label={title}>
      <h2>
        {title} ({rows.length})
      </h2>
      {rows.length === 0 ? (
        <Empty>None.</Empty>
      ) : (
        <ul className="rows">
          {rows.map((p) => (
            <li key={`${p.personId}-${p.date}`} className="row">
              <span className="row-main">
                <Link to={`/people/${p.personId}`}>{p.name}</Link>
                <span className="muted">
                  {formatDate(p.date)} · {p.department ?? 'No department'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Movement({ from, to }: { from: string; to: string }) {
  const q = useReport<MovementReport>(`movement?from=${from}&to=${to}`, from <= to);
  return (
    <Shell query={q}>
      {(r) => (
        <>
          <div className="report-tiles">
            <Tile label="Joiners" value={String(r.joiners)} why="Joining date in the range." />
            <Tile
              label="Leavers"
              value={String(r.leavers)}
              why="Last working day in the range, exit completed."
            />
          </div>
          <table className="report-table" aria-label="By month">
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Joiners</th>
                <th scope="col">Leavers</th>
              </tr>
            </thead>
            <tbody>
              {r.months.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{m.month}</th>
                  <td>{m.joiners}</td>
                  <td>{m.leavers}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="report-grid">
            <People title="Joiners" rows={r.joinerList} />
            <People title="Leavers" rows={r.leaverList} />
          </div>
        </>
      )}
    </Shell>
  );
}

function Attrition({ from, to }: { from: string; to: string }) {
  const q = useReport<AttritionReport>(`attrition?from=${from}&to=${to}`, from <= to);
  return (
    <Shell query={q}>
      {(r) => (
        <>
          <div className="report-tiles">
            <Tile
              label="Attrition for the period"
              value={`${r.rate}%`}
              why={`${r.leavers} leavers ÷ ${r.averageHeadcount} average month-end headcount.`}
            />
            <Tile
              label="Annualised"
              value={`${r.annualised}%`}
              why={`× 12 ÷ ${r.monthEnds.length} month${r.monthEnds.length === 1 ? '' : 's'}.`}
            />
            <Tile label="Voluntary" value={String(r.voluntary)} why="Resignations." />
            <Tile
              label="Involuntary"
              value={String(r.involuntary)}
              why="Terminations and ends of term."
            />
            {r.unknown > 0 && <Tile label="Not recorded" value={String(r.unknown)} />}
          </div>
          <table className="report-table" aria-label="Month-end headcount">
            <tbody>
              {r.monthEnds.map((m) => (
                <tr key={m.date}>
                  <th scope="row">{formatDate(m.date)}</th>
                  <td>{m.headcount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Shell>
  );
}

function Absenteeism({ from, to }: { from: string; to: string }) {
  const q = useReport<AbsenteeismReport>(`absenteeism?from=${from}&to=${to}`, from <= to);
  return (
    <Shell query={q}>
      {(r) => (
        <>
          <div className="report-tiles">
            <Tile
              label="Absenteeism"
              value={`${r.rate}%`}
              why={`(${r.unplannedLeaveDays} unplanned leave + ${r.absentDays} absent days) ÷ ${r.workingDays} working days. Planned leave doesn't count; days not yet past aren't counted.`}
            />
          </div>
          <table className="report-table" aria-label="By department">
            <thead>
              <tr>
                <th scope="col">Department</th>
                <th scope="col">Working days</th>
                <th scope="col">Unplanned leave</th>
                <th scope="col">Absent</th>
                <th scope="col">Rate</th>
              </tr>
            </thead>
            <tbody>
              {r.byDepartment.map((d) => (
                <tr key={d.name}>
                  <th scope="row">{d.name}</th>
                  <td>{d.workingDays}</td>
                  <td>{d.unplannedLeaveDays}</td>
                  <td>{d.absentDays}</td>
                  <td>{d.rate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Shell>
  );
}

function Liability({ year }: { year: number }) {
  const q = useReport<LeaveLiabilityReport>(`leave-liability?year=${year}`, year >= 2000);
  return (
    <Shell query={q}>
      {(r) => (
        <>
          <div className="report-tiles">
            {r.byType.map((t) => (
              <Tile key={t.code} label={`${t.name} held`} value={`${t.days} days`} />
            ))}
            {r.value && (
              <Tile
                label="Encashable leave, estimated"
                value={formatPaise(r.value.paise)}
                why={`Days × annual CTC ÷ 365, for ${r.value.people} people. Each pay read is logged.`}
              />
            )}
          </div>
          <table className="report-table" aria-label="By department">
            <thead>
              <tr>
                <th scope="col">Department</th>
                {r.byType.map((t) => (
                  <th key={t.code} scope="col">
                    {t.code}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.byDepartment.map((d) => (
                <tr key={d.name}>
                  <th scope="row">{d.name}</th>
                  {r.byType.map((t) => (
                    <td key={t.code}>{d.days[t.code] ?? 0}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Shell>
  );
}

function Hybrid({ from, to }: { from: string; to: string }) {
  const q = useReport<HybridComplianceReport>(
    `hybrid-compliance?from=${from}&to=${to}`,
    from <= to,
  );
  return (
    <Shell query={q}>
      {(r) => (
        <>
          <div className="report-tiles">
            <Tile
              label="Weeks meeting the policy"
              value={`${r.rate}%`}
              why="Person-weeks that met the office days required (approved exceptions count as met)."
            />
          </div>
          <table className="report-table" aria-label="By week">
            <thead>
              <tr>
                <th scope="col">Week of</th>
                <th scope="col">People</th>
                <th scope="col">Met</th>
                <th scope="col">Approved below</th>
                <th scope="col">Rate</th>
              </tr>
            </thead>
            <tbody>
              {r.weeks.map((w) => (
                <tr key={w.weekStart}>
                  <th scope="row">{formatDate(w.weekStart)}</th>
                  <td>{w.people}</td>
                  <td>{w.met}</td>
                  <td>{w.approvedBelow}</td>
                  <td>{w.rate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <Link to="/hybrid-compliance">Open the compliance list</Link>
          </p>
        </>
      )}
    </Shell>
  );
}

function Seats({ from, to }: { from: string; to: string }) {
  const q = useReport<SeatOccupancyReport>(`seat-occupancy?from=${from}&to=${to}`, from <= to);
  return (
    <Shell query={q}>
      {(r) =>
        r.byLocation.length === 0 ? (
          <Empty>No seats are set up.</Empty>
        ) : (
          <table className="report-table" aria-label="By location">
            <thead>
              <tr>
                <th scope="col">Location</th>
                <th scope="col">Seats</th>
                <th scope="col">Working days</th>
                <th scope="col">Seat-days booked</th>
                <th scope="col">Average</th>
                <th scope="col">Busiest day</th>
              </tr>
            </thead>
            <tbody>
              {r.byLocation.map((l) => (
                <tr key={l.location}>
                  <th scope="row">{l.location}</th>
                  <td>{l.seats}</td>
                  <td>{l.workingDays}</td>
                  <td>{l.bookedSeatDays}</td>
                  <td title="Seat-days booked ÷ (seats × working days)">{l.average}%</td>
                  <td>{l.peakDate ? `${l.peak}% on ${formatDate(l.peakDate)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    </Shell>
  );
}
