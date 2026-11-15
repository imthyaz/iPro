import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import type { AssistantOpen, AssistantSource } from '@ipro/shared';
import { z } from 'zod';
import { AttendanceService } from '../attendance/attendance.service.js';
import { AuthzService } from '../authz/authz.service.js';
import type { Action, DataArea } from '../authz/permissions.js';
import { businessDate } from '../common/effective-dating.js';
import { requireContext, type Actor } from '../context/request-context.js';
import { ComplianceService } from '../hybrid/compliance.service.js';
import { TeamJourneysService } from '../journey/team-journeys.service.js';
import { TimelineService } from '../journey/timeline.service.js';
import { LeaveService } from '../leave/leave.service.js';
import { LeaveRequestsService } from '../leave/requests.service.js';
import { PeopleService } from '../people/people.service.js';
import { PoliciesService } from '../policies/policies.service.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import type { LinkedRecord } from './assistant.schema.js';

/** What a tool hands back: the data the model may use, and where it came from. */
export interface ToolResult {
  data: unknown;
  sources: AssistantSource[];
  records?: LinkedRecord[];
  open?: AssistantOpen;
  /** The lookup ran but found nothing (e.g. no policy clause matches). */
  empty?: boolean;
}

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** The same route grants as the screen this mirrors; any one opens the tool (as the guard does). */
  grants: [DataArea, Action][] | 'signed-in';
  run(input: z.infer<S>, actor: Actor): Promise<ToolResult>;
}

export type ToolOutcome =
  | { outcome: 'ok'; result: ToolResult }
  | { outcome: 'refused'; message: string }
  | { outcome: 'error'; message: string };

const year = z
  .number()
  .int()
  .min(2000)
  .max(2100)
  .optional()
  .describe('Calendar year; default this year');
const scope = z
  .enum(['team', 'all'])
  .default('team')
  .describe('team: the user’s own reports; all: everyone the user may see (HR, CXO)');
const isoDate = z.iso.date();
const month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .describe('YYYY-MM');
const personId = z.uuid().describe('A personId from find_people');
const thisYear = () => Number(businessDate(new Date()).slice(0, 4));
const days = (n: number) => Math.round(n * 100) / 100;

/**
 * Ask iPro's tools (decision #88): thin wrappers over the services behind iPro's own screens, run as
 * the signed-in user. Each passes the route check its screen has (authz.can, as the guard) and the
 * service's own record check (authz.assert), so the assistant can't show what the user can't see.
 * Results carry only what an answer needs, with a link to the screen behind each figure.
 */
@Injectable()
export class AssistantTools {
  private readonly defs: ToolDef<z.ZodType>[];

  constructor(
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(LeaveService) private readonly leave: LeaveService,
    @Inject(LeaveRequestsService) private readonly leaveRequests: LeaveRequestsService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(AttendanceService) private readonly attendance: AttendanceService,
    @Inject(ReviewsService) private readonly reviews: ReviewsService,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(TimelineService) private readonly timelines: TimelineService,
    @Inject(TeamJourneysService) private readonly teams: TeamJourneysService,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(PoliciesService) private readonly policies: PoliciesService,
  ) {
    this.defs = this.build() as ToolDef<z.ZodType>[];
  }

