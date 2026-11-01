import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { OfferStatus, OfferView } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { hasRole, useMe } from '../../auth.js';
import {
  Chip,
  Empty,
  Field,
  formatDate,
  ListDetail,
  Note,
  OfferStatusChip,
  Tabs,
  todayIso,
} from '../../design-system/index.js';

type View = 'open' | 'joining' | 'joined' | 'closed';

const views: { id: View; label: string; statuses: OfferStatus[] }[] = [
  { id: 'open', label: 'In progress', statuses: ['draft', 'pending_approval', 'offered'] },
  { id: 'joining', label: 'Joining', statuses: ['accepted'] },
  { id: 'joined', label: 'Joined', statuses: ['joined'] },
  { id: 'closed', label: 'Drop-outs', statuses: ['declined', 'withdrawn', 'no_show'] },
];

const bandWords: Record<OfferView['bandCheck'], string> = {
  within: 'Within the grade band',
  above: 'Above the grade band (HR head approves)',
  no_band: 'No band check',
  not_comparable: 'Day or hour rate (HR head approves)',
};

const guestWords = {
  invited: ['Sign-in invitation sent', 'ok'],
  failed: ['Sign-in invitation failed', 'warn'],
  retired: ['Pre-joining sign-in ended', 'muted'],
} as const;

const thisMonth = (iso: string) => iso.slice(0, 7) === todayIso().slice(0, 7);

