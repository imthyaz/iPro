import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { OnboardingView } from '@ipro/shared';
import { ShiftsService } from '../attendance/shifts.service.js';
import { businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import { engagements } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { ChecklistsService } from '../workflow/checklists.service.js';

const DAY_MS = 86_400_000;

/**
 * The onboarding portal (E11) for the signed-in joiner: Day-1 details and checklist progress. KYC,
 * documents, tasks and policies come from their own endpoints, under the same own-scope permissions.
 */
@Injectable()
export class OnboardingService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(ShiftsService) private readonly shifts: ShiftsService,
    @Inject(ChecklistsService) private readonly checklists: ChecklistsService,
  ) {}

  /** For pre-joiners, and for joiners whose onboarding checklist is still open; otherwise null. */
  async mine(now = new Date()): Promise<OnboardingView | null> {
    const personId = requireContext().actor!.personId;
    if (!personId) return null;
    const summary = await this.people.summary(personId);
    const runs = (await this.checklists.runsFor(personId)).filter(
      (r) => r.stage === 'onboarding' && r.status !== 'cancelled',
    );
    const joining = summary.status === 'pre_joining';
    const stillOpen = runs.some((r) => r.status === 'open');
    if (!joining && !(summary.status === 'active' && stillOpen)) return null;

    const [engagement] = await this.db.tx((tx) =>
      tx
        .select({ contractEndDate: engagements.contractEndDate })
        .from(engagements)
        .where(eq(engagements.id, summary.engagementId)),
    );
    const [dayOne] = await this.shifts.workingDays(
      personId,
      summary.joiningDate,
      summary.joiningDate,
    );
    const today = businessDate(now);
    return {
      name: summary.preferredName ?? summary.legalName,
      status: joining ? 'pre_joining' : 'active',
      joiningDate: summary.joiningDate,
      daysToGo: Math.round((Date.parse(summary.joiningDate) - Date.parse(today)) / DAY_MS),
      endDate: engagement?.contractEndDate ?? null,
      designation: summary.designation?.title ?? null,
      department: summary.department?.name ?? null,
      location: summary.location?.name ?? null,
      manager: summary.manager?.name ?? null,
      dayOne: dayOne
        ? { startTime: dayOne.startTime, endTime: dayOne.endTime, shiftCode: dayOne.shiftCode }
        : null,
      checklists: runs.map((r) => ({
        runId: r.id,
        name: r.templateName,
        done: r.progress.done,
        total: r.progress.total,
        overdue: r.progress.overdue,
      })),
    };
  }
}
