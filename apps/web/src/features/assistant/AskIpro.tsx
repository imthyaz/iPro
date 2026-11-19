import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type {
  AskResponse,
  AssistantActionView,
  AssistantArchiveView,
  AssistantConversationSummary,
  AssistantConversationView,
  AssistantMessageView,
} from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { Empty, formatDate, Note } from '../../design-system/index.js';
import { CompactJourney } from '../journey/Journey.js';

const EXAMPLES = [
  'How many casual leaves do I have?',
  'Who in my team is on leave tomorrow?',
  'How many approvals are waiting for me?',
];

/**
 * X2 Ask iPro: a side panel on every screen (full screen on a phone). Answers come from iPro's own
 * data as the signed-in user may see it, each with a link to the screen behind it.
 */
export function AskIproPanel({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessageView[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const reopen = useMutation({
    mutationFn: (id: string) => api<AssistantConversationView>(`/assistant/conversations/${id}`),
    onSuccess: (view) => {
      setConversationId(view.id);
      setMessages(view.messages);
      setShowHistory(false);
    },
  });
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const ask = useMutation({
    mutationFn: (question: string) =>
      api<AskResponse>('/assistant/ask', {
        body: { text: question, ...(conversationId ? { conversationId } : {}) },
      }),
    onMutate: (question) => {
      setMessages((m) => [
        ...m,
        {
          id: `pending-${m.length}`,
          role: 'user',
          text: question,
          sources: [],
          open: null,
          action: null,
          createdAt: new Date().toISOString(),
        },
      ]);
      setText('');
    },
    onSuccess: (reply) => {
      setConversationId(reply.conversationId);
      setMessages((m) => [...m, reply.answer]);
    },
  });

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, ask.isPending]);

  const send = (question: string) => {
    if (question.trim() && !ask.isPending) ask.mutate(question.trim());
  };

  return (
    <aside className="ask-panel" aria-label="Ask iPro">
      <div className="ask-head">
        <h2>Ask iPro</h2>
        <span className="ask-head-actions">
          <button
            className="button button-quiet"
            aria-pressed={showHistory}
            onClick={() => setShowHistory((open) => !open)}
          >
            History
          </button>
          {messages.length > 0 && (
            <button
              className="button button-quiet"
              onClick={() => {
                setConversationId(null);
                setMessages([]);
                setShowHistory(false);
                ask.reset();
              }}
            >
              New conversation
            </button>
          )}
          <button className="button button-quiet" onClick={onClose} aria-label="Close Ask iPro">
            Close
          </button>
        </span>
      </div>

      {showHistory && <History onOpen={(id) => reopen.mutate(id)} error={reopen.error} />}
      <div
        className="ask-thread"
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        hidden={showHistory}
      >
        {messages.length === 0 && (
          <div className="ask-intro">
            <p className="muted">
              Ask about your leave, attendance, team or people. Answers use iPro’s own data, as you
              can see it.
            </p>
            <ul className="ask-examples" aria-label="Examples">
              {EXAMPLES.map((q) => (
                <li key={q}>
                  <button className="button button-quiet" onClick={() => send(q)}>
                    {q}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`ask-message ask-${m.role}`}>
            <span className="visually-hidden">{m.role === 'user' ? 'You' : 'Ask iPro'}:</span>
            <p>{m.text}</p>
            {m.sources.length > 0 && (
              <p className="ask-sources">
                <span className="muted">From </span>
                {m.sources.map((s, i) => (
                  <span key={s.link}>
                    {i > 0 && ', '}
                    {/^(https?:|mailto:)/.test(s.link) ? (
                      // Outside iPro (e.g. a Teams chat with HR): a new tab, not the app's router.
                      <a href={s.link} target="_blank" rel="noopener noreferrer">
                        {s.label}
                      </a>
                    ) : (
                      <Link to={s.link}>{s.label}</Link>
                    )}
                  </span>
                ))}
              </p>
            )}
            {m.action && (
              <ActionCard
                action={m.action}
                onChange={(action) =>
                  setMessages((all) => all.map((x) => (x.id === m.id ? { ...x, action } : x)))
                }
              />
            )}
            {m.open?.kind === 'timeline' && (
              <div className="ask-open">
                <CompactJourney
                  personId={m.open.personId}
                  onOpen={() => navigate(`/people/${m.open!.personId}?tab=journey`)}
                />
              </div>
            )}
          </div>
        ))}
        {ask.isPending && (
          <p className="ask-message ask-assistant muted" role="status">
            Looking that up…
          </p>
        )}
        {ask.error && <Note kind="error">{errorMessage(ask.error)}</Note>}
        <div ref={end} />
      </div>

      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <label htmlFor="ask-input" className="visually-hidden">
          Your question
        </label>
        <textarea
          id="ask-input"
          ref={input}
          rows={2}
          maxLength={2000}
          placeholder="Ask a question"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
        />
        <button className="button button-primary" disabled={ask.isPending || !text.trim()}>
          Ask
        </button>
      </form>
    </aside>
  );
}

/**
 * A confirmation card (spec: drafts, never silent actions; decision #91): the exact effect, and
 * nothing changes until the user taps the button. Exits, terminations and pay are never offered.
 */
function ActionCard({
  action,
  onChange,
}: {
  action: AssistantActionView;
  onChange: (action: AssistantActionView) => void;
}) {
  const client = useQueryClient();
  const decide = useMutation({
    mutationFn: (verb: 'confirm' | 'cancel') =>
      api<AssistantActionView>(`/assistant/actions/${action.id}/${verb}`, { method: 'POST' }),
    onSuccess: (next) => {
      onChange(next);
      // What the card changed shows everywhere else straight away.
      void client.invalidateQueries();
    },
  });
  const open = action.status === 'proposed';
  return (
    <section className="ask-action" aria-label={action.title}>
      <strong>{action.title}</strong>
      <dl className="ask-action-lines">
        {action.lines.map((l, i) => (
          <div key={`${l.label}-${i}`}>
            <dt>{l.label}</dt>
            <dd>{l.value}</dd>
          </div>
        ))}
      </dl>
      {open ? (
        <div className="form-actions">
          <button
            className="button button-primary"
            disabled={decide.isPending}
            onClick={() => decide.mutate('confirm')}
          >
            {action.confirmLabel}
          </button>
          <button
            className="button button-quiet"
            disabled={decide.isPending}
            onClick={() => decide.mutate('cancel')}
          >
            Cancel
          </button>
        </div>
      ) : (
        <p className="muted" role="status">
          {action.status === 'confirmed'
            ? 'Done.'
            : action.status === 'cancelled'
              ? 'Cancelled; nothing was changed.'
              : action.status === 'expired'
                ? 'This card expired; nothing was changed. Ask again.'
                : 'Not done.'}{' '}
          {action.result?.text} {action.result?.link && <Link to={action.result.link}>See it</Link>}
        </p>
      )}
      {decide.error && <Note kind="error">{errorMessage(decide.error)}</Note>}
    </section>
  );
}

/**
 * Past conversations (X2): the last 30 days or so to pick up again, and the archived ones, kept as
 * summaries after 180 days and searchable by topic or person (decision #92). The user's own only.
 */
function History({ onOpen, error }: { onOpen: (id: string) => void; error: unknown }) {
  const [q, setQ] = useState('');
  const recent = useQuery({
    queryKey: ['assistant-conversations'],
    queryFn: () => api<AssistantConversationSummary[]>('/assistant/conversations'),
  });
  const archived = useQuery({
    queryKey: ['assistant-archive', q],
    queryFn: () =>
      api<AssistantArchiveView[]>(
        `/assistant/archive${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`,
      ),
  });
  return (
    <div className="ask-thread ask-history" aria-label="History">
      <h3>Recent</h3>
      {recent.data?.length === 0 && <Empty>No conversations yet.</Empty>}
      <ul className="rows" aria-label="Recent conversations">
        {recent.data?.map((c) => (
          <li key={c.id} className="row">
            <button className="button button-quiet ask-history-open" onClick={() => onOpen(c.id)}>
              {c.title}
            </button>
            <span className="muted">{formatDate(c.lastAt)}</span>
          </li>
        ))}
      </ul>
      {error ? <Note kind="error">{errorMessage(error)}</Note> : null}
      <h3>Archived</h3>
      <p className="muted">After 180 days a conversation is kept only as a summary.</p>
      <label className="visually-hidden" htmlFor="ask-archive-q">
        Search archived conversations
      </label>
      <input
        id="ask-archive-q"
        type="search"
        placeholder="Search by topic or person"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {archived.data?.length === 0 && <Empty>Nothing archived{q ? ' matches' : ' yet'}.</Empty>}
      <ul className="rows" aria-label="Archived conversations">
        {archived.data?.map((a) => (
          <li key={a.id} className="row">
            <span className="row-main">
              <span>{a.summary}</span>
              <span className="muted">
                {formatDate(a.startedAt)} to {formatDate(a.lastAt)}
                {a.people.length ? ` · ${a.people.map((p) => p.name).join(', ')}` : ''}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
