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
  createdAt: string;
}

export interface AssistantConversationView {
  id: string;
  title: string;
  startedAt: string;
  messages: AssistantMessageView[];
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
