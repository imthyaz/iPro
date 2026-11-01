import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ProbationOutcome, ReviewView, SubmitReviewInput } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import {
  Chip,
  DueChip,
  Empty,
  Field,
  formatDate,
  ListDetail,
  Note,
} from '../../design-system/index.js';

const outcomeWords: Record<ProbationOutcome, string> = {
  confirm: 'Confirm',
  extend: 'Extend probation',
  terminate: 'End employment',
};

const statusChip = (r: ReviewView) =>
  r.status === 'due' ? (
    <DueChip dueOn={r.dueOn} overdue={r.overdue} />
  ) : r.status === 'submitted' ? (
    <Chip tone="info">Waiting for HR</Chip>
  ) : r.status === 'decided' ? (
    <Chip tone="ok">Decided: {outcomeWords[r.decision!]}</Chip>
  ) : (
    <Chip tone="muted">Cancelled</Chip>
  );

export const useReviews = () =>
  useQuery({ queryKey: ['reviews'], queryFn: () => api<ReviewView[]>('/reviews') });

/** Probation reviews (M5): the reviews I write or may read, with the review in the side panel. */
export function Reviews() {
  const { reviewId } = useParams();
  const navigate = useNavigate();
  const reviews = useReviews();
  const sorted = [...(reviews.data ?? [])].sort(
    (a, b) =>
      Number(b.canSubmit) - Number(a.canSubmit) ||
      Number(b.overdue) - Number(a.overdue) ||
      a.dueOn.localeCompare(b.dueOn),
  );

  const list = (
    <>
      <h1>Probation reviews</h1>
      {reviews.error && <Note kind="error">{errorMessage(reviews.error)}</Note>}
      {reviews.data?.length === 0 && <Empty>No reviews.</Empty>}
      <ul className="rows" aria-label="Reviews">
        {sorted.map((r) => (
          <li key={r.id}>
            <Link
              to={`/reviews/${r.id}`}
              className={r.id === reviewId ? 'row row-selected' : 'row'}
              aria-current={r.id === reviewId ? 'true' : undefined}
            >
              <span className="row-main">
                <strong>{r.person.name}</strong>
                <span className="muted">
                  {r.designation ?? '—'} · probation ends {formatDate(r.dueOn)}
                </span>
              </span>
              <span className="row-side">{statusChip(r)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );

  return (
    <ListDetail
      list={list}
      detail={reviewId ? <ReviewDetail key={reviewId} reviewId={reviewId} /> : null}
      onClose={() => navigate('/reviews')}
      detailLabel="Review"
    />
  );
}

function ReviewDetail({ reviewId }: { reviewId: string }) {
  const review = useQuery({
    queryKey: ['review', reviewId],
    queryFn: () => api<ReviewView>(`/reviews/${reviewId}`),
  });
  if (review.error) return <Note kind="error">{errorMessage(review.error)}</Note>;
  if (!review.data) return <p className="muted">Loading…</p>;
  const r = review.data;
  return (
    <article className="record">
      <header className="record-header">
        <h2>{r.person.name}</h2>
        <p className="muted">
          {r.employeeCode} · {r.designation ?? '—'} · joined {formatDate(r.joiningDate)}
        </p>
        <p>{statusChip(r)}</p>
      </header>
      <dl className="facts">
        <div>
          <dt>Probation ends</dt>
          <dd>{formatDate(r.dueOn)}</dd>
        </div>
        <div>
          <dt>Reviewer</dt>
          <dd>{r.reviewer}</dd>
        </div>
        <div>
          <dt>Extensions</dt>
          <dd>
            {r.extensions.used} of {r.extensions.max} used
          </dd>
        </div>
      </dl>
      {r.canSubmit ? <ReviewForm review={r} /> : <ReviewAnswers review={r} />}
      {r.requestId && r.status === 'submitted' && (
        <p>
          <Link to={`/requests/${r.requestId}`}>See the decision request</Link>
        </p>
      )}
    </article>
  );
}

function ReviewAnswers({ review }: { review: ReviewView }) {
  if (!review.recommendation) return <Empty>Not written yet.</Empty>;
  return (
    <>
      <h3>Recommendation: {outcomeWords[review.recommendation]}</h3>
      {review.newEndDate && <p>New end date: {formatDate(review.newEndDate)}</p>}
      {review.lastWorkingDate && <p>Last working day: {formatDate(review.lastWorkingDate)}</p>}
      <dl className="facts">
        {review.competencies.map((c) => (
          <div key={c}>
            <dt>{c}</dt>
            <dd>{review.ratings[c] ? `${review.ratings[c]} / 5` : '—'}</dd>
          </div>
        ))}
      </dl>
      {review.strengths && (
        <>
          <h3>Strengths</h3>
          <p>{review.strengths}</p>
        </>
      )}
      {review.improvements && (
        <>
          <h3>To improve</h3>
          <p>{review.improvements}</p>
        </>
      )}
      <h3>Comments</h3>
      <p>{review.comments}</p>
    </>
  );
}

/** The review form (M5): a rating per area, comments and the recommendation. */
function ReviewForm({ review }: { review: ReviewView }) {
  const client = useQueryClient();
  const [ratings, setRatings] = useState<Record<string, number>>(review.ratings);
  const [recommendation, setRecommendation] = useState<ProbationOutcome>(
    review.recommendation ?? 'confirm',
  );
  const [strengths, setStrengths] = useState(review.strengths ?? '');
  const [improvements, setImprovements] = useState(review.improvements ?? '');
  const [comments, setComments] = useState(review.comments ?? '');
  const [newEndDate, setNewEndDate] = useState(review.newEndDate ?? '');
  const [lastWorkingDate, setLastWorkingDate] = useState(review.lastWorkingDate ?? '');
  const canExtend = review.extensions.used < review.extensions.max;
  const submit = useMutation({
    mutationFn: () => {
      const body: SubmitReviewInput = {
        recommendation,
        ratings,
        comments,
        ...(strengths.trim() ? { strengths } : {}),
        ...(improvements.trim() ? { improvements } : {}),
        ...(recommendation === 'extend' ? { newEndDate } : {}),
        ...(recommendation === 'terminate' ? { lastWorkingDate } : {}),
      };
      return api<ReviewView>(`/reviews/${review.id}/submit`, { body });
    },
    onSuccess: (view) => {
      client.setQueryData(['review', review.id], view);
      return Promise.all([
        client.invalidateQueries({ queryKey: ['reviews'] }),
        client.invalidateQueries({ queryKey: ['requests'] }),
      ]);
    },
  });

  return (
    <form
      className="inline-form review-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        submit.mutate();
      }}
    >
      <h3>Your review</h3>
      {review.competencies.map((area) => (
        <fieldset key={area} className="check-group rating">
          <legend>{area}</legend>
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="check">
              <input
                type="radio"
                name={area}
                value={n}
                required
                checked={ratings[area] === n}
                onChange={() => setRatings({ ...ratings, [area]: n })}
              />
              {n}
            </label>
          ))}
        </fieldset>
      ))}
      <Field label="Strengths">
        {(id) => (
          <textarea
            id={id}
            rows={2}
            value={strengths}
            onChange={(e) => setStrengths(e.target.value)}
          />
        )}
      </Field>
      <Field label="To improve">
        {(id) => (
          <textarea
            id={id}
            rows={2}
            value={improvements}
            onChange={(e) => setImprovements(e.target.value)}
          />
        )}
      </Field>
      <Field label="Comments" hint="HR reads this when deciding.">
        {(id) => (
          <textarea
            id={id}
            rows={3}
            required
            value={comments}
            onChange={(e) => setComments(e.target.value)}
          />
        )}
      </Field>
      <fieldset className="check-group">
        <legend>Recommendation</legend>
        {(['confirm', 'extend', 'terminate'] as const).map((o) => (
          <label key={o} className="check">
            <input
              type="radio"
              name="recommendation"
              value={o}
              disabled={o === 'extend' && !canExtend}
              checked={recommendation === o}
              onChange={() => setRecommendation(o)}
            />
            {outcomeWords[o]}
          </label>
        ))}
      </fieldset>
      {!canExtend && (
        <span className="muted field-hint">
          Probation can’t be extended again ({review.extensions.used} of {review.extensions.max}{' '}
          used).
        </span>
      )}
      {recommendation === 'extend' && (
        <Field
          label="New end date"
          hint={`Up to ${review.extensions.maxMonths} months after ${formatDate(review.dueOn)}`}
        >
          {(id) => (
            <input
              id={id}
              type="date"
              required
              min={review.dueOn}
              value={newEndDate}
              onChange={(e) => setNewEndDate(e.target.value)}
            />
          )}
        </Field>
      )}
      {recommendation === 'terminate' && (
        <Field label="Last working day" hint="HR head decides on ending employment.">
          {(id) => (
            <input
              id={id}
              type="date"
              required
              value={lastWorkingDate}
              onChange={(e) => setLastWorkingDate(e.target.value)}
            />
          )}
        </Field>
      )}
      <button className="button button-primary" disabled={submit.isPending}>
        Send to HR
      </button>
      {submit.error && <Note kind="error">{errorMessage(submit.error)}</Note>}
    </form>
  );
}
