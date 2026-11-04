import { and, eq, isNull } from 'drizzle-orm';
import * as schema from './schema.js';
import { SEED_ORG } from './seed-org.js';
import type { Tx } from './tenant-context.js';

/** Fixed id so the dev seed stays idempotent. */
const CHENNAI_CALENDAR = '00000000-0000-4000-8000-000000001801';

/**
 * Dev only: a Chennai company calendar with India's national holidays and a few Tamil Nadu ones
 * (public dates, not personal data), followed by the Chennai office. Ideassion's real list comes from
 * the policy workshop (open questions). Tests seed their own calendars.
 */
export async function seedHolidays(tx: Tx, tenantId: string, year: number): Promise<void> {
  await tx
    .insert(schema.holidayCalendars)
    .values({ id: CHENNAI_CALENDAR, tenantId, code: 'CHN', name: 'Chennai', kind: 'company' })
    .onConflictDoNothing();
  const days: [string, string, boolean][] = [
    [`${year}-01-01`, 'New Year’s Day', true],
    [`${year}-01-15`, 'Pongal', false],
    [`${year}-01-26`, 'Republic Day', false],
    [`${year}-05-01`, 'May Day', false],
    [`${year}-08-15`, 'Independence Day', false],
    [`${year}-10-02`, 'Gandhi Jayanti', false],
    [`${year}-12-25`, 'Christmas', true],
  ];
  for (const [date, name, optional] of days) {
    const [existing] = await tx
      .select({ id: schema.holidays.id })
      .from(schema.holidays)
      .where(
        and(
          eq(schema.holidays.calendarId, CHENNAI_CALENDAR),
          eq(schema.holidays.date, date),
          isNull(schema.holidays.deletedAt),
        ),
      );
    if (!existing) {
      await tx
        .insert(schema.holidays)
        .values({ tenantId, calendarId: CHENNAI_CALENDAR, date, name, optional });
    }
  }
  // Seed setup only: point the Chennai office's first version at the calendar if nothing is set.
  await tx
    .update(schema.locationVersions)
    .set({ holidayCalendarId: CHENNAI_CALENDAR })
    .where(
      and(
        eq(schema.locationVersions.locationId, SEED_ORG.chennai),
        isNull(schema.locationVersions.holidayCalendarId),
      ),
    );
}
