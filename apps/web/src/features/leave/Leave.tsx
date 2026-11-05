import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { LeaveBalanceView, LedgerKind } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { useSearchParams } from 'react-router';
import { useMe } from '../../auth.js';
import { AskCompOff, CompOffList } from './CompOff.js';
import { ApplyLeave, LeaveRequestList } from './LeaveRequests.js';
import {
  Chip,
  Empty,
  Field,
  formatDate,
  ListDetail,
  Note,
  todayIso,
} from '../../design-system/index.js';

const kindWords: Record<LedgerKind, string> = {
  opening: 'Opening balance',
  accrual: 'Accrued',
  carry_forward: 'Carried forward',
  lapse: 'Lapsed',
  grant: 'Granted',
  expiry: 'Expired',
  taken: 'Taken',
  restored: 'Restored',
  encashed: 'Encashed',
  adjustment: 'Adjusted by HR',
};
const signed = (days: number) => `${days > 0 ? '+' : ''}${days}`;
const plural = (days: number) => `${days} ${Math.abs(days) === 1 ? 'day' : 'days'}`;

/** Balances that mean something to show: per-request and unpaid types have none. */
const hasBalance = (b: LeaveBalanceView) =>
  b.leaveType.kind === 'accrued' || b.leaveType.kind === 'granted';

