import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import type {
  NotificationPreferencesInput,
  NotificationPreferencesView,
  NotificationTopic,
} from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { Empty, formatDate, Note } from '../../design-system/index.js';
import { useNotifications } from './Inbox.js';

/**
 * X1 Notifications: everything sent to me, newest first, and what I want to hear about. Approvals
 * and compliance items can't be switched off (spec: Notifications).
 */
export function NotificationsPage() {
  const client = useQueryClient();
  const notes = useNotifications();
  const read = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const readAll = useMutation({
    mutationFn: () => api('/notifications/read-all', { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const unread = notes.data?.filter((n) => !n.read).length ?? 0;

  return (
    <main className="page">
      <h1>Notifications</h1>
      <section aria-labelledby="notifications-list">
        <div className="section-head">
          <h2 id="notifications-list">Recent ({unread} unread)</h2>
          {unread > 0 && (
            <button
              className="button"
              disabled={readAll.isPending}
              onClick={() => readAll.mutate()}
            >
              Mark all read
            </button>
          )}
        </div>
        {notes.error && <Note kind="error">{errorMessage(notes.error)}</Note>}
        {notes.data?.length === 0 && <Empty>Nothing yet.</Empty>}
        {Boolean(notes.data?.length) && (
          <ul className="rows" aria-label="Notifications">
            {notes.data!.map((n) => (
              <li key={n.id} className={`row${n.read ? '' : ' notification-unread'}`}>
                <span className="row-main">
                  {n.link ? (
                    <Link to={n.link} onClick={() => !n.read && read.mutate(n.id)}>
                      {n.title}
                    </Link>
                  ) : (
                    <span>{n.title}</span>
                  )}
                  <span className="muted">
                    {formatDate(n.createdAt)}
                    {n.read ? '' : ' · unread'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Preferences />
    </main>
  );
}

function Preferences() {
  const client = useQueryClient();
  const prefs = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => api<NotificationPreferencesView>('/notification-preferences'),
  });
  // The change shows in the same click (the box must not spring back) until the save settles; a
  // refetch still in flight from before the click is cancelled so it can't overwrite it.
  const [draft, setDraft] = useState<NotificationPreferencesInput | null>(null);
  const save = useMutation({
    mutationFn: (body: NotificationPreferencesInput) =>
      api<NotificationPreferencesView>('/notification-preferences', { method: 'PUT', body }),
    onMutate: () => client.cancelQueries({ queryKey: ['notification-preferences'] }),
    onSuccess: (saved) => client.setQueryData(['notification-preferences'], saved),
    onSettled: () => setDraft(null),
  });
  if (!prefs.data) {
    return prefs.error ? <Note kind="error">{errorMessage(prefs.error)}</Note> : null;
  }
  const view: NotificationPreferencesView = draft
    ? {
        topics: prefs.data.topics.map((t) => ({
          ...t,
          on: t.required || !draft.off.includes(t.key),
        })),
        emailCopy: draft.emailCopy,
      }
    : prefs.data;
  const change = (body: NotificationPreferencesInput) => {
    setDraft(body);
    save.mutate(body);
  };
  const offTopics = (except?: NotificationTopic, on?: boolean) =>
    view.topics
      .filter((t) => !t.required)
      .filter((t) => (t.key === except ? !on : !t.on))
      .map((t) => t.key);

  return (
    <section aria-labelledby="notification-settings">
      <h2 id="notification-settings">What you hear about</h2>
      <p className="muted">
        Notifications come here and to Microsoft Teams. Approvals, tasks and compliance items always
        come.
      </p>
      <ul className="preferences" aria-label="Topics">
        {view.topics.map((t) => (
          <li key={t.key}>
            <label>
              <input
                type="checkbox"
                checked={t.on}
                disabled={t.required || save.isPending}
                onChange={(e) =>
                  change({
                    off: offTopics(t.key, e.target.checked),
                    emailCopy: view.emailCopy,
                  })
                }
              />
              <span>
                <strong>{t.label}</strong>
                {t.required && <span className="muted"> · always on</span>}
                <br />
                <span className="muted">{t.description}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <ul className="preferences" aria-label="Email">
        <li>
          <label>
            <input
              type="checkbox"
              checked={view.emailCopy}
              disabled={save.isPending}
              onChange={(e) => change({ off: offTopics(), emailCopy: e.target.checked })}
            />
            <span>
              <strong>Also email me</strong>
              <br />
              <span className="muted">
                A copy of each notification by email. Letters always come by email.
              </span>
            </span>
          </label>
        </li>
      </ul>
      {save.error && <Note kind="error">{errorMessage(save.error)}</Note>}
    </section>
  );
}
