import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  LeaveBalanceRow,
  LeaveBalanceView,
  PayrollExportRow,
  PayrollExportView,
} from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import {
  Chip,
  Empty,
  Field,
  formatDate,
  ListDetail,
  Note,
  todayIso,
} from '../../design-system/index.js';
import { BalanceDetail } from './Leave.js';

const plural = (n: number) => `${n} ${Math.abs(n) === 1 ? 'day' : 'days'}`;
const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;
const lastMonth = () => {
  const d = new Date(`${todayIso().slice(0, 7)}-01T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 7);
};
const monthLabel = (month: string) =>
  new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00Z`),
  );

/**
 * H9 Payroll export (decision #77): a month once it is over, each person's payable days and loss
 * of pay with why, undecided requests first, and the CSV for the current payroll. A change to last
 * month since it was exported comes through as an adjustment.
 */
export function PayrollExport() {
  const client = useQueryClient();
  const [month, setMonth] = useState(lastMonth());
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const data = useQuery({
    queryKey: ['payroll-export', month],
    queryFn: () => api<PayrollExportView>(`/payroll-export?month=${month}`),
  });
  const v = data.data;
  const needle = q.trim().toLowerCase();
  const rows = (v?.rows ?? []).filter(
    (r) =>
      !needle ||
      r.name.toLowerCase().includes(needle) ||
      r.employeeCode.toLowerCase().includes(needle),
  );
  // Exceptions first: loss of pay, undecided requests or an adjustment, then everyone else.
  const flagged = (r: PayrollExportRow) => r.lop > 0 || r.pending > 0 || r.adjustment !== null;
  const ordered = [...rows.filter(flagged), ...rows.filter((r) => !flagged(r))];
  const chosen = v?.rows.find((r) => r.engagementId === selected) ?? null;

  const list = (
    <>
      <div className="toolbar">
        <h1>Payroll export</h1>
        {v && (
          <a
            className="button button-primary"
            href={`/api/payroll-export/csv?month=${month}`}
            download
            onClick={() => {
              // The download is recorded; show it in the list once it has gone through.
              setTimeout(
                () => void client.invalidateQueries({ queryKey: ['payroll-export', month] }),
                1500,
              );
            }}
          >
            Download CSV
          </a>
        )}
      </div>
      <div className="filters">
        <Field label="Month">
          {(id) => (
            <input
              id={id}
              type="month"
              max={lastMonth()}
              value={month}
              onChange={(e) => {
                if (e.target.value) setMonth(e.target.value);
                setSelected(null);
              }}
            />
          )}
        </Field>
        <Field label="Search">
          {(id) => (
            <input
              id={id}
              type="search"
              placeholder="Name or code"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          )}
        </Field>
      </div>
      {data.error && <Note kind="error">{errorMessage(data.error)}</Note>}
      {v && (
        <p className="muted" aria-label="Month totals">
          {monthLabel(v.month)}: {v.totals.people} people · {plural(v.totals.lop)} loss of pay ·{' '}
          {v.totals.adjustments
            ? `${v.totals.adjustments} adjustments from ${monthLabel(v.previousMonth)}`
            : v.previousExportedAt
              ? `no changes to ${monthLabel(v.previousMonth)} since it was exported`
              : `${monthLabel(v.previousMonth)} wasn’t exported, so no adjustments`}
          {v.exports[0] ? ` · last downloaded ${formatDate(v.exports[0].at)}` : ''}
        </p>
      )}
      {v && v.pending.length > 0 && (
        <div className="note note-info" role="status" aria-label="Undecided requests">
          <strong>
            {v.pending.length} {v.pending.length === 1 ? 'request is' : 'requests are'} not yet
            decided.
          </strong>{' '}
          These days count as they stand now; decide them first or they come through as adjustments
          next month.
          <ul>
            {v.pending.map((p, i) => (
              <li key={`${p.engagementId}:${p.date}:${i}`}>
                {p.name} ({p.employeeCode}), {formatDate(p.date)}: {p.what}
              </li>
            ))}
          </ul>
        </div>
      )}
      {v && ordered.length === 0 && <Empty>No one to show for {monthLabel(month)}.</Empty>}
      <ul className="rows" aria-label="Payroll rows">
        {ordered.map((r) => (
          <li key={r.engagementId}>
            <button
              className={`row row-button${r.engagementId === selected ? ' row-selected' : ''}`}
              onClick={() => setSelected(r.engagementId)}
            >
              <span className="row-main">
                <strong>
                  {r.name} · {r.employeeCode}
                </strong>
                <span className="muted">
                  {r.payableDays} of {r.calendarDays} days payable
                  {r.joinedOn ? ` · joined ${formatDate(r.joinedOn)}` : ''}
                  {r.leftOn ? ` · left ${formatDate(r.leftOn)}` : ''}
                </span>
              </span>
              <span className="row-chips">
                {r.lop > 0 && <Chip tone="warn">{plural(r.lop)} LOP</Chip>}
                {r.pending > 0 && <Chip tone="info">{r.pending} undecided</Chip>}
                {r.adjustment && <Chip tone="info">Adjust {signed(r.adjustment.days)}</Chip>}
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
        detail={chosen ? <PayrollDetail row={chosen} /> : null}
        onClose={() => setSelected(null)}
        detailLabel="Payroll row"
      />
    </main>
  );
}

/** The "why": how the payable days are reached and each day of loss of pay. */
function PayrollDetail({ row: r }: { row: PayrollExportRow }) {
  const worked = [
    r.present ? `${r.present} in office` : null,
    r.wfh ? `${r.wfh} WFH` : null,
    r.clientSite ? `${r.clientSite} at a client site` : null,
    r.paidLeave ? `${r.paidLeave} paid leave` : null,
    r.weeklyOffs ? `${r.weeklyOffs} weekly off` : null,
    r.holidays ? `${r.holidays} holiday` : null,
  ].filter(Boolean);
  return (
    <article className="record">
      <header className="record-header">
        <h2>{r.name}</h2>
        <p className="muted">
          {r.employeeCode}
          {r.department ? ` · ${r.department}` : ''}
        </p>
      </header>
      <p aria-label="How the payable days are reached">
        {r.employedDays} days employed − {r.lop} loss of pay = <strong>{r.payableDays}</strong>{' '}
        payable
        {r.employedDays < r.calendarDays ? ` (of ${r.calendarDays} in the month)` : ''}
      </p>
      <p className="muted">Paid days: {worked.join(' · ') || 'none'}</p>
      <h3>Loss of pay</h3>
      {r.lopDays.length === 0 ? (
        <Empty>No loss of pay this month.</Empty>
      ) : (
        <ul className="rows" aria-label="Loss-of-pay days">
          {r.lopDays.map((d) => (
            <li key={d.date} className="row">
              <span className="row-main">
                <strong>{formatDate(d.date)}</strong>
                <span className="muted">{d.why}</span>
              </span>
              <Chip tone="warn">{plural(d.days)}</Chip>
            </li>
          ))}
        </ul>
      )}
      {r.pending > 0 && (
        <Note kind="info">
          {r.pending} {r.pending === 1 ? 'request' : 'requests'} in this month not yet decided.
        </Note>
      )}
      {r.adjustment && (
        <Note kind="info">
          Adjustment {signed(r.adjustment.days)}: {r.adjustment.note}
        </Note>
      )}
    </article>
  );
}

/** H9 Leave balances: everyone HR may change, each type's balance; open one to see why and adjust. */
export function AllLeaveBalances() {
  const thisYear = Number(todayIso().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const rows = useQuery({
    queryKey: ['leave-balances', 'all', year],
    queryFn: () => api<LeaveBalanceRow[]>(`/leave/balances?year=${year}`),
  });
  const needle = q.trim().toLowerCase();
  const shown = (rows.data ?? []).filter(
    (r) =>
      !needle ||
      r.name.toLowerCase().includes(needle) ||
      r.employeeCode.toLowerCase().includes(needle),
  );
  const chosen = rows.data?.find((r) => r.personId === selected) ?? null;

  const list = (
    <>
      <div className="toolbar">
        <h1>Leave balances</h1>
      </div>
      <div className="filters">
        <Field label="Year">
          {(id) => (
            <select id={id} value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Search">
          {(id) => (
            <input
              id={id}
              type="search"
              placeholder="Name or code"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          )}
        </Field>
      </div>
      {rows.error && <Note kind="error">{errorMessage(rows.error)}</Note>}
      {rows.data && shown.length === 0 && <Empty>No one to show.</Empty>}
      <ul className="rows" aria-label="People's leave balances">
        {shown.map((r) => (
          <li key={r.personId}>
            <button
              className={`row row-button${r.personId === selected ? ' row-selected' : ''}`}
              onClick={() => setSelected(r.personId)}
            >
              <span className="row-main">
                <strong>
                  {r.name} · {r.employeeCode}
                </strong>
                <span className="muted">{r.department ?? '—'}</span>
              </span>
              <span className="row-chips">
                {r.balances.map((b) => (
                  <Chip key={b.leaveTypeId} tone={b.balance < 0 ? 'warn' : 'muted'}>
                    {b.code} {b.balance}
                  </Chip>
                ))}
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
        detail={chosen ? <PersonBalances row={chosen} year={year} /> : null}
        onClose={() => setSelected(null)}
        detailLabel="Leave balance"
      />
    </main>
  );
}

function PersonBalances({ row, year }: { row: LeaveBalanceRow; year: number }) {
  const [type, setType] = useState<string | null>(null);
  const balances = useQuery({
    queryKey: ['leave-balances', row.personId, year],
    queryFn: () => api<LeaveBalanceView[]>(`/people/${row.personId}/leave?year=${year}`),
  });
  const withBalance = (balances.data ?? []).filter(
    (b) => b.leaveType.kind === 'accrued' || b.leaveType.kind === 'granted',
  );
  const chosen = withBalance.find((b) => b.leaveType.id === type) ?? withBalance[0] ?? null;
  return (
    <>
      <p>
        <strong>{row.name}</strong> <span className="muted">· {row.employeeCode}</span>
      </p>
      {balances.error && <Note kind="error">{errorMessage(balances.error)}</Note>}
      <div className="form-actions" role="group" aria-label="Leave type">
        {withBalance.map((b) => (
          <button
            key={b.leaveType.id}
            className={`button${b.leaveType.id === chosen?.leaveType.id ? ' button-primary' : ''}`}
            aria-pressed={b.leaveType.id === chosen?.leaveType.id}
            onClick={() => setType(b.leaveType.id)}
          >
            {b.leaveType.name} {b.balance}
          </button>
        ))}
      </div>
      {chosen && <BalanceDetail balance={chosen} personId={row.personId} canAdjust />}
    </>
  );
}
