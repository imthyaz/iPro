import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { AskResponse, AssistantMessageView } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { Note } from '../../design-system/index.js';
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
          {messages.length > 0 && (
            <button
              className="button button-quiet"
              onClick={() => {
                setConversationId(null);
                setMessages([]);
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

      <div className="ask-thread" role="log" aria-live="polite" aria-label="Conversation">
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
                    <Link to={s.link}>{s.label}</Link>
                  </span>
                ))}
              </p>
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
