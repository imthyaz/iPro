import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { PersonSummary } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { hasRole, useMe } from '../../auth.js';
import { Empty, Field, ListDetail, Note, StatusChip } from '../../design-system/index.js';
import { PersonRecord } from './PersonRecord.js';

/** People directory (H1) with the person record (H2) in the side panel. */
export function Directory() {
  const { personId } = useParams();
  const navigate = useNavigate();
  const me = useMe().data;
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const people = useQuery({
    queryKey: ['people', q, status],
    queryFn: () => {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (status) params.set('status', status);
      return api<PersonSummary[]>(`/people?${params}`);
    },
  });

  const list = (
    <>
      <div className="toolbar">
        <h1>People</h1>
        {hasRole(me, 'hr', 'hr_head') && (
          <Link className="button button-primary" to="/people/new">
            New person
          </Link>
        )}
      </div>
      <div className="filters">
        <Field label="Search">
          {(id) => (
            <input
              id={id}
              type="search"
              placeholder="Name, code or email"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          )}
        </Field>
        <Field label="Status">
          {(id) => (
            <select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any</option>
              <option value="active">Active</option>
              <option value="pre_joining">Joining soon</option>
              <option value="on_notice">Serving notice</option>
              <option value="exited">Exited</option>
            </select>
          )}
        </Field>
      </div>
      {people.error && <Note kind="error">{errorMessage(people.error)}</Note>}
      {people.data?.length === 0 && <Empty>No one matches.</Empty>}
      <ul className="rows" aria-label="People">
        {people.data?.map((person) => (
          <li key={person.personId}>
            <Link
              to={`/people/${person.personId}`}
              className={person.personId === personId ? 'row row-selected' : 'row'}
              aria-current={person.personId === personId ? 'true' : undefined}
            >
              <span className="row-main">
                <strong>{person.preferredName ?? person.legalName}</strong>
                <span className="muted">
                  {person.employeeCode} · {person.designation?.title ?? '—'}
                </span>
              </span>
              <span className="row-side">
                <span className="muted">{person.department?.name}</span>
                <StatusChip status={person.status} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );

  return (
    <ListDetail
      list={list}
      detail={personId ? <PersonRecord personId={personId} /> : null}
      onClose={() => navigate('/people')}
      detailLabel="Person record"
    />
  );
}
