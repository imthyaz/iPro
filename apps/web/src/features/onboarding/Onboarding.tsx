import { useQuery } from '@tanstack/react-query';
import type { MyPolicyView, MyTaskView, OnboardingView } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { useMe } from '../../auth.js';
import { Chip, Empty, formatDate, Note } from '../../design-system/index.js';
import { Task } from '../inbox/Inbox.js';
import { Documents, Kyc } from '../people/PersonRecord.js';
import { Policy } from '../policies/MyPolicies.js';

/** The joiner's onboarding, or null when they aren't joining (GET /api/onboarding/me). */
export function useOnboarding(enabled = true) {
  return useQuery({
    queryKey: ['onboarding'],
    queryFn: async () =>
      (await api<{ onboarding: OnboardingView | null }>('/onboarding/me')).onboarding,
    enabled,
  });
}

const countdown = (days: number) =>
  days > 1 ? `in ${days} days` : days === 1 ? 'tomorrow' : days === 0 ? 'today' : 'started';

/**
 * Onboarding portal (E11), mobile-first: Day-1 details, then what to do before joining: tasks, KYC,
 * documents and policies. Each section uses the same components and rules as the rest of iPro.
 */
export function Onboarding() {
  const me = useMe().data;
  const personId = me?.personId ?? null;
  const onboarding = useOnboarding(Boolean(personId));
  const tasks = useQuery({
    queryKey: ['my-tasks'],
    queryFn: () => api<MyTaskView[]>('/checklist-tasks/mine'),
  });
  const policies = useQuery({
    queryKey: ['my-policies'],
    queryFn: () => api<MyPolicyView[]>('/policies/mine'),
  });

  if (onboarding.error) return <Note kind="error">{errorMessage(onboarding.error)}</Note>;
  if (!onboarding.data) {
    return (
      <main className="page">
        <h1>Onboarding</h1>
        {onboarding.isLoading ? (
          <p className="muted">Loading…</p>
        ) : (
          <Empty>Nothing to do here.</Empty>
        )}
      </main>
    );
  }
  const o = onboarding.data;
  const myTasks = tasks.data?.filter((t) => t.person.personId === personId) ?? [];
  const pendingPolicies = policies.data?.filter((p) => p.pending) ?? [];

  return (
    <main className="page onboarding">
      <h1>Welcome, {o.name}</h1>
      <section className="card day-one" aria-labelledby="day-one">
        <h2 id="day-one">Your first day</h2>
        <p className="day-one-date">
          <strong>{formatDate(o.joiningDate)}</strong>{' '}
          <Chip tone="info">{countdown(o.daysToGo)}</Chip>
        </p>
        <dl className="facts">
          {o.dayOne && (
            <div>
              <dt>Start</dt>
              <dd>
                {o.dayOne.startTime} (until {o.dayOne.endTime})
              </dd>
            </div>
          )}
          <div>
            <dt>Where</dt>
            <dd>{o.location ?? '—'}</dd>
          </div>
          <div>
            <dt>Your manager</dt>
            <dd>{o.manager ?? '—'}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>
              {o.designation ?? '—'}
              {o.department ? `, ${o.department}` : ''}
            </dd>
          </div>
          {o.endDate && (
            <div>
              <dt>Until</dt>
              <dd>{formatDate(o.endDate)}</dd>
            </div>
          )}
        </dl>
        {o.checklists.map((c) => (
          <p key={c.runId} className="muted">
            {c.name}: {c.done} of {c.total} done
            {c.overdue > 0 && (
              <>
                {' '}
                <Chip tone="warn">{c.overdue} overdue</Chip>
              </>
            )}
          </p>
        ))}
      </section>

      <section aria-labelledby="onboarding-tasks">
        <h2 id="onboarding-tasks">Before you join ({myTasks.length})</h2>
        {myTasks.length === 0 ? (
          <Empty>No tasks waiting on you.</Empty>
        ) : (
          <ul className="cards" aria-label="Your tasks">
            {myTasks.map((task) => (
              <Task key={task.id} task={task} />
            ))}
          </ul>
        )}
      </section>

      {personId && (
        <section aria-labelledby="onboarding-kyc">
          <h2 id="onboarding-kyc">Your KYC details</h2>
          <Kyc personId={personId} canUnmask={false} canSubmit />
        </section>
      )}

      {personId && (
        <section aria-labelledby="onboarding-documents">
          <h2 id="onboarding-documents">Your documents</h2>
          <Documents personId={personId} isSelf isHr={false} />
        </section>
      )}

      <section aria-labelledby="onboarding-policies">
        <h2 id="onboarding-policies">Policies to accept ({pendingPolicies.length})</h2>
        {pendingPolicies.length === 0 ? (
          <Empty>Nothing to accept.</Empty>
        ) : (
          <ul className="cards" aria-label="Policies to accept">
            {pendingPolicies.map((p) => (
              <Policy key={p.policyId} policy={p} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