  /** Tool definitions for the model. */
  definitions(): Anthropic.Tool[] {
    return this.defs.map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: z.toJSONSchema(d.input, { io: 'input' }) as Anthropic.Tool.InputSchema,
    }));
  }

  /** Runs one tool call as the signed-in user. Never throws for a refusal or bad input. */
  async run(name: string, rawInput: unknown): Promise<ToolOutcome> {
    const def = this.defs.find((d) => d.name === name);
    if (!def) return { outcome: 'error', message: `No tool named ${name}` };
    const actor = requireContext().actor!;
    if (def.grants !== 'signed-in' && !def.grants.some(([a, x]) => this.authz.can(actor, a, x))) {
      return { outcome: 'refused', message: 'The user doesn’t have access to this' };
    }
    const parsed = def.input.safeParse(rawInput ?? {});
    if (!parsed.success) return { outcome: 'error', message: 'Invalid input for this tool' };
    try {
      return { outcome: 'ok', result: await def.run(parsed.data, actor) };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        return { outcome: 'refused', message: 'The user doesn’t have access to this' };
      }
      if (error instanceof NotFoundException) return { outcome: 'error', message: 'Not found' };
      if (error instanceof BadRequestException) {
        const body = error.getResponse();
        const message =
          typeof body === 'object' && body && 'message' in body && typeof body.message === 'string'
            ? body.message
            : 'Invalid input';
        return { outcome: 'error', message };
      }
      throw error;
    }
  }

  private build() {
    const me = (actor: Actor) => {
      if (!actor.personId) throw new NotFoundException();
      return actor.personId;
    };
    const balancesOf = async (id: string, y: number | undefined, link: string) => {
      const rows = await this.leave.balances(id, y ?? thisYear());
      return {
        data: {
          year: y ?? thisYear(),
          balances: rows.map((b) => ({
            code: b.leaveType.code,
            type: b.leaveType.name,
            balance: days(b.balance),
            taken: days(b.taken),
            accrued: days(b.accrued),
          })),
        },
        sources: [{ label: 'Leave balances', link }],
        records: [{ type: 'leave_balance' as const, id }],
      };
    };

    return [
      def({
        name: 'my_leave_balances',
        description: 'The signed-in user’s own leave balances by leave type for a year.',
        input: z.object({ year }),
        grants: [['leave', 'read']],
        run: ({ year: y }, actor) => balancesOf(me(actor), y, '/leave'),
      }),
      def({
        name: 'person_leave_balances',
        description:
          'Leave balances of another person the user may see (a manager’s team, HR’s entities).',
        input: z.object({ personId, year }),
        grants: [['leave', 'read']],
        run: ({ personId: id, year: y }) => balancesOf(id, y, `/people/${id}`),
      }),
      def({
        name: 'my_leave_requests',
        description: 'The signed-in user’s own leave requests in a year, with dates and status.',
        input: z.object({ year }),
        grants: [['leave', 'read']],
        run: async ({ year: y }) => {
          const rows = await this.leaveRequests.mine(y ?? thisYear());
          return {
            data: rows.map((r) => ({
              type: r.leaveType.name,
              from: r.from,
              to: r.to,
              days: days(r.days),
              status: r.status,
            })),
            sources: [{ label: 'My leave', link: '/leave' }],
          };
        },
      }),
      def({
        name: 'team_on_date',
        description:
          'Who in the team is on leave, and who is booked in office, WFH or client site, on a date.',
        input: z.object({ date: isoDate, scope }),
        grants: [
          ['hybrid_booking', 'approve'],
          ['attendance', 'update'],
        ],
        run: async ({ date, scope: s }) => {
          const view = await this.compliance.teamCalendar(date.slice(0, 7), s);
          const onDay = view.people.map((p) => ({
            name: p.name,
            day: p.days.find((d) => d.date === date)!,
          }));
          const onLeave = onDay
            .filter((p) => p.day?.leave)
            .map((p) => ({
              name: p.name,
              leave: p.day.leave!.code,
              half: p.day.leave!.half,
              approved: p.day.leave!.approved,
            }));
          return {
            data: {
              date,
              teamSize: view.people.length,
              onLeave,
              onLeaveCount: onLeave.length,
              booked: onDay
                .filter((p) => p.day?.booking)
                .map((p) => ({ name: p.name, mode: p.day.booking!.mode })),
            },
            sources: [{ label: 'Team calendar', link: `/team-calendar?month=${date.slice(0, 7)}` }],
          };
        },
      }),
      def({
        name: 'team_today',
        description: 'Where the team is right now: in office, WFH, on leave, not checked in.',
        input: z.object({ scope }),
        grants: [
          ['hybrid_booking', 'approve'],
          ['attendance', 'update'],
        ],
        run: async ({ scope: s }) => {
          const view = await this.compliance.teamToday(s);
          return {
            data: {
              date: view.date,
              counts: view.counts,
              people: view.rows.map((r) => ({ name: r.name, status: r.status, note: r.note })),
            },
            sources: [{ label: 'Team today', link: '/team-today' }],
          };
        },
      }),
      def({
        name: 'hybrid_compliance',
        description:
          'Office days planned and attended against the hybrid policy, per person per week (weeks start Monday).',
        input: z.object({ from: isoDate, to: isoDate, scope }),
        grants: [
          ['hybrid_booking', 'approve'],
          ['attendance', 'update'],
        ],
        run: async ({ from, to, scope: s }) => {
          const view = await this.compliance.report(from, to, s);
          return {
            data: {
              summary: view.summary,
              belowPolicy: view.people.flatMap((p) =>
                p.weeks
                  .filter((w) => !w.met)
                  .map((w) => ({
                    name: p.name,
                    weekStart: w.weekStart,
                    target: w.target,
                    actual: w.actual,
                    approvedBelow: w.approvedBelow,
                  })),
              ),
            },
            sources: [{ label: 'Hybrid compliance', link: '/hybrid-compliance' }],
          };
        },
      }),
      def({
        name: 'attendance_month',
        description:
          'Attendance for a month, day by day with counts by status. Omit personId for the user’s own.',
        input: z.object({ month, personId: personId.optional() }),
        grants: [['attendance', 'read']],
        run: async ({ month: m, personId: id }, actor) => {
          const who = id ?? me(actor);
          const rows = await this.attendance.month(who, m);
          const counts: Record<string, number> = {};
          for (const r of rows) {
            if (r.status) counts[r.status] = (counts[r.status] ?? 0) + 1;
          }
          return {
            data: {
              month: m,
              counts,
              days: rows
                .filter((r) => r.status)
                .map((r) => ({ date: r.date, status: r.status, mode: r.mode })),
            },
            sources: [
              { label: 'Attendance', link: id ? `/people/${id}` : `/attendance?month=${m}` },
            ],
          };
        },
      }),
      def({
        name: 'probation_dashboard',
        description:
          'Probation reviews overdue, awaiting decision, and probations ending in the next 30 days.',
        input: z.object({}),
        grants: [
          ['probation_review', 'create'],
          ['probation_review', 'approve'],
          ['probation_review', 'terminate'],
        ],
        run: async () => {
          const d = await this.reviews.dashboard();
          return {
            data: {
              overdue: d.overdue.map((r) => ({ name: r.person.name, dueOn: r.dueOn })),
              awaitingDecision: d.awaitingDecision.map((r) => ({ name: r.person.name })),
              dueSoon: d.dueSoon.map((r) => ({ name: r.name, probationEnds: r.probationEndDate })),
              dueSoonCount: d.dueSoon.length,
              extended: d.extended.length,
            },
            sources: [{ label: 'Probation', link: '/probation' }],
          };
        },
      }),
      def({
        name: 'find_people',
        description:
          'Finds people by name or employee code (only those the user may see). Returns personIds.',
        input: z.object({
          query: z.string().trim().min(1).max(100),
          status: z.enum(['offered', 'pre_joining', 'active', 'on_notice', 'exited']).optional(),
        }),
        grants: [['profile', 'read']],
        run: async ({ query, status }) => {
          const rows = (await this.people.directory({ q: query, status })).slice(0, 20);
          return {
            data: rows.map((p) => ({
              personId: p.personId,
              name: p.preferredName ?? p.legalName,
              employeeCode: p.employeeCode,
              designation: p.designation?.title ?? null,
              department: p.department?.name ?? null,
              manager: p.manager?.name ?? null,
              status: p.status,
              joiningDate: p.joiningDate,
            })),
            sources: [{ label: 'People', link: `/people?q=${encodeURIComponent(query)}` }],
            records: rows.map((p) => ({ type: 'person' as const, id: p.personId })),
          };
        },
      }),
      def({
        name: 'person_journey',
        description:
          'A person’s journey: joining, changes, milestones and what is planned. Opens their timeline.',
        input: z.object({ personId }),
        grants: [['journey_public', 'read']],
        run: async ({ personId: id }) => {
          const view = await this.timelines.personTimeline(id);
          return {
            data: {
              person: view.person,
              events: view.events.slice(-30).map((e) => ({
                date: e.date,
                title: e.title,
                category: e.category,
                planned: e.planned,
              })),
            },
            sources: [
              { label: `${view.person.name}’s journey`, link: `/people/${id}?tab=journey` },
            ],
            records: [{ type: 'person' as const, id }],
            open: { kind: 'timeline' as const, personId: id, name: view.person.name },
          };
        },
      }),
      def({
        name: 'joiners_and_leavers',
        description:
          'People who joined and who left (last working day) between two dates, with department counts.',
        input: z.object({ from: isoDate, to: isoDate, scope }),
        grants: [['journey_public', 'read']],
        run: async ({ from, to, scope: s }) => {
          const view = await this.teams.team({
            scope: s,
            from,
            to,
            exited: 'true',
          });
          const inRange = (d: string | null) => d !== null && d >= from && d <= to;
          const joiners = view.people.filter((p) => inRange(p.joiningDate));
          const leavers = view.people.filter(
            (p) => p.status === 'exited' && inRange(p.lastWorkingDate),
          );
          const byDept = (rows: typeof joiners) => {
            const out: Record<string, number> = {};
            for (const p of rows)
              out[p.department ?? 'No department'] =
                (out[p.department ?? 'No department'] ?? 0) + 1;
            return out;
          };
          return {
            data: {
              from,
              to,
              joiners: joiners.length,
              leavers: leavers.length,
              joinersByDepartment: byDept(joiners),
              leaversByDepartment: byDept(leavers),
              joinerNames: joiners.map((p) => p.name),
              leaverNames: leavers.map((p) => p.name),
            },
            sources: [{ label: 'Team journeys', link: '/team-journeys' }],
          };
        },
      }),
      def({
        name: 'policy_search',
        description:
          'Searches the clauses of the policies that apply to the user (leave, notice, hybrid, conduct and so on). Use for any question about rules or policy, and answer only from the clauses returned, naming the clause.',
        input: z.object({
          question: z
            .string()
            .trim()
            .min(2)
            .max(300)
            .describe('The policy question, in plain words'),
        }),
        grants: 'signed-in',
        run: async ({ question }) => {
          const hits = await this.policies.searchClauses(question);
          return {
            data: {
              found: hits.length,
              clauses: hits.map((h) => ({
                policy: h.policyTitle,
                version: h.version,
                clause: h.number,
                heading: h.heading,
                text: h.body,
              })),
            },
            sources: hits.map((h) => ({
              label: `${h.policyTitle}${h.number ? ` ${h.number}` : ''}: ${h.heading}`,
              link: `/policies?policy=${h.policyId}&clause=${h.position}`,
            })),
            records: hits.map((h) => ({ type: 'policy' as const, id: h.policyId })),
            empty: hits.length === 0,
          };
        },
      }),
      def({
        name: 'my_approvals',
        description: 'Approvals waiting for the signed-in user, soonest due first.',
        input: z.object({}),
        grants: 'signed-in',
        run: async () => {
          const cards = await this.workflows.myApprovals();
          return {
            data: {
              count: cards.length,
              overdue: cards.filter((c) => c.overdue).length,
              items: cards.map((c) => ({
                title: c.title,
                for: c.subject.name,
                dueOn: c.dueOn,
                overdue: c.overdue,
              })),
            },
            sources: [{ label: 'Action inbox', link: '/' }],
          };
        },
      }),
    ];
  }
}

function def<S extends z.ZodType>(d: ToolDef<S>): ToolDef<S> {
  return d;
}
