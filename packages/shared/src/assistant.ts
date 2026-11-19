import { z } from 'zod';

/** POST /api/assistant/ask (X2 Ask iPro): a question, in a new conversation or an existing one. */
export const askSchema = z.object({
  conversationId: z.uuid().optional(),
  text: z.string().trim().min(1).max(2000),
});
export type AskInput = z.infer<typeof askSchema>;

/** Where a figure came from: the screen or list behind it (spec: numbers come from the system). */
export interface AssistantSource {
  label: string;
  link: string;
}

/** Something the side panel opens next to the answer, e.g. a person's timeline. */
export type AssistantOpen = { kind: 'timeline'; personId: string; name: string };

export interface AssistantMessageView {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sources: AssistantSource[];
  open: AssistantOpen | null;
  /** A change the answer prepared; nothing happens until the user confirms it (decision #91). */
  action: AssistantActionView | null;
  createdAt: string;
}

/**
 * A confirmation card (spec: drafts, never silent actions): the exact effect, and what confirming
 * does. Confirmed only by the user's tap, through the same API checks as the screen it stands for.
 */
export interface AssistantActionView {
  id: string;
  kind: 'apply_leave' | 'approve_leave' | 'draft_letter';
  title: string;
  lines: { label: string; value: string }[];
  confirmLabel: string;
  status: 'proposed' | 'confirmed' | 'cancelled' | 'expired' | 'failed';
  /** What happened once confirmed (or why it couldn't be), with where to see it. */
  result: { text: string; link: string | null } | null;
  expiresAt: string;
}

export interface AssistantConversationView {
  id: string;
  title: string;
  startedAt: string;
  messages: AssistantMessageView[];
}

/**
 * A conversation older than 180 days, as kept after its text is deleted (spec: AssistantSummary;
 * decision #92): what it was about, who it referred to and what was confirmed. Its owner's only.
 */
export interface AssistantArchiveView {
  id: string;
  summary: string;
  topics: string[];
  /** People it referred to, by name as now recorded. */
  people: { personId: string; name: string }[];
  actions: {
    kind: AssistantActionView['kind'];
    status: 'confirmed' | 'cancelled' | 'failed' | 'expired';
  }[];
  startedAt: string;
  lastAt: string;
  archivedAt: string;
}

export interface AssistantConversationSummary {
  id: string;
  title: string;
  startedAt: string;
  lastAt: string;
}

export interface AskResponse {
  conversationId: string;
  answer: AssistantMessageView;
}
