import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type {
  CtcSegment,
  PersonTimelineView,
  TimelineCategory,
  TimelineEvent,
  TimelineSegment,
} from '@ipro/shared';
import { AuditService, FIELD_CIPHER } from '../audit/audit.service.js';
import type { FieldCipher } from '../audit/field-cipher.js';
import { AuthzService } from '../authz/authz.service.js';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { departmentVersions, designations } from '../org/org.schema.js';
import { inForce } from '../people/people.queries.js';
import { assignments, compensations, engagements } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { JourneyService } from './journey.service.js';
import { probationEnd } from './planned-events.js';
import { journalEvents } from './journey.schema.js';

type EventRow = typeof journalEvents.$inferSelect;
type EngagementRow = typeof engagements.$inferSelect;

const LEAVE_TYPES = new Set([
  'leave_approved',
  'leave_cancelled',
  'leave_revoked',
  'comp_off_granted',
  'attendance_regularised',
  'hybrid_exception_approved',
  'shift_changed',
]);
const RECORD_TYPES = new Set(['letter_issued', 'profile_changed']);

/** Which display category an event shows in (design palette; decision #84). */
export function categoryOf(
  event: Pick<EventRow, 'eventType' | 'category' | 'detailJson'>,
): TimelineCategory {
  if (event.eventType === 'compensation_changed' || event.category === 'pay') return 'pay';
  if (event.eventType === 'assignment_changed') {
    const changed = (event.detailJson as { changed?: string[] }).changed ?? [];
    return changed.includes('designationId') ? 'career' : 'team';
  }
  if (
    LEAVE_TYPES.has(event.eventType) ||
    event.category === 'leave' ||
    event.category === 'attendance'
  ) {
    return 'leave';
  }
  if (RECORD_TYPES.has(event.eventType)) return 'records';
  return 'lifecycle';
}

/** Detail keys that are safe to show, with their labels; anything else stays out of the panel. */
const FACT_LABELS: Record<string, string> = {
  lastWorkingDate: 'Last working day',
  proposedLastDay: 'Last day proposed',
  from: 'From',
  to: 'To',
  days: 'Days',
  probationEndDate: 'Probation end',
  years: 'Years',
  workedOn: 'Worked on',
  validUntil: 'Usable until',
};
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const long = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const fmt = (v: unknown) =>
  typeof v === 'string' && ISO.test(v) ? long.format(new Date(`${v}T00:00:00Z`)) : String(v);

function facts(detail: Record<string, unknown>): [string, string][] {
  return Object.entries(detail)
    .filter(([k, v]) => FACT_LABELS[k] && v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [FACT_LABELS[k]!, fmt(v)]);
}

function linkOf(row: EventRow): string | null {
  if (row.sourceTable === 'workflow_instance') return `/requests/${row.sourceId}`;
  if (row.sourceTable === 'exit_case') return `/exits/${row.sourceId}`;
  return null;
}

