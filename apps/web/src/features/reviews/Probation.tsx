import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { ProbationDashboard, ReviewView } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { Chip, Empty, formatDate, Note } from '../../design-system/index.js';

/** Probation dashboard (H7): exceptions first, every entry opening the review or person behind it. */
export function Probation() {
  const board = useQuery({
    queryKey: ['probation-dashboard'],
    queryFn: () => api<ProbationDashboard>('/probation/dashboard'),
  });
  if (board.error) return <Note kind="error">{errorMessage(board.error)}</Note>;
  const b = board.data;
  return (
    <main className="page">
      <h1>Probation</h1>
      {b && (
        <p className="summary-chips">
          <Chip tone={b.overdue.length ? 'warn' : 'muted'}>{b.overdue.length} overdue</Chip>{' '}
          <Chip tone="info">{b.awaitingDecision.length} waiting for a decision</Chip>{' '}
          <Chip tone="muted">{b.dueSoon.length} ending within 30 days</Chip>{' '}
          <Chip tone="muted">{b.extended.length} extended</Chip>
        </p>
      )}
      <ReviewSection title="Overdue reviews" reviews={b?.overdue} empty="No overdue reviews." />
      <ReviewSection
        title="Waiting for a decision"
        reviews={b?.awaitingDecision}
        empty="Nothing waiting."
      />
      <section aria-labelledby="ending">
        <h2 id="ending">Ending within 30 days</h2>
        {b?.dueSoon.length === 0 && <Empty>None.</Empty>}
        <ul className="rows" aria-label="Ending within 30 days">
          {b?.dueSoon.map((d) => (
            <li key={d.personId} className="row">
              <span className="row-main">
                <Link to={d.reviewId ? `/reviews/${d.reviewId}` : `/people/${d.personId}`}>
                  {d.name}
                </Link>
                <span className="muted">ends {formatDate(d.probationEndDate)}</span>
              </span>
              {d.reviewId ? (
                <Chip tone="info">Review open</Chip>
              ) : (
                <Chip tone="muted">Not opened</Chip>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="extended">
        <h2 id="extended">Extended</h2>
        {b?.extended.length === 0 && <Empty>None.</Empty>}
        <ul className="rows" aria-label="Extended">
          {b?.extended.map((e) => (
            <li key={e.personId} className="row">
              <span className="row-main">
                <Link to={`/people/${e.personId}`}>{e.name}</Link>
                <span className="muted">now ends {formatDate(e.probationEndDate)}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function ReviewSection(props: { title: string; reviews?: ReviewView[]; empty: string }) {
  const id = props.title.toLowerCase().replace(/\W+/g, '-');
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{props.title}</h2>
      {props.reviews?.length === 0 && <Empty>{props.empty}</Empty>}
      <ul className="rows" aria-label={props.title}>
        {props.reviews?.map((r) => (
          <li key={r.id} className="row">
            <span className="row-main">
              <Link to={`/reviews/${r.id}`}>{r.person.name}</Link>
              <span className="muted">
                due {formatDate(r.dueOn)} · {r.reviewer}
              </span>
            </span>
            {r.requestId && r.status === 'submitted' ? (
              <Link className="button button-quiet" to={`/requests/${r.requestId}`}>
                Decision
              </Link>
            ) : (
              <Chip tone={r.overdue ? 'warn' : 'info'}>{r.overdue ? 'Overdue' : 'Due'}</Chip>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
