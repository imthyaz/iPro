import { useId, useState, type ReactNode } from 'react';
import type { PersonSummary } from '@ipro/shared';

/**
 * One layout everywhere (CLAUDE.md): a list, with the selected item's detail in a side panel. On
 * phones the panel covers the list and has a Back button.
 */
export function ListDetail(props: {
  list: ReactNode;
  detail: ReactNode | null;
  onClose: () => void;
  detailLabel: string;
}) {
  return (
    <div className={`list-detail${props.detail ? ' has-detail' : ''}`}>
      <section className="list-pane">{props.list}</section>
      {props.detail && (
        <aside className="detail-pane" aria-label={props.detailLabel}>
          <button className="button button-quiet detail-close" onClick={props.onClose}>
            ← Back to list
          </button>
          {props.detail}
        </aside>
      )}
    </div>
  );
}

const statusWords: Record<PersonSummary['status'], string> = {
  offered: 'Offered',
  pre_joining: 'Joining soon',
  active: 'Active',
  on_notice: 'Serving notice',
  exited: 'Exited',
  withdrawn: 'Withdrawn',
};

const statusTone: Record<PersonSummary['status'], 'ok' | 'info' | 'warn' | 'muted'> = {
  offered: 'info',
  pre_joining: 'info',
  active: 'ok',
  on_notice: 'warn',
  exited: 'muted',
  withdrawn: 'muted',
};

/** The same words and colours for engagement status in every module. */
export function StatusChip({ status }: { status: PersonSummary['status'] }) {
  return <span className={`chip chip-${statusTone[status]}`}>{statusWords[status]}</span>;
}

type RequestStatus = 'pending' | 'returned' | 'approved' | 'withdrawn';

const requestWords: Record<RequestStatus, string> = {
  pending: 'Waiting for approval',
  returned: 'Returned to you',
  approved: 'Approved',
  withdrawn: 'Withdrawn',
};

const requestTone: Record<RequestStatus, 'ok' | 'info' | 'warn' | 'muted'> = {
  pending: 'info',
  returned: 'warn',
  approved: 'ok',
  withdrawn: 'muted',
};

/** The same words and colours for request (workflow) status everywhere. */
export function RequestStatusChip({ status }: { status: RequestStatus }) {
  return <span className={`chip chip-${requestTone[status]}`}>{requestWords[status]}</span>;
}

/** Due date with an overdue warning, the same on approvals and tasks. */
export function DueChip({ dueOn, overdue }: { dueOn: string; overdue: boolean }) {
  return (
    <span className={`chip chip-${overdue ? 'warn' : 'muted'}`}>
      {overdue ? 'Overdue · ' : 'Due '}
      {formatDate(dueOn)}
    </span>
  );
}

/** "From → to" lines, so an approver decides on the card itself. */
export function ChangeList({
  changes,
}: {
  changes: { label: string; from: string | null; to: string | null }[];
}) {
  if (changes.length === 0) return null;
  return (
    <dl className="changes">
      {changes.map((c) => (
        <div key={c.label}>
          <dt>{c.label}</dt>
          <dd>
            <span className="change-from">{c.from ?? '—'}</span>
            <span aria-hidden="true"> → </span>
            <span className="visually-hidden"> to </span>
            <strong>{c.to ?? '—'}</strong>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Chip({
  tone,
  children,
}: {
  tone: 'ok' | 'info' | 'warn' | 'muted';
  children: ReactNode;
}) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

/**
 * A masked KYC value. Unmasking is a deliberate, audited action, so it needs a click and says so.
 */
export function MaskedValue(props: {
  masked: string;
  label: string;
  canUnmask: boolean;
  onUnmask: () => Promise<string>;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <span className="masked">
      <code aria-label={value ? `${props.label} value` : `${props.label}, masked`}>
        {value ?? props.masked}
      </code>
      {props.canUnmask &&
        (value ? (
          <button className="button button-quiet" onClick={() => setValue(null)}>
            Hide
          </button>
        ) : (
          <button
            className="button button-quiet"
            disabled={busy}
            title="Viewing the full value is recorded in the audit log"
            onClick={async () => {
              setBusy(true);
              setError(false);
              try {
                setValue(await props.onUnmask());
              } catch {
                setError(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            Show full {props.label} (logged)
          </button>
        ))}
      {error && <span className="note note-error">Couldn’t show it.</span>}
    </span>
  );
}

export function Tabs<T extends string>(props: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={props.label}>
      {props.tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={tab.id === props.active}
          className={tab.id === props.active ? 'tab tab-active' : 'tab'}
          onClick={() => props.onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** A labelled form field; `children` receives the input id. */
export function Field(props: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      {props.children(id)}
      {props.hint && <span className="muted field-hint">{props.hint}</span>}
    </div>
  );
}

export function Note({ kind, children }: { kind: 'error' | 'info'; children: ReactNode }) {
  return (
    <p className={`note note-${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      {children}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty muted">{children}</p>;
}

const dateFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "2026-11-01" → "1 Nov 2026" (business dates have no time zone). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dateFormat.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
}

/** Today's business date in India, for date inputs. */
export function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