/** E5 balances; also the Leave tab of a person record, where HR adjusts with a reason. */
export function LeaveBalances({
  personId,
  canAdjust = false,
}: {
  personId: string;
  canAdjust?: boolean;
}) {
  const thisYear = Number(todayIso().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [selected, setSelected] = useState<string | null>(null);
  const balances = useQuery({
    queryKey: ['leave-balances', personId, year],
    queryFn: () => api<LeaveBalanceView[]>(`/people/${personId}/leave?year=${year}`),
  });
  const shown = (balances.data ?? []).filter(hasBalance);
  const others = (balances.data ?? []).filter((b) => !hasBalance(b));
  const chosen = shown.find((b) => b.leaveType.id === selected) ?? null;

  const list = (
    <>
      <div className="filters">
        <Field label="Year">
          {(id) => (
            <select
              id={id}
              value={year}
              onChange={(e) => {
                setYear(Number(e.target.value));
                setSelected(null);
              }}
            >
              {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {balances.error && <Note kind="error">{errorMessage(balances.error)}</Note>}
      {balances.data && shown.length === 0 && <Empty>No leave balances for {year}.</Empty>}
      <ul className="balance-cards" aria-label="Leave balances">
        {shown.map((b) => (
          <li key={b.leaveType.id}>
            <button
              className={`balance-card${b.leaveType.id === selected ? ' balance-card-selected' : ''}`}
              onClick={() => setSelected(b.leaveType.id)}
              aria-label={`${b.leaveType.name}: ${plural(b.balance)} left`}
            >
              <span className="balance-name">{b.leaveType.name}</span>
              <span className="balance-days">{b.balance}</span>
              <span className="muted">
                {b.accrued || b.granted ? `+${b.accrued + b.granted} this year` : 'days left'}
                {b.taken ? ` · ${b.taken} taken` : ''}
              </span>
              {b.expiring[0] && (
                <span className="muted">
                  {b.expiring[0].days} usable until {formatDate(b.expiring[0].on)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <p className="muted">
          Also available when needed: {others.map((b) => b.leaveType.name).join(', ')}.
        </p>
      )}
    </>
  );

  return (
    <ListDetail
      list={list}
      detail={
        chosen ? <BalanceDetail balance={chosen} personId={personId} canAdjust={canAdjust} /> : null
      }
      onClose={() => setSelected(null)}
      detailLabel="Leave balance"
    />
  );
}

/** The "why": each entry that made the balance, in order. */
function BalanceDetail(props: { balance: LeaveBalanceView; personId: string; canAdjust: boolean }) {
  const b = props.balance;
  return (
    <article className="record">
      <header className="record-header">
        <h2>{b.leaveType.name}</h2>
        <p className="muted">
          {b.year}: {plural(b.balance)} left
        </p>
      </header>
      <p className="muted" aria-label="How the balance is reached">
        {[
          b.opening ? `${b.opening} opening` : null,
          b.accrued ? `+ ${b.accrued} accrued` : null,
          b.granted ? `+ ${b.granted} granted` : null,
          b.adjusted ? `${b.adjusted > 0 ? '+' : '−'} ${Math.abs(b.adjusted)} adjusted` : null,
          b.taken ? `− ${b.taken} taken` : null,
          b.lapsed ? `− ${b.lapsed} lapsed` : null,
          b.encashed ? `− ${b.encashed} encashed` : null,
        ]
          .filter(Boolean)
          .join(' ') || 'Nothing yet'}{' '}
        = {b.balance}
      </p>
      {b.expiring.length > 0 && (
        <Note kind="info">
          Runs out if not used:{' '}
          {b.expiring.map((x) => `${plural(x.days)} after ${formatDate(x.on)}`).join(', ')}. Leave
          uses what runs out first.
        </Note>
      )}
      {b.entries.length === 0 ? (
        <Empty>No entries in {b.year}.</Empty>
      ) : (
        <ul className="rows" aria-label="Balance entries">
          {b.entries.map((e) => (
            <li key={e.id} className="row">
              <span className="row-main">
                <strong>{kindWords[e.kind]}</strong>
                <span className="muted">
                  {formatDate(e.date)}
                  {e.note ? ` · ${e.note}` : ''}
                </span>
              </span>
              <Chip tone={e.days > 0 ? 'ok' : 'muted'}>{signed(e.days)}</Chip>
            </li>
          ))}
        </ul>
      )}
      {props.canAdjust && <Adjust personId={props.personId} balance={b} />}
    </article>
  );
}

function Adjust({ personId, balance }: { personId: string; balance: LeaveBalanceView }) {
  const client = useQueryClient();
  const [form, setForm] = useState({ days: '', reason: '' });
  const adjust = useMutation({
    mutationFn: () =>
      api<LeaveBalanceView>(`/people/${personId}/leave/adjustments`, {
        body: { leaveTypeId: balance.leaveType.id, days: Number(form.days), reason: form.reason },
      }),
    onSuccess: () => {
      setForm({ days: '', reason: '' });
      return client.invalidateQueries({ queryKey: ['leave-balances', personId] });
    },
  });
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        adjust.mutate();
      }}
    >
      <h3>Adjust this balance</h3>
      <Field label="Days" hint="e.g. 1.5 to add, -1 to take away">
        {(id) => (
          <input
            id={id}
            required
            inputMode="decimal"
            pattern="-?\d+(\.5)?"
            value={form.days}
            onChange={(e) => setForm({ ...form, days: e.target.value })}
          />
        )}
      </Field>
      <Field label="Reason" hint="Required; shown on the balance">
        {(id) => (
          <input
            id={id}
            required
            minLength={3}
            maxLength={500}
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
          />
        )}
      </Field>
      <button className="button button-primary" disabled={adjust.isPending}>
        Adjust
      </button>
      {adjust.error && <Note kind="error">{errorMessage(adjust.error)}</Note>}
    </form>
  );
}

/** E5 My leave, with E4 Apply leave on top (opened straight from home with ?apply). */
export function MyLeave() {
  const me = useMe().data;
  const [params, setParams] = useSearchParams();
  const applying = params.has('apply');
  const askingCompOff = params.has('comp-off');
  if (!me?.personId) return <Note kind="info">Leave is for people with a record in iPro.</Note>;
  return (
    <main className="page">
      <div className="toolbar">
        <h1>My leave</h1>
        <div className="form-actions">
          {!askingCompOff && (
            <button className="button" onClick={() => setParams({ 'comp-off': '' })}>
              Ask for comp-off
            </button>
          )}
          {!applying && (
            <button className="button button-primary" onClick={() => setParams({ apply: '' })}>
              Apply leave
            </button>
          )}
        </div>
      </div>
      {applying && <ApplyLeave onDone={() => setParams({})} />}
      {askingCompOff && <AskCompOff onDone={() => setParams({})} />}
      <LeaveBalances personId={me.personId} />
      <LeaveRequestList />
      <CompOffList />
    </main>
  );
}