/** Offers pipeline (H4): offers by stage, exceptions first, with the offer in the side panel. */
export function Offers() {
  const { offerId } = useParams();
  const navigate = useNavigate();
  const me = useMe().data;
  const [view, setView] = useState<View>('open');
  const offers = useQuery({ queryKey: ['offers'], queryFn: () => api<OfferView[]>('/offers') });
  const all = offers.data ?? [];
  const shown = all
    .filter((o) => views.find((v) => v.id === view)!.statuses.includes(o.status))
    .sort((a, b) => a.joiningDate.localeCompare(b.joiningDate));
  const joiningThisMonth = all.filter(
    (o) => o.status === 'accepted' && thisMonth(o.joiningDate),
  ).length;
  const inviteProblems = all.filter((o) => o.status === 'accepted' && o.guest?.status === 'failed');

  const list = (
    <>
      <div className="toolbar">
        <h1>Offers</h1>
        {hasRole(me, 'hr', 'hr_head') && (
          <Link className="button button-primary" to="/offers/new">
            New offer
          </Link>
        )}
      </div>
      <p className="summary-chips">
        <Chip tone="info">
          {all.filter((o) => o.status === 'offered').length} out for signature
        </Chip>{' '}
        <Chip tone="ok">{joiningThisMonth} joining this month</Chip>{' '}
        {inviteProblems.length > 0 && (
          <Chip tone="warn">{inviteProblems.length} sign-in invitation failed</Chip>
        )}
      </p>
      <Tabs
        label="Offer stages"
        active={view}
        onChange={setView}
        tabs={views.map((v) => ({
          id: v.id,
          label: `${v.label} (${all.filter((o) => v.statuses.includes(o.status)).length})`,
        }))}
      />
      <section className="tab-panel" role="tabpanel" aria-labelledby={`tab-${view}`}>
        {offers.error && <Note kind="error">{errorMessage(offers.error)}</Note>}
        {offers.data && shown.length === 0 && <Empty>No offers here.</Empty>}
        <ul className="rows" aria-label="Offers">
          {shown.map((o) => (
            <li key={o.id}>
              <Link
                to={`/offers/${o.id}`}
                className={o.id === offerId ? 'row row-selected' : 'row'}
                aria-current={o.id === offerId ? 'true' : undefined}
              >
                <span className="row-main">
                  <strong>{o.person.name}</strong>
                  <span className="muted">
                    {o.designation ?? '—'} · joining {formatDate(o.joiningDate)}
                  </span>
                </span>
                <span className="row-side">
                  {o.needsHrHead && o.status === 'pending_approval' && (
                    <Chip tone="warn">Above band</Chip>
                  )}
                  {o.guest?.status === 'failed' && <Chip tone="warn">Invite failed</Chip>}
                  <OfferStatusChip status={o.status} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );

  return (
    <ListDetail
      list={list}
      detail={
        offerId ? <OfferDetail offerId={offerId} canAct={hasRole(me, 'hr', 'hr_head')} /> : null
      }
      onClose={() => navigate('/offers')}
      detailLabel="Offer"
    />
  );
}

function OfferDetail({ offerId, canAct }: { offerId: string; canAct: boolean }) {
  const client = useQueryClient();
  const offer = useQuery({
    queryKey: ['offer', offerId],
    queryFn: () => api<OfferView>(`/offers/${offerId}`),
  });
  const done = (view: OfferView) => {
    client.setQueryData(['offer', offerId], view);
    return client.invalidateQueries({ queryKey: ['offers'] });
  };
  const act = useMutation({
    mutationFn: (input: { path: string; body?: object }) =>
      api<OfferView>(
        `/offers/${offerId}/${input.path}`,
        input.body ? { body: input.body } : { method: 'POST' },
      ),
    onSuccess: done,
  });

  if (offer.error) return <Note kind="error">{errorMessage(offer.error)}</Note>;
  if (!offer.data) return <p className="muted">Loading…</p>;
  const o = offer.data;
  const open = ['draft', 'pending_approval', 'offered', 'accepted'].includes(o.status);
  const dateReached = o.joiningDate <= todayIso();
  const facts: [string, ReactNode][] = [
    ['Employee code', o.employeeCode],
    ['Role', `${o.designation ?? '—'}${o.department ? `, ${o.department}` : ''}`],
    ['Hiring manager', o.hiringManager ?? '—'],
    ['Engagement', o.engagementType.replace('_', '-')],
    ['Joining', formatDate(o.joiningDate)],
    ...(o.endDate ? ([['Ends', formatDate(o.endDate)]] as [string, ReactNode][]) : []),
    ['Pay', o.paid ? bandWords[o.bandCheck] : 'Unpaid internship'],
    ...(o.expiresOn && o.status === 'offered'
      ? ([['Signature by', formatDate(o.expiresOn)]] as [string, ReactNode][])
      : []),
    ...(o.closeReason ? ([['Reason', o.closeReason]] as [string, ReactNode][]) : []),
  ];

  return (
    <article className="record">
      <header className="record-header">
        <h2>
          <Link to={`/people/${o.person.personId}`}>{o.person.name}</Link>
        </h2>
        <p>
          <OfferStatusChip status={o.status} />{' '}
          {o.guest && (
            <Chip tone={guestWords[o.guest.status][1]}>{guestWords[o.guest.status][0]}</Chip>
          )}
        </p>
      </header>
      <dl className="facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {o.approvalRequestId && o.status === 'pending_approval' && (
        <p>
          <Link to={`/requests/${o.approvalRequestId}`}>See the approval request</Link>
        </p>
      )}

      {canAct && open && (
        <section className="offer-actions" aria-label="Offer actions">
          {o.status === 'draft' && (
            <button
              className="button button-primary"
              disabled={act.isPending}
              onClick={() => act.mutate({ path: 'submit' })}
            >
              Send for approval
            </button>
          )}
          {o.status === 'accepted' && (
            <JoinForm
              disabled={!dateReached}
              hint={dateReached ? undefined : `Available from ${formatDate(o.joiningDate)}`}
              onJoin={(workEmail) => act.mutate({ path: 'join', body: { workEmail } })}
            />
          )}
          {(o.status === 'draft' || o.status === 'accepted') && (
            <ChangeDate
              current={o.joiningDate}
              onChange={(joiningDate, reason) =>
                act.mutate({ path: 'joining-date', body: { joiningDate, reason } })
              }
            />
          )}
          {o.status === 'accepted' && o.guest?.status !== 'retired' && (
            <button
              className="button"
              disabled={act.isPending}
              onClick={() => act.mutate({ path: 'invite' })}
            >
              Send sign-in invitation again
            </button>
          )}
          {o.status === 'offered' && (
            <ReasonAction
              label="Record a decline"
              confirmLabel="Record decline"
              onSubmit={(reason) => act.mutate({ path: 'decline', body: { reason } })}
            />
          )}
          {o.status === 'accepted' && (
            <ReasonAction
              label="Did not join…"
              confirmLabel="Mark as no-show"
              onSubmit={(reason) => act.mutate({ path: 'no-show', body: { reason } })}
            />
          )}
          <ReasonAction
            label="Withdraw offer…"
            confirmLabel="Withdraw offer"
            onSubmit={(reason) => act.mutate({ path: 'withdraw', body: { reason } })}
          />
          {act.error && <Note kind="error">{errorMessage(act.error)}</Note>}
        </section>
      )}
    </article>
  );
}

/** An irreversible step that needs a reason: confirmed first (CLAUDE.md UI rules). */
function ReasonAction(props: {
  label: string;
  confirmLabel: string;
  onSubmit: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <button className="button button-quiet" onClick={() => setOpen(true)}>
        {props.label}
      </button>
    );
  }
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (window.confirm(`${props.confirmLabel}? This can’t be undone.`)) props.onSubmit(reason);
      }}
    >
      <Field label="Reason">
        {(id) => (
          <input id={id} required value={reason} onChange={(e) => setReason(e.target.value)} />
        )}
      </Field>
      <div className="form-actions">
        <button className="button" disabled={!reason.trim()}>
          {props.confirmLabel}
        </button>
        <button type="button" className="button button-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ChangeDate(props: { current: string; onChange: (date: string, reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(props.current);
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <button className="button" onClick={() => setOpen(true)}>
        Change joining date
      </button>
    );
  }
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        props.onChange(date, reason);
        setOpen(false);
      }}
    >
      <Field label="New joining date" hint="Onboarding due dates move with it">
        {(id) => (
          <input
            id={id}
            type="date"
            required
            min={todayIso()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        )}
      </Field>
      <Field label="Why">
        {(id) => (
          <input id={id} required value={reason} onChange={(e) => setReason(e.target.value)} />
        )}
      </Field>
      <div className="form-actions">
        <button className="button button-primary" disabled={date === props.current}>
          Move joining date
        </button>
        <button type="button" className="button button-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function JoinForm(props: {
  disabled: boolean;
  hint?: string;
  onJoin: (workEmail: string) => void;
}) {
  const [workEmail, setWorkEmail] = useState('');
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        props.onJoin(workEmail);
      }}
    >
      <Field
        label="Work email"
        hint={props.hint ?? 'Their Microsoft sign-in from Day 1. Day-1 tasks must be done first.'}
      >
        {(id) => (
          <input
            id={id}
            type="email"
            required
            disabled={props.disabled}
            value={workEmail}
            onChange={(e) => setWorkEmail(e.target.value)}
          />
        )}
      </Field>
      <button className="button button-primary" disabled={props.disabled || !workEmail}>
        Mark joined
      </button>
    </form>
  );
}
