import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type {
  AskInput,
  AskResponse,
  AssistantConversationSummary,
  AssistantConversationView,
  AssistantMessageView,
  AssistantOpen,
  AssistantSource,
} from '@ipro/shared';
import { AuditService } from '../audit/audit.service.js';
import { businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import { SettingsService } from '../people/settings.service.js';
import {
  assistantConversations,
  assistantMessages,
  type LinkedRecord,
  type ToolCallRecord,
} from './assistant.schema.js';
import { LLM, LlmUnavailable, type Llm, type ModelTier } from './llm.js';
import { AssistantTools } from './tools.js';

/** Tool rounds per question before giving up (a loop guard; real questions take one to three). */
const MAX_ROUNDS = 6;
/** Earlier questions and answers sent with a new question, for follow-ups ("and next week?"). */
const HISTORY = 10;

export const NO_DATA_ANSWER =
  'I couldn’t find that in iPro, so I won’t guess. Try asking another way, or check with HR.';
export const NO_ACCESS_ANSWER = 'You don’t have access to that in iPro, so I can’t show it.';
export const UNAVAILABLE_ANSWER = 'Ask iPro isn’t available right now. Please try again later.';
export const REFUSED_ANSWER = 'I can’t help with that one.';
/** Spec: a policy question with no source gets "I don't know" and a link to HR (decision #89). */
export const DONT_KNOW_ANSWER =
  'I don’t know: none of the policies that apply to you answers that. HR can help.';

const SYSTEM = `You are Ask iPro, the assistant inside iPro, Ideassion's workforce management app.
You answer questions about people, the org, attendance, leave, hybrid (office/WFH) planning and
journeys, using only the tools provided. They return iPro's own data, as the signed-in user may see it.

Rules:
- Every number, date, name or status in your answer must come from a tool result in this
  conversation. Never estimate or use general knowledge for figures. If no tool answers the
  question, say you couldn't find it in iPro.
- If a tool says the user doesn't have access, say so plainly and don't guess or hint at the data.
- To ask about a named person, call find_people first and use the personId it returns.
- Keep answers short: a sentence or two, or a short list. Use plain words; no tables unless asked.
- For any question about policy or rules, call policy_search and answer only from the clauses it
  returns, naming the policy and clause (e.g. "Leave policy 4.2"). If none answers it, say you
  don't know.
- You can't change anything yet; if asked to apply, approve or draft something, say it's coming soon
  and point to the screen in iPro.
Today is {today} (India time). Weeks start on Monday.`;

/**
 * Ask iPro (X2; decision #88). Answers a question by letting the model call iPro's own tools as the
 * signed-in user, then keeps the question and answer (180 days) and writes an audit row for each.
 * Two checks don't depend on the model: an answer with figures but no tool result behind it is
 * replaced by "couldn't find it", and an answer whose every lookup was refused shows no data.
 */
@Injectable()
export class AssistantService {
  private readonly log = new Logger('AskIpro');

  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(LLM) private readonly llm: Llm,
    @Inject(AssistantTools) private readonly tools: AssistantTools,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  async ask(input: AskInput): Promise<AskResponse> {
    const { actor, tenantId } = requireContext();
    if (this.llm.name === 'none')
      throw new ServiceUnavailableException({ message: UNAVAILABLE_ANSWER });
    const conversation = input.conversationId
      ? await this.own(input.conversationId)
      : await this.db.tx(async (tx) => {
          const [row] = await tx
            .insert(assistantConversations)
            .values({
              tenantId,
              userId: actor!.userId,
              title: input.text.slice(0, 80),
              createdBy: actor!.userId,
              updatedBy: actor!.userId,
            })
            .returning();
          return row!;
        });
    const history = await this.history(conversation.id);
    const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: input.text }];

    const answer = await this.answer(messages);

    return this.db.tx(async (tx) => {
      const [question] = await tx
        .insert(assistantMessages)
        .values({
          tenantId,
          conversationId: conversation.id,
          role: 'user',
          text: input.text,
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        })
        .returning();
      const [reply] = await tx
        .insert(assistantMessages)
        .values({
          tenantId,
          conversationId: conversation.id,
          role: 'assistant',
          text: answer.text,
          toolCalls: answer.toolCalls,
          sources: answer.sources,
          open: answer.open,
          linkedRecords: answer.records,
          model: answer.tier,
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        })
        .returning();
      await tx
        .update(assistantConversations)
        .set({ lastAt: new Date(), updatedAt: new Date(), updatedBy: actor!.userId })
        .where(eq(assistantConversations.id, conversation.id));
      // Spec: questions and answers go to the audit log (ids only; the text stays in the conversation).
      await this.audit.record(tx, {
        action: 'create',
        table: 'assistant_message',
        recordId: question!.id,
      });
      await this.audit.record(tx, {
        action: 'create',
        table: 'assistant_message',
        recordId: reply!.id,
        fieldChanges: [
          {
            field: 'tools',
            from: null,
            to: answer.toolCalls.map((c) => `${c.tool}:${c.outcome}`).join(',') || null,
          },
        ],
      });
      return { conversationId: conversation.id, answer: view(reply!) };
    });
  }

  async conversations(): Promise<AssistantConversationSummary[]> {
    const actor = requireContext().actor!;
    const rows = await this.db.tx((tx) =>
      tx
        .select()
        .from(assistantConversations)
        .where(
          and(
            eq(assistantConversations.userId, actor.userId),
            isNull(assistantConversations.archivedAt),
          ),
        )
        .orderBy(desc(assistantConversations.lastAt))
        .limit(30),
    );
    return rows.map((c) => ({
      id: c.id,
      title: c.title,
      startedAt: c.startedAt.toISOString(),
      lastAt: c.lastAt.toISOString(),
    }));
  }

  async conversation(id: string): Promise<AssistantConversationView> {
    const conversation = await this.own(id);
    const rows = await this.db.tx((tx) =>
      tx
        .select()
        .from(assistantMessages)
        .where(eq(assistantMessages.conversationId, id))
        // A question and its answer share a timestamp: 'user' sorts after 'assistant', so descending role.
        .orderBy(asc(assistantMessages.createdAt), desc(assistantMessages.role)),
    );
    return {
      id: conversation.id,
      title: conversation.title,
      startedAt: conversation.startedAt.toISOString(),
      messages: rows.map(view),
    };
  }

  /** The model's loop: call tools until it answers, then apply the two checks. */
  private async answer(messages: Anthropic.MessageParam[]): Promise<{
    text: string;
    tier: ModelTier;
    toolCalls: ToolCallRecord[];
    sources: AssistantSource[];
    records: LinkedRecord[];
    open: AssistantOpen | null;
  }> {
    // Lookups run on the fast model; once a policy is involved, the reasoning model answers.
    let tier: ModelTier = 'lookup';
    let found = false;
    let policyAsked = false;
    const toolCalls: ToolCallRecord[] = [];
    const sources: AssistantSource[] = [];
    const records: LinkedRecord[] = [];
    let open: AssistantOpen | null = null;
    const system = SYSTEM.replace('{today}', businessDate(new Date()));
    const tools = this.tools.definitions();
    const done = (text: string) => ({ text, tier, toolCalls, sources, records, open });
    const dontKnow = async () => {
      const hr = await this.db.tx((tx) => this.settings.get(tx, 'hr_contact'));
      sources.length = 0;
      sources.push(hr);
      return done(DONT_KNOW_ANSWER);
    };

    for (let round = 0; round < MAX_ROUNDS; round++) {
      let response: Anthropic.Message;
      try {
        response = await this.llm.create({ tier, system, messages, tools });
      } catch (error) {
        if (error instanceof LlmUnavailable) return done(UNAVAILABLE_ANSWER);
        this.log.error(`Model call failed: ${error instanceof Error ? error.name : 'unknown'}`);
        return done(UNAVAILABLE_ANSWER);
      }
      if (response.stop_reason === 'refusal') return done(REFUSED_ANSWER);
      const uses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      if (response.stop_reason !== 'tool_use' || uses.length === 0) {
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (policyAsked && !found) return dontKnow();
        return done(this.checked(text, toolCalls, found));
      }
      messages.push({ role: 'assistant', content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        const input = (use.input ?? {}) as Record<string, unknown>;
        const outcome = await this.tools.run(use.name, input);
        toolCalls.push({ tool: use.name, input, outcome: outcome.outcome });
        if (use.name === 'policy_search') {
          policyAsked = true;
          tier = 'reasoning';
        }
        if (outcome.outcome === 'ok') {
          if (!outcome.result.empty) found = true;
          for (const s of outcome.result.sources) {
            if (!sources.some((x) => x.link === s.link)) sources.push(s);
          }
          records.push(...(outcome.result.records ?? []));
          if (outcome.result.open) open = outcome.result.open;
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: JSON.stringify(outcome.result.data),
          });
        } else {
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: JSON.stringify({ error: outcome.message }),
            is_error: true,
          });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    return done(NO_DATA_ANSWER);
  }

  /**
   * The checks that don't rely on the model (spec: numbers come from the system; runs as the user):
   * figures with no successful lookup behind them are not shown, and when every lookup was refused
   * the answer says so and nothing else.
   */
  private checked(text: string, calls: ToolCallRecord[], found: boolean): string {
    const ok = calls.some((c) => c.outcome === 'ok');
    if (calls.length > 0 && !ok && calls.some((c) => c.outcome === 'refused')) {
      return NO_ACCESS_ANSWER;
    }
    if (!text) return NO_DATA_ANSWER;
    if (!found && /\d/.test(text)) return NO_DATA_ANSWER;
    return text;
  }

  /** Earlier questions and answers of this conversation, as plain text. */
  private async history(conversationId: string): Promise<Anthropic.MessageParam[]> {
    const rows = await this.db.tx((tx) =>
      tx
        .select({ role: assistantMessages.role, text: assistantMessages.text })
        .from(assistantMessages)
        .where(eq(assistantMessages.conversationId, conversationId))
        .orderBy(desc(assistantMessages.createdAt), asc(assistantMessages.role))
        .limit(HISTORY),
    );
    return rows.reverse().map((r) => ({ role: r.role, content: r.text }));
  }

  /** A conversation of the signed-in user's; anyone else's is not found. */
  private async own(id: string) {
    const actor = requireContext().actor!;
    const [row] = await this.db.tx((tx) =>
      tx
        .select()
        .from(assistantConversations)
        .where(
          and(
            eq(assistantConversations.id, id),
            eq(assistantConversations.userId, actor.userId),
            isNull(assistantConversations.archivedAt),
          ),
        ),
    );
    if (!row) throw new NotFoundException();
    return row;
  }
}

function view(row: typeof assistantMessages.$inferSelect): AssistantMessageView {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    sources: row.sources,
    open: row.open ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