/** Consecutive segments with the same label become one. */
function merge(segments: TimelineSegment[]): TimelineSegment[] {
  const out: TimelineSegment[] = [];
  for (const s of segments) {
    const last = out.at(-1);
    if (last && last.label === s.label && last.to !== null && addDays(last.to, 1) === s.from) {
      last.to = s.to;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

function tenure(from: string, to: string) {
  const [y1, m1, d1] = from.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = to.split('-').map(Number) as [number, number, number];
  let years = y2 - y1;
  let months = m2 - m1;
  let days = d2 - d1;
  if (days < 0) {
    months -= 1;
    days += new Date(Date.UTC(y2, m2 - 1, 0)).getUTCDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return { years: Math.max(0, years), months: Math.max(0, months), days: Math.max(0, days) };
}

const anniversaryOn = (joining: string, n: number) => {
  const [y, m, d] = joining.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
  return `${y + n}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};

/**
 * Journey timelines (slice 10; decision #84). Read only from the journal: events in the viewer's
 * sensitivity, planned ones until they happen or are overtaken; lanes from the effective-dated
 * history; the CTC lane only for those who may read the person's pay, one audit entry per view.
 */
@Injectable()
export class TimelineService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(JourneyService) private readonly journey: JourneyService,
  ) {}

  async personTimeline(personId: string, now = new Date()): Promise<PersonTimelineView> {
    const actor = requireContext().actor!;
    const today = businessDate(now);
    const summary = await this.people.summary(personId);
    const resource = { subjectPersonId: personId, legalEntityId: summary.legalEntityId };
    await this.authz.assert(actor, 'read', { area: 'journey_public', ...resource });
    const sensitive = (
      await this.authz.check(actor, 'read', { area: 'journey_sensitive', ...resource })
    ).allowed;
    const readsPay = (await this.authz.check(actor, 'read', { area: 'compensation', ...resource }))
      .allowed;

    return this.db.tx(async (tx) => {
      const engs = await tx
        .select()
        .from(engagements)
        .where(eq(engagements.personId, personId))
        .orderBy(asc(engagements.joiningDate));
      const rows = await tx
        .select()
        .from(journalEvents)
        .where(eq(journalEvents.personId, personId))
        .orderBy(asc(journalEvents.occurredOn), asc(journalEvents.createdAt));
      const events = visibleEvents(rows, sensitive, today);
      const lanes = {
        designation: await this.designationLane(tx, engs),
        team: await this.teamLane(tx, engs),
        status: this.statusLane(engs),
        ctc: readsPay ? await this.ctcLane(tx, engs, personId) : null,
      };
      const current = engs.find((e) => e.id === summary.engagementId) ?? engs.at(-1)!;
      const first = engs[0]?.joiningDate ?? current.joiningDate;
      const end =
        current.status === 'exited' && current.lastWorkingDate ? current.lastWorkingDate : today;
      const ctc = lanes.ctc;
      return {
        today,
        person: {
          personId,
          name: summary.preferredName ?? summary.legalName,
          employeeCode: summary.employeeCode,
          designation: summary.designation?.title ?? null,
          department: summary.department?.name ?? null,
          location: summary.location?.name ?? null,
          status: current.status,
          onProbation: current.probationEndDate !== null && current.confirmationDate === null,
          joiningDate: first,
          lastWorkingDate: current.lastWorkingDate,
        },
        events,
        lanes,
        tiles: {
          tenure: tenure(first, end < first ? first : end),
          designations: new Set(lanes.designation.map((s) => s.label)).size,
          designationChanges: Math.max(0, lanes.designation.length - 1),
          teams: new Set(lanes.team.map((s) => s.label)).size,
          ctcGrowth:
            ctc && ctc.length
              ? {
                  fromPaise: ctc[0]!.amountPaise,
                  toPaise: ctc.at(-1)!.amountPaise,
                  revisions: ctc.length - 1,
                }
              : null,
        },
      };
    });
  }

  /**
   * The nightly job (decision #84): the next work anniversary is written as a planned event, and
   * one whose day has come is marked as happened. A probation without a decision gets its planned end.
   */
  async planAhead(now = new Date()): Promise<{ planned: number }> {
    const today = businessDate(now);
    return this.db.tx(async (tx) => {
      const due = await tx
        .select()
        .from(journalEvents)
        .where(
          and(
            eq(journalEvents.eventType, 'work_anniversary'),
            eq(journalEvents.isPlanned, true),
            lte(journalEvents.occurredOn, today),
          ),
        );
      for (const row of due) {
        await this.journey.markHappened(tx, row.sourceTable, row.sourceId, row.eventType);
      }
      const engs = await tx
        .select()
        .from(engagements)
        .where(inArray(engagements.status, ['active', 'on_notice']));
      let planned = 0;
      for (const e of engs) {
        let n = 1;
        while (anniversaryOn(e.joiningDate, n) <= today) n++;
        const on = anniversaryOn(e.joiningDate, n);
        if (!e.lastWorkingDate || on <= e.lastWorkingDate) {
          const added = await this.journey.record(tx, {
            engagementId: e.id,
            personId: e.personId,
            eventType: 'work_anniversary',
            category: 'lifecycle',
            occurredOn: on,
            isPlanned: true,
            title: `${n} ${n === 1 ? 'year' : 'years'} at the company`,
            detail: { years: n },
            sensitivity: 'public',
            sourceTable: `anniversary_${n}`,
            sourceId: e.id,
          });
          if (added) planned++;
        }
        if (e.probationEndDate && !e.confirmationDate) {
          await this.journey.record(
            tx,
            probationEnd({
              engagementId: e.id,
              personId: e.personId,
              probationEndDate: e.probationEndDate,
            }),
          );
        }
      }
      return { planned };
    });
  }

  // ---- Internals ----

  private async designationLane(tx: Tx, engs: EngagementRow[]): Promise<TimelineSegment[]> {
    if (engs.length === 0) return [];
    const rows = await tx
      .select({
        from: assignments.effectiveFrom,
        to: assignments.effectiveTo,
        title: designations.title,
      })
      .from(assignments)
      .innerJoin(designations, eq(designations.id, assignments.designationId))
      .where(
        inArray(
          assignments.engagementId,
          engs.map((e) => e.id),
        ),
      )
      .orderBy(asc(assignments.effectiveFrom));
    return merge(rows.map((r) => ({ label: r.title, from: r.from, to: r.to })));
  }

  private async teamLane(tx: Tx, engs: EngagementRow[]): Promise<TimelineSegment[]> {
    if (engs.length === 0) return [];
    const rows = await tx
      .select({
        from: assignments.effectiveFrom,
        to: assignments.effectiveTo,
        departmentId: assignments.departmentId,
      })
      .from(assignments)
      .where(
        inArray(
          assignments.engagementId,
          engs.map((e) => e.id),
        ),
      )
      .orderBy(asc(assignments.effectiveFrom));
    const out: TimelineSegment[] = [];
    for (const r of rows) {
      const [name] = await tx
        .select({ name: departmentVersions.name })
        .from(departmentVersions)
        .where(
          and(
            eq(departmentVersions.departmentId, r.departmentId),
            inForce(departmentVersions.effectiveFrom, departmentVersions.effectiveTo, r.from),
          ),
        );
      out.push({ label: name?.name ?? 'Department', from: r.from, to: r.to });
    }
    return merge(out);
  }

  /** Probation, confirmed, notice, exited, per engagement. */
  private statusLane(engs: EngagementRow[]): TimelineSegment[] {
    const out: TimelineSegment[] = [];
    for (const e of engs) {
      if (e.status === 'offered' || e.status === 'pre_joining' || e.status === 'withdrawn')
        continue;
      const noticeFrom = e.resignationDate && e.lastWorkingDate ? e.resignationDate : null;
      const until = (d: string | null) => (d ? addDays(d, -1) : null);
      if (e.probationEndDate) {
        const confirmed = e.confirmationDate;
        const probationTo = confirmed ? until(confirmed) : (until(noticeFrom) ?? null);
        out.push({ label: 'On probation', from: e.joiningDate, to: probationTo });
        if (confirmed) {
          out.push({ label: 'Confirmed', from: confirmed, to: until(noticeFrom) });
        }
      } else {
        out.push({ label: 'Active', from: e.joiningDate, to: until(noticeFrom) });
      }
      if (noticeFrom) {
        out.push({ label: 'Serving notice', from: noticeFrom, to: e.lastWorkingDate });
      }
    }
    return out;
  }

  /** Pay over time, decrypted once per view with one audit entry (decision #84). */
  private async ctcLane(tx: Tx, engs: EngagementRow[], personId: string): Promise<CtcSegment[]> {
    if (engs.length === 0) return [];
    const rows = await tx
      .select()
      .from(compensations)
      .where(
        inArray(
          compensations.engagementId,
          engs.map((e) => e.id),
        ),
      )
      .orderBy(asc(compensations.effectiveFrom));
    if (rows.length === 0) return [];
    const { tenantId } = requireContext();
    const out: CtcSegment[] = [];
    for (const r of rows) {
      out.push({
        amountPaise: await this.cipher.decrypt(tenantId, r.amountEncrypted, {
          table: 'compensation',
          column: 'amount_encrypted',
          recordId: r.id,
        }),
        rateUnit: r.rateUnit,
        from: r.effectiveFrom,
        to: r.effectiveTo,
      });
    }
    await this.audit.record(tx, {
      action: 'view',
      table: 'compensation',
      recordId: rows.at(-1)!.id,
      subjectPersonId: personId,
      fieldChanges: [{ field: 'amount_encrypted', sensitive: true }],
    });
    return out;
  }
}

/**
 * Events in the viewer's sensitivity (public and manager for anyone who may read the journey; HR
 * and restricted with journey_sensitive), planned ones only while they stand.
 */
export function visibleEvents(
  rows: EventRow[],
  sensitive: boolean,
  today: string,
): TimelineEvent[] {
  const has = (type: string, engagementId: string) =>
    rows.some((r) => r.eventType === type && r.engagementId === engagementId && !r.isPlanned);
  return rows
    .filter((r) => sensitive || r.sensitivity === 'public' || r.sensitivity === 'manager')
    .filter((r) => r.eventType !== 'conversion_scheduled' || r.occurredOn > today)
    .filter((r) => {
      if (!r.isPlanned) return true;
      if (r.eventType === 'probation_end') {
        if (
          has('probation_confirmed', r.engagementId) ||
          has('probation_terminated', r.engagementId)
        ) {
          return false;
        }
        // An extension plans a new end; only the latest stands.
        return !rows.some(
          (o) =>
            o.isPlanned &&
            o.eventType === 'probation_end' &&
            o.engagementId === r.engagementId &&
            o.occurredOn > r.occurredOn,
        );
      }
      if (r.eventType === 'last_working_day') {
        return !rows.some(
          (o) =>
            o.eventType === 'resignation_withdrawn' &&
            o.sourceTable === r.sourceTable &&
            o.sourceId === r.sourceId,
        );
      }
      return true;
    })
    .map((r) => ({
      id: r.id,
      type: r.eventType,
      category: categoryOf(r),
      title: r.title,
      date: r.occurredOn,
      upcoming: r.occurredOn > today || (r.isPlanned && r.occurredOn >= today),
      planned: r.isPlanned,
      overdue: r.isPlanned && r.occurredOn < today,
      facts: facts(r.detailJson ?? {}),
      link: linkOf(r),
    }));
}
