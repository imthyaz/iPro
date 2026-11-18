import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import type Anthropic from '@anthropic-ai/sdk';
import { isIndiaModelId } from '../config.js';

/**
 * Ask iPro's model connection (decision #88). Two tiers, both set in configuration: lookups on the
 * fast model (Haiku) and reasoning on the stronger one (Sonnet). Only India inference-profile ids
 * (`in.`) are ever called; the check here repeats the startup check so no code path can bypass it.
 */
export const LLM = Symbol('LLM');

export type ModelTier = 'lookup' | 'reasoning';

export interface LlmRequest {
  tier: ModelTier;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

export interface Llm {
  readonly name: 'fake' | 'bedrock' | 'none';
  create(request: LlmRequest): Promise<Anthropic.Message>;
}

export class LlmUnavailable extends Error {}

/** Effort per tier: lookups are short and quick; reasoning (policy, drafting) gets more room. */
const EFFORT: Record<ModelTier, 'low' | 'medium'> = { lookup: 'low', reasoning: 'medium' };

export class BedrockLlm implements Llm {
  readonly name = 'bedrock' as const;
  private readonly client: AnthropicBedrock;

  constructor(
    private readonly models: Record<ModelTier, string>,
    region: string,
  ) {
    for (const id of Object.values(models)) {
      if (!isIndiaModelId(id)) throw new Error('Only India inference profile ids (in.) allowed');
    }
    // Credentials come from the server's AWS role (ECS task role); none are passed here.
    this.client = new AnthropicBedrock({ awsRegion: region });
  }

  async create(request: LlmRequest): Promise<Anthropic.Message> {
    const model = this.models[request.tier];
    if (!isIndiaModelId(model)) throw new Error('Only India inference profile ids (in.) allowed');
    return this.client.messages.create({
      model,
      max_tokens: 16000,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      output_config: { effort: EFFORT[request.tier] },
    });
  }
}

export class NoLlm implements Llm {
  readonly name = 'none' as const;
  async create(): Promise<Anthropic.Message> {
    throw new LlmUnavailable('Ask iPro is turned off');
  }
}

/** What a scripted turn says: a tool call, or a final answer (which may quote earlier results). */
export type ScriptStep =
  | {
      tool: string;
      /** The tool input, or a function of the question. */
      input: Record<string, unknown> | ((question: string) => Record<string, unknown>);
    }
  | { text: string | ((results: unknown[]) => string) };

/**
 * The scripted model for local use and tests (ARCHITECTURE.md: llm fake). A script picks the steps
 * for a question; each call returns the next step. Unscripted questions get a fixed reply, so the
 * app runs without AWS. It never invents figures: answers are built only from tool results.
 */
export class ScriptedLlm implements Llm {
  readonly name = 'fake' as const;
  readonly requests: LlmRequest[] = [];
  private scripts: { match: RegExp; steps: ScriptStep[] }[] = [...DEV_SCRIPTS];

  /** Test helper: when a question matches, the model takes these steps. */
  script(match: RegExp, steps: ScriptStep[]): void {
    this.scripts.unshift({ match, steps });
  }

  reset(): void {
    this.scripts = [...DEV_SCRIPTS];
    this.requests.length = 0;
  }

  async create(request: LlmRequest): Promise<Anthropic.Message> {
    this.requests.push(request);
    const question = lastUserText(request.messages);
    const results = toolResultsSinceQuestion(request.messages);
    const steps = this.scripts.find((s) => s.match.test(question))?.steps ?? [
      { text: 'I can answer questions about your leave, attendance, team and policies.' },
    ];
    const step = steps[Math.min(results.length, steps.length - 1)]!;
    if ('tool' in step) {
      return message(
        request,
        [
          {
            type: 'tool_use',
            id: `toolu_fake_${results.length + 1}`,
            name: step.tool,
            input: typeof step.input === 'function' ? step.input(question) : step.input,
            caller: { type: 'direct' },
          } as Anthropic.ToolUseBlock,
        ],
        'tool_use',
      );
    }
    const text = typeof step.text === 'function' ? step.text(results) : step.text;
    return message(
      request,
      [{ type: 'text', text, citations: null } as Anthropic.TextBlock],
      'end_turn',
    );
  }
}

/**
 * A few lookups the scripted model answers out of the box, so Ask iPro can be tried locally (and in
 * end-to-end tests) without AWS. Each calls the real tool and states only what it returned.
 */
const DEV_SCRIPTS: { match: RegExp; steps: ScriptStep[] }[] = [
  {
    // "Apply LOP leave on 2026-12-02": the code and date are read from the question.
    match: /^apply .*leave/i,
    steps: [
      {
        tool: 'propose_leave',
        input: (question) => {
          const date = /\d{4}-\d{2}-\d{2}/.exec(question)?.[0] ?? '';
          const code = /\b(CL|EL|SL|LOP)\b/i.exec(question)?.[1] ?? 'CL';
          return { leaveType: code, from: date, to: date };
        },
      },
      { text: 'Here is the leave to apply. Nothing is sent until you tap Apply.' },
    ],
  },
  {
    match: /polic|carry forward|notice period/i,
    steps: [
      { tool: 'policy_search', input: (question) => ({ question }) },
      {
        text: ([r]) => {
          const top = (r as { clauses: { policy: string; clause: string | null; text: string }[] })
            .clauses[0];
          return top ? `${top.policy}${top.clause ? ` ${top.clause}` : ''}: ${top.text}` : '';
        },
      },
    ],
  },
  {
    match: /approvals? (are )?waiting/i,
    steps: [
      { tool: 'my_approvals', input: {} },
      {
        text: ([r]) => {
          const { count, overdue } = r as { count: number; overdue: number };
          const s = count === 1 ? '' : 's';
          return `You have ${count} approval${s} waiting${overdue ? `, ${overdue} overdue` : ''}.`;
        },
      },
    ],
  },
  {
    match: /leaves? (do i have|left)|my leave balance/i,
    steps: [
      { tool: 'my_leave_balances', input: {} },
      {
        text: ([r]) =>
          (r as { balances: { type: string; balance: number }[] }).balances
            .map((b) => `${b.type}: ${b.balance}`)
            .join('\n'),
      },
    ],
  },
  {
    match: /on leave today|off today/i,
    steps: [
      { tool: 'team_today', input: { scope: 'team' } },
      {
        text: ([r]) => {
          const n = (r as { counts: Record<string, number> }).counts.leave ?? 0;
          return `${n} ${n === 1 ? 'person is' : 'people are'} on leave today.`;
        },
      },
    ],
  },
];

function message(
  request: LlmRequest,
  content: Anthropic.ContentBlock[],
  stopReason: 'tool_use' | 'end_turn',
): Anthropic.Message {
  return {
    id: `msg_fake_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: `fake-${request.tier}`,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Message;
}

/** The text of the latest user question (not a tool-result turn). */
function lastUserText(messages: Anthropic.MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const text = m.content.find((b) => b.type === 'text');
    if (text && text.type === 'text') return text.text;
  }
  return '';
}

/** Parsed tool results after the latest question, oldest first. */
function toolResultsSinceQuestion(messages: Anthropic.MessageParam[]): unknown[] {
  const results: unknown[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') break;
    const blocks = m.content.filter((b) => b.type === 'tool_result');
    if (blocks.length === 0) break;
    for (const b of blocks.reverse()) {
      const raw = typeof b.content === 'string' ? b.content : '';
      try {
        results.unshift(JSON.parse(raw));
      } catch {
        results.unshift(raw);
      }
    }
  }
  return results;
}
