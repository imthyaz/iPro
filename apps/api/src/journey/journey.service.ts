import { Injectable } from '@nestjs/common';
import { requireContext } from '../context/request-context.js';
import type { Tx } from '../db/tenant-context.js';
import { journalEvents } from './journey.schema.js';

export interface JourneyEvent {
  engagementId: string;
  personId: string;
  eventType: string;
  category: string;
  occurredOn: string;
  isPlanned?: boolean;
  title: string;
  detail?: Record<string, unknown>;
  sensitivity: (typeof journalEvents.$inferInsert)['sensitivity'];
  sourceTable: string;
  sourceId: string;
}

/** The only writer of JournalEvent (ARCHITECTURE.md). Timeline queries arrive with slice 10. */
@Injectable()
export class JourneyService {
  /**
   * Records an event in the caller's transaction. The same source and type is recorded once only;
   * returns false if it was already there.
   */
  async record(tx: Tx, event: JourneyEvent): Promise<boolean> {
    const { tenantId, actor } = requireContext();
    const inserted = await tx
      .insert(journalEvents)
      .values({
        tenantId,
        engagementId: event.engagementId,
        personId: event.personId,
        eventType: event.eventType,
        category: event.category,
        occurredOn: event.occurredOn,
        isPlanned: event.isPlanned ?? false,
        title: event.title,
        detailJson: event.detail ?? {},
        sensitivity: event.sensitivity,
        sourceTable: event.sourceTable,
        sourceId: event.sourceId,
        createdBy: actor?.userId ?? null,
        updatedBy: actor?.userId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: journalEvents.id });
    return inserted.length > 0;
  }
}
