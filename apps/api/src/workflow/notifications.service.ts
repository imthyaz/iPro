import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  notificationTopics,
  topicOf,
  type NotificationPreferencesInput,
  type NotificationPreferencesView,
  type NotificationTopic,
  type NotificationView,
} from '@ipro/shared';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { notificationPreferences, notifications } from './workflow.schema.js';

/**
 * X1 Notifications (slice 11): a person's own in-app list and what they want to hear about. Each
 * person sees and changes only their own; there is nothing here about anyone else.
 */
@Injectable()
export class NotificationsService {
  constructor(@Inject(TenantDb) private readonly db: TenantDb) {}

  async mine(): Promise<NotificationView[]> {
    const actor = requireContext().actor!;
    const rows = await this.db.tx((tx) =>
      tx
        .select()
        .from(notifications)
        .where(eq(notifications.recipientUserId, actor.userId))
        .orderBy(desc(notifications.createdAt))
        .limit(100),
    );
    return rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      topic: topicOf(n.kind),
      title: n.title,
      link: n.link,
      createdAt: n.createdAt.toISOString(),
      read: n.readAt !== null,
    }));
  }

  async markRead(notificationId: string): Promise<void> {
    const actor = requireContext().actor!;
    await this.db.tx((tx) =>
      tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.id, notificationId),
            eq(notifications.recipientUserId, actor.userId),
          ),
        ),
    );
  }

  async markAllRead(): Promise<void> {
    const actor = requireContext().actor!;
    await this.db.tx((tx) =>
      tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.recipientUserId, actor.userId), isNull(notifications.readAt))),
    );
  }

  async preferences(): Promise<NotificationPreferencesView> {
    const actor = requireContext().actor!;
    return this.db.tx((tx) => this.viewOf(tx, actor.userId));
  }

  async savePreferences(input: NotificationPreferencesInput): Promise<NotificationPreferencesView> {
    const { actor, tenantId } = requireContext();
    const off = [...new Set(input.off)];
    for (const key of off) {
      if (notificationTopics.find((t) => t.key === key)?.required) {
        throw new BadRequestException({ message: 'Approvals and compliance items stay on' });
      }
    }
    return this.db.tx(async (tx) => {
      await tx
        .insert(notificationPreferences)
        .values({
          tenantId,
          userId: actor!.userId,
          offTopics: off,
          emailCopy: input.emailCopy,
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        })
        .onConflictDoUpdate({
          target: [notificationPreferences.tenantId, notificationPreferences.userId],
          set: {
            offTopics: off,
            emailCopy: input.emailCopy,
            updatedAt: new Date(),
            updatedBy: actor!.userId,
          },
        });
      return this.viewOf(tx, actor!.userId);
    });
  }

  private async viewOf(tx: Tx, userId: string): Promise<NotificationPreferencesView> {
    const [row] = await tx
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId));
    const off = new Set<NotificationTopic>((row?.offTopics ?? []) as NotificationTopic[]);
    return {
      topics: notificationTopics.map((t) => ({
        key: t.key,
        label: t.label,
        description: t.description,
        required: t.required,
        on: t.required || !off.has(t.key),
      })),
      emailCopy: row?.emailCopy ?? false,
    };
  }
}
