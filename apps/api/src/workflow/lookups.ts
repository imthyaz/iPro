import { and, arrayContains, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { isRequiredTopic, topicOf, type Role } from '@ipro/shared';
import { requireContext } from '../context/request-context.js';
import type { Tx } from '../db/tenant-context.js';
import { appUsers, roleAssignments } from '../identity/identity.schema.js';
import { persons } from '../people/people.schema.js';
import { channelsFor } from '../notify/delivery-rules.js';
import { notificationDeliveries } from '../notify/notify.schema.js';
import { notificationPreferences, notifications } from './workflow.schema.js';

/** Shared by the workflow engine and checklists: who manages whom, who holds a role, names, notices. */

/** The sign-in user of the person's solid-line manager on a date, if they have one. */
export async function managerUserOfPerson(
  tx: Tx,
  personId: string,
  day: string,
): Promise<string | null> {
  const result = await tx.execute<{ user_id: string }>(sql`
    select u.id as user_id
    from engagement e
    -- Someone not yet joined reports to the manager on their planned first assignment (decision #54).
    cross join lateral (
      select case when e.status in ('offered', 'pre_joining')
        then greatest(${day}::date, e.joining_date) else ${day}::date end as on_day
    ) d
    join assignment a on a.engagement_id = e.id
      and a.effective_from <= d.on_day and (a.effective_to is null or a.effective_to >= d.on_day)
    join engagement me on me.id = a.manager_engagement_id
    join app_user u on u.person_id = me.person_id and u.status = 'active'
    where e.person_id = ${personId} and e.status in ('offered', 'pre_joining', 'active', 'on_notice')
    limit 1
  `);
  return result.rows[0]?.user_id ?? null;
}

export async function managerUserOfUser(
  tx: Tx,
  userId: string,
  day: string,
): Promise<string | null> {
  const [user] = await tx
    .select({ personId: appUsers.personId })
    .from(appUsers)
    .where(eq(appUsers.id, userId));
  return user?.personId ? managerUserOfPerson(tx, user.personId, day) : null;
}

/** Active users holding a role for a legal entity (or for every entity). */
export async function roleHolders(
  tx: Tx,
  role: Role,
  legalEntityId: string | null,
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ userId: roleAssignments.userId })
    .from(roleAssignments)
    .innerJoin(appUsers, eq(appUsers.id, roleAssignments.userId))
    .where(
      and(
        eq(roleAssignments.role, role),
        isNull(roleAssignments.deletedAt),
        eq(appUsers.status, 'active'),
        legalEntityId
          ? or(
              isNull(roleAssignments.legalEntityId),
              eq(roleAssignments.legalEntityId, legalEntityId),
            )
          : isNull(roleAssignments.legalEntityId),
      ),
    );
  return rows.map((r) => r.userId);
}

/** The sign-in user linked to a person, if any. */
export async function userOfPerson(tx: Tx, personId: string): Promise<string | null> {
  const [user] = await tx
    .select({ id: appUsers.id })
    .from(appUsers)
    .where(and(eq(appUsers.personId, personId), eq(appUsers.status, 'active')));
  return user?.id ?? null;
}

export async function userName(tx: Tx, userId: string): Promise<string> {
  const [user] = await tx
    .select({ name: appUsers.displayName })
    .from(appUsers)
    .where(eq(appUsers.id, userId));
  return user?.name ?? 'Unknown user';
}

export async function personName(tx: Tx, personId: string): Promise<string> {
  const [person] = await tx
    .select({ legalName: persons.legalName, preferredName: persons.preferredName })
    .from(persons)
    .where(eq(persons.id, personId));
  return person ? (person.preferredName ?? person.legalName) : 'Unknown person';
}

/** In-app notifications (the outbox Teams and email deliver from in slice 11). */
/**
 * Notifies people in-app and queues Teams and email delivery (decision #87). Someone who switched
 * the kind's topic off gets nothing; approvals and compliance items can't be switched off. An
 * approval id makes the Teams message an actionable card; a dedupe key sends a notice only once.
 */
export async function notify(
  tx: Tx,
  userIds: string[],
  kind: string,
  title: string,
  link: string,
  options: { approvalId?: string; dedupeKey?: string } = {},
) {
  let unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  const { tenantId } = requireContext();
  const topic = topicOf(kind);
  if (!isRequiredTopic(topic)) {
    const muted = await tx
      .select({ userId: notificationPreferences.userId })
      .from(notificationPreferences)
      .where(
        and(
          inArray(notificationPreferences.userId, unique),
          arrayContains(notificationPreferences.offTopics, [topic]),
        ),
      );
    const off = new Set(muted.map((m) => m.userId));
    unique = unique.filter((id) => !off.has(id));
    if (unique.length === 0) return;
  }
  const rows = await tx
    .insert(notifications)
    .values(
      unique.map((recipientUserId) => ({
        tenantId,
        recipientUserId,
        kind,
        title,
        link,
        approvalId: options.approvalId ?? null,
        dedupeKey: options.dedupeKey ?? null,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: notifications.id, recipientUserId: notifications.recipientUserId });
  if (rows.length === 0) return;
  // Teams by default; email for pre-joiners and for anyone who asked for a copy.
  const people = await tx.execute<{ id: string; email_copy: boolean; pre_joiner: boolean }>(sql`
    select u.id,
      coalesce(p.email_copy, false) as email_copy,
      (exists (select 1 from engagement e where e.person_id = u.person_id
                and e.status in ('offered', 'pre_joining'))
       and not exists (select 1 from engagement e where e.person_id = u.person_id
                and e.status in ('active', 'on_notice'))) as pre_joiner
    from app_user u
    left join notification_preference p on p.user_id = u.id
    where u.id in (${sql.join(
      rows.map((r) => sql`${r.recipientUserId}`),
      sql`, `,
    )})`);
  const byUser = new Map(people.rows.map((p) => [p.id, p]));
  const deliveries = rows.flatMap((row) => {
    const person = byUser.get(row.recipientUserId);
    return channelsFor({
      preJoiner: person?.pre_joiner ?? false,
      emailCopy: person?.email_copy ?? false,
    }).map((channel) => ({
      tenantId,
      notificationId: row.id,
      recipientUserId: row.recipientUserId,
      channel,
    }));
  });
  await tx.insert(notificationDeliveries).values(deliveries).onConflictDoNothing();
}

const roleLabels: Record<string, string> = {
  hr: 'HR',
  hr_head: 'HR head',
  manager: 'Managers',
  cxo: 'CXO',
  admin: 'Admins',
  employee: 'Employees',
};
export const roleLabel = (role: string | null) => (role ? (roleLabels[role] ?? role) : '—');
