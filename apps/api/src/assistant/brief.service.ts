import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext, runWithContext, type Actor } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import { appUsers, roleAssignments } from '../identity/identity.schema.js';
import { UsersService } from '../identity/users.service.js';
import { CheckInsService } from '../reviews/check-ins.service.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import { ChecklistsService } from '../workflow/checklists.service.js';
import { notify } from '../workflow/lookups.js';
import { WorkflowService } from '../workflow/workflow.service.js';

/** Who gets the brief (spec: each manager and HR user). */
const BRIEFED = ['manager', 'hr', 'hr_head'] as const;

export interface BriefCounts {
  approvals: number;
  approvalsOverdue: number;
  tasks: number;
  tasksOverdue: number;
  reviews: number;
  reviewsOverdue: number;
  probationsEnding: number | null;
}

/**
 * One line, figures only from iPro's queries (spec: daily brief; decision #92), or null when there
 * is nothing to say: "3 approvals waiting (1 overdue) · 2 tasks due this week · 1 review due".
 */
export function briefLine(c: BriefCounts): string | null {
  const parts: string[] = [];
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const late = (count: number) => (count ? ` (${count} overdue)` : '');
  if (c.approvals)
    parts.push(`${n(c.approvals, 'approval', 'approvals')} waiting${late(c.approvalsOverdue)}`);
  if (c.tasks) parts.push(`${n(c.tasks, 'task', 'tasks')} due this week${late(c.tasksOverdue)}`);
  if (c.reviews) {
    parts.push(
      `${n(c.reviews, 'review or check-in', 'reviews and check-ins')} due${late(c.reviewsOverdue)}`,
    );
  }
  if (c.probationsEnding) {
    parts.push(`${n(c.probationsEnding, 'probation ends', 'probations end')} in 30 days`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/**
 * The 09:00 daily brief (spec: optional, included in Phase 1; decision #92): for each manager and
 * HR user, what is waiting on them and due this week, worked out as that user (the same queries as
 * their Action inbox, so only what they may see), sent once a day as a notification they can
 * switch off. Nothing is sent when there is nothing to say.
 */
@Injectable()
export class BriefService {
  private readonly log = new Logger('DailyBrief');

  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(ChecklistsService) private readonly checklists: ChecklistsService,
    @Inject(ReviewsService) private readonly reviews: ReviewsService,
    @Inject(CheckInsService) private readonly checkIns: CheckInsService,
  ) {}

  async run(today = businessDate(new Date())): Promise<number> {
    const { tenantId } = requireContext();
    const userIds = await this.db.tx(async (tx) =>
      (
        await tx
          .selectDistinct({ id: appUsers.id })
          .from(roleAssignments)
          .innerJoin(appUsers, eq(appUsers.id, roleAssignments.userId))
          .where(
            and(
              inArray(roleAssignments.role, [...BRIEFED]),
              isNull(roleAssignments.deletedAt),
              eq(appUsers.status, 'active'),
            ),
          )
      ).map((r) => r.id),
    );
    let sent = 0;
    for (const userId of userIds) {
      const actor = await this.db.tx((tx) => this.users.loadActor(tx, tenantId, userId));
      if (!actor) continue;
      const line = await runWithContext({ tenantId, actor }, () =>
        this.counts(actor, today).then(briefLine),
      );
      if (!line) continue;
      await runWithContext({ tenantId, actor }, () =>
        this.db.tx((tx) =>
          notify(tx, [userId], 'daily_brief', `Today: ${line}`, '/', {
            dedupeKey: `brief:${today}`,
          }),
        ),
      );
      sent += 1;
    }
    if (sent) this.log.log(`Sent ${sent} daily briefs`);
    return sent;
  }

  /** The brief's figures, as the user: their approvals, tasks, reviews and check-ins. */
  async counts(actor: Actor, today: string): Promise<BriefCounts> {
    const week = addDays(today, 7);
    const approvals = await this.workflows.myApprovals();
    const tasks = (await this.checklists.myTasks()).filter((t) => t.dueOn <= week);
    const reviews = [
      ...(await this.reviews.list()).filter((r) => r.canSubmit && r.dueOn <= week),
      ...(await this.checkIns.list({ open: true })).filter((c) => c.canRecord && c.dueOn <= week),
    ];
    const isHr = actor.roles.some((r) => r.role === 'hr' || r.role === 'hr_head');
    const probationsEnding = isHr ? (await this.reviews.dashboard()).dueSoon.length : null;
    return {
      approvals: approvals.length,
      approvalsOverdue: approvals.filter((a) => a.overdue).length,
      tasks: tasks.length,
      tasksOverdue: tasks.filter((t) => t.overdue).length,
      reviews: reviews.length,
      reviewsOverdue: reviews.filter((r) => r.overdue).length,
      probationsEnding,
    };
  }
}
