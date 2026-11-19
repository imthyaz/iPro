import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import type { AssistantArchiveView } from '@ipro/shared';
import { AuditService } from '../audit/audit.service.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import { personName } from '../workflow/lookups.js';
import {
  assistantActions,
  assistantConversations,
  assistantMessages,
  assistantSummaries,
  type ArchivedAction,
  type LinkedRecord,
} from './assistant.schema.js';

/** Spec: full conversations are kept for 180 days. */
export const KEEP_DAYS = 180;

/** Each tool, as the topic a person would name. */
const TOPIC_OF: Record<string, string> = {
  my_leave_balances: 'Leave',
  person_leave_balances: 'Leave',
  my_leave_requests: 'Leave',
  propose_leave: 'Leave',
  my_approvals: 'Approvals',
  propose_approvals: 'Approvals',
  team_on_date: 'Team',
  team_today: 'Team',
  hybrid_compliance: 'Hybrid',
  attendance_month: 'Attendance',
  probation_dashboard: 'Probation',
  find_people: 'People',
  person_journey: 'People',
  joiners_and_leavers: 'People',
  policy_search: 'Policies',
  propose_letter: 'Letters',
};

const ACTION_WORDS: Record<ArchivedAction['kind'], string> = {
  apply_leave: 'applied for leave',
  approve_leave: 'approved leave',
  draft_letter: 'drafted a letter',
};

/**
 * The 180-day retention of Ask iPro (spec; decision #92). A conversation with no message for 180
 * days is replaced by a summary of what it was about (topics), who and what it referred to, and
 * what was confirmed in it; its questions, answers and cards are then deleted. Confirmed actions
 * stay in the audit log either way. The summary is built from what iPro recorded, not by the model,
 * so old conversations never go back to it.
 */
@Injectable()
export class AssistantRetentionService {
  private readonly log = new Logger('AskIproRetention');

  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Daily, as the system: archives every conversation idle for 180 days. Safe to run again. */
  async run(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000);
    const due = await this.db.tx((tx) =>
      tx
        .select({ id: assistantConversations.id })
        .from(assistantConversations)
        .where(
          and(isNull(assistantConversations.archivedAt), lt(assistantConversations.lastAt, cutoff)),
        )
        .limit(500),
    );
    for (const { id } of due) await this.archiveOne(id, now);
    if (due.length) this.log.log(`Archived ${due.length} conversations`);
    return due.length;
  }

  private async archiveOne(conversationId: string, now: Date): Promise<void> {
    const { tenantId } = requireContext();
    await this.db.tx(async (tx) => {
      const [conversation] = await tx
        .select()
        .from(assistantConversations)
        .where(eq(assistantConversations.id, conversationId));
      if (!conversation || conversation.archivedAt) return;
      const messages = await tx
        .select({
          toolCalls: assistantMessages.toolCalls,
          linkedRecords: assistantMessages.linkedRecords,
        })
        .from(assistantMessages)
        .where(eq(assistantMessages.conversationId, conversationId));
      const actions = await tx
        .select({
          kind: assistantActions.kind,
          status: assistantActions.status,
          expiresAt: assistantActions.expiresAt,
        })
        .from(assistantActions)
        .where(eq(assistantActions.conversationId, conversationId));

      const topics = [
        ...new Set(
          messages.flatMap((m) =>
            m.toolCalls.map((c) => TOPIC_OF[c.tool]).filter((t): t is string => Boolean(t)),
          ),
        ),
      ];
      const seen = new Set<string>();
      const records: LinkedRecord[] = [];
      for (const r of messages.flatMap((m) => m.linkedRecords)) {
        const key = `${r.type}:${r.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          records.push(r);
        }
      }
      const archived: ArchivedAction[] = actions.map((a) => ({
        kind: a.kind,
        status:
          a.status === 'confirmed' || a.status === 'cancelled' || a.status === 'failed'
            ? a.status
            : 'expired',
      }));
      const confirmed = archived.filter((a) => a.status === 'confirmed');
      const summary = [
        topics.length
          ? `Asked about ${listWords(topics.map((t) => t.toLowerCase()))}`
          : 'A conversation',
        confirmed.length
          ? `; ${listWords([...new Set(confirmed.map((a) => ACTION_WORDS[a.kind]))])}`
          : '',
        '.',
      ].join('');

      await tx.insert(assistantSummaries).values({
        tenantId,
        conversationId,
        userId: conversation.userId,
        summary,
        topics,
        linkedRecords: records,
        actions: archived,
        startedAt: conversation.startedAt,
        lastAt: conversation.lastAt,
      });
      // The answers refer to their cards, so the answers go first.
      await tx
        .delete(assistantMessages)
        .where(eq(assistantMessages.conversationId, conversationId));
      await tx.delete(assistantActions).where(eq(assistantActions.conversationId, conversationId));
      await tx
        .update(assistantConversations)
        .set({
          // The title was the first question's words: it goes with the text.
          title: topics.length ? topics.join(', ') : 'Archived conversation',
          archivedAt: now,
          updatedAt: now,
        })
        .where(eq(assistantConversations.id, conversationId));
      await this.audit.record(tx, {
        action: 'delete',
        table: 'assistant_conversation',
        recordId: conversationId,
        fieldChanges: [
          { field: 'messages', from: messages.length, to: 0 },
          { field: 'actions', from: actions.length, to: 0 },
        ],
      });
    });
  }

  /** The signed-in user's archived conversations, newest first; q matches topics or people. */
  async archived(q?: string): Promise<AssistantArchiveView[]> {
    const actor = requireContext().actor!;
    return this.db.tx(async (tx) => {
      const rows = await tx
        .select({
          summary: assistantSummaries,
          archivedAt: assistantConversations.archivedAt,
        })
        .from(assistantSummaries)
        .innerJoin(
          assistantConversations,
          eq(assistantConversations.id, assistantSummaries.conversationId),
        )
        .where(eq(assistantSummaries.userId, actor.userId))
        .orderBy(desc(assistantSummaries.lastAt))
        .limit(200);
      const views: AssistantArchiveView[] = [];
      for (const { summary: s, archivedAt } of rows) {
        const personIds = [
          ...new Set(s.linkedRecords.filter((r) => r.type === 'person').map((r) => r.id)),
        ];
        const people = await Promise.all(
          personIds.map(async (personId) => ({ personId, name: await personName(tx, personId) })),
        );
        views.push({
          id: s.id,
          summary: s.summary,
          topics: s.topics,
          people,
          actions: s.actions,
          startedAt: s.startedAt.toISOString(),
          lastAt: s.lastAt.toISOString(),
          archivedAt: (archivedAt ?? s.createdAt).toISOString(),
        });
      }
      const needle = q?.trim().toLowerCase();
      if (!needle) return views;
      return views.filter(
        (v) =>
          v.summary.toLowerCase().includes(needle) ||
          v.topics.some((t) => t.toLowerCase().includes(needle)) ||
          v.people.some((p) => p.name.toLowerCase().includes(needle)),
      );
    });
  }
}

/** ["leave", "team", "policies"] → "leave, team and policies". */
function listWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
