import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { CheckInProgress, CheckInView } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { DueChip, Field, formatDate, Note } from '../../design-system/index.js';
import { progressWords } from './Reviews.js';

export const useOpenCheckIns = () =>
  useQuery({
    queryKey: ['check-ins', 'open'],
    queryFn: () => api<CheckInView[]>('/check-ins?open=true'),
  });

/**
 * A monthly probation check-in on the inbox (decision #63): how the month went in one tap, and a
 * short note; recorded where it's asked for, with no page to open.
 */
export function CheckInCard({ checkIn }: { checkIn: CheckInView }) {
  const client = useQueryClient();
  const [progress, setProgress] = useState<CheckInProgress | ''>('');
  const [notes, setNotes] = useState('');
  const record = useMutation({
    mutationFn: () => api<CheckInView>(`/check-ins/${checkIn.id}`, { body: { progress, notes } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['check-ins'] }),
  });
  return (
    <li className="card" aria-label={`Check-in: ${checkIn.person.name}`}>
      <div className="card-head">
        <strong>
          Month {checkIn.month} check-in: {checkIn.person.name}
        </strong>
        <DueChip dueOn={checkIn.dueOn} overdue={checkIn.overdue} />
      </div>
      <span className="muted">Probation check-in from {formatDate(checkIn.dueOn)}</span>
      <form
        className="inline-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          record.mutate();
        }}
      >
        <fieldset className="check-group">
          <legend>How is it going?</legend>
          {(Object.keys(progressWords) as CheckInProgress[]).map((p) => (
            <label key={p} className="check">
              <input
                type="radio"
                name={`progress-${checkIn.id}`}
                required
                checked={progress === p}
                onChange={() => setProgress(p)}
              />
              {progressWords[p]}
            </label>
          ))}
        </fieldset>
        <Field label="Notes">
          {(id) => (
            <textarea
              id={id}
              rows={2}
              required
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          )}
        </Field>
        <button className="button button-primary" disabled={record.isPending || !progress}>
          Record check-in
        </button>
        {record.error && <Note kind="error">{errorMessage(record.error)}</Note>}
      </form>
    </li>
  );
}
