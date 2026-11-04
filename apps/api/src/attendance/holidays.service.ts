import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import type { HolidayCalendarInput, HolidayCalendarView, HolidayInput } from '@ipro/shared';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { locationVersions } from '../org/org.schema.js';
import { inForce } from '../people/people.queries.js';
import { holidayCalendars, holidays } from './attendance.schema.js';

/**
 * Holiday calendars (A2; decisions #48, #66). Admins and HR head keep them; HR reads them. Which
 * location follows which calendar is part of the location's dated record (decision #21), changed
 * from a date in organisation setup; a shift allocation can choose a customer's calendar instead.
 */
@Injectable()
export class HolidaysService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(year?: number): Promise<HolidayCalendarView[]> {
    await this.assert('read');
    const calendars = await this.db.tx((tx) =>
      tx
        .select()
        .from(holidayCalendars)
        .where(isNull(holidayCalendars.deletedAt))
        .orderBy(asc(holidayCalendars.kind), asc(holidayCalendars.name)),
    );
    return Promise.all(calendars.map((c) => this.view(c.id, year)));
  }

  async create(input: HolidayCalendarInput): Promise<HolidayCalendarView> {
    await this.assert('create');
    const { actor, tenantId } = requireContext();
    const id = await this.db.tx(async (tx) => {
      const [existing] = await tx
        .select({ id: holidayCalendars.id })
        .from(holidayCalendars)
        .where(eq(holidayCalendars.code, input.code));
      if (existing) throw new ConflictException({ message: 'A calendar with this code exists' });
      const [row] = await tx
        .insert(holidayCalendars)
        .values({ tenantId, ...input, createdBy: actor!.userId, updatedBy: actor!.userId })
        .returning({ id: holidayCalendars.id });
      await this.audit.record(tx, {
        action: 'create',
        table: 'holiday_calendar',
        recordId: row!.id,
      });
      return row!.id;
    });
    return this.view(id);
  }

  async addHoliday(calendarId: string, input: HolidayInput): Promise<HolidayCalendarView> {
    await this.assert('update');
    const { actor, tenantId } = requireContext();
    await this.db.tx(async (tx) => {
      await this.load(tx, calendarId);
      const [clash] = await tx
        .select({ id: holidays.id })
        .from(holidays)
        .where(
          and(
            eq(holidays.calendarId, calendarId),
            eq(holidays.date, input.date),
            isNull(holidays.deletedAt),
          ),
        );
      if (clash)
        throw new ConflictException({ message: 'There is already a holiday on that date' });
      const [row] = await tx
        .insert(holidays)
        .values({
          tenantId,
          calendarId,
          ...input,
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        })
        .returning({ id: holidays.id });
      await this.audit.record(tx, {
        action: 'create',
        table: 'holiday',
        recordId: row!.id,
        fieldChanges: [{ field: 'date', to: input.date }],
      });
    });
    return this.view(calendarId, Number(input.date.slice(0, 4)));
  }

  /** Removing a holiday is a soft delete: the calendar's history stays. */
  async removeHoliday(calendarId: string, holidayId: string): Promise<HolidayCalendarView> {
    await this.assert('update');
    const actor = requireContext().actor!;
    const date = await this.db.tx(async (tx) => {
      await this.load(tx, calendarId);
      const [row] = await tx
        .select()
        .from(holidays)
        .where(and(eq(holidays.id, holidayId), eq(holidays.calendarId, calendarId)));
      if (!row || row.deletedAt) throw new NotFoundException();
      await tx
        .update(holidays)
        .set({ deletedAt: new Date(), updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(holidays.id, holidayId));
      await this.audit.record(tx, {
        action: 'delete',
        table: 'holiday',
        recordId: holidayId,
        fieldChanges: [{ field: 'date', from: row.date }],
      });
      return row.date;
    });
    return this.view(calendarId, Number(date.slice(0, 4)));
  }

  async get(calendarId: string, year?: number): Promise<HolidayCalendarView> {
    await this.assert('read');
    return this.view(calendarId, year);
  }

  private async view(calendarId: string, year?: number): Promise<HolidayCalendarView> {
    const today = businessDate(new Date());
    return this.db.tx(async (tx) => {
      const calendar = await this.load(tx, calendarId);
      const days = await tx
        .select()
        .from(holidays)
        .where(
          and(
            eq(holidays.calendarId, calendarId),
            isNull(holidays.deletedAt),
            year ? gte(holidays.date, `${year}-01-01`) : undefined,
            year ? lte(holidays.date, `${year}-12-31`) : undefined,
          ),
        )
        .orderBy(year ? asc(holidays.date) : desc(holidays.date));
      const placed = await tx
        .select({ id: locationVersions.locationId, name: locationVersions.name })
        .from(locationVersions)
        .where(
          and(
            eq(locationVersions.holidayCalendarId, calendarId),
            inForce(locationVersions.effectiveFrom, locationVersions.effectiveTo, today),
          ),
        )
        .orderBy(asc(locationVersions.name));
      return {
        id: calendar.id,
        code: calendar.code,
        name: calendar.name,
        kind: calendar.kind,
        holidays: days.map((d) => ({ id: d.id, date: d.date, name: d.name, optional: d.optional })),
        locations: placed,
      };
    });
  }

  private async load(tx: Tx, calendarId: string) {
    const [calendar] = await tx
      .select()
      .from(holidayCalendars)
      .where(eq(holidayCalendars.id, calendarId));
    if (!calendar || calendar.deletedAt) throw new NotFoundException();
    return calendar;
  }

  private assert(action: 'read' | 'create' | 'update') {
    return this.authz.assert(requireContext().actor!, action, { area: 'org_config' });
  }
}
