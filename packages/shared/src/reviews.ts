import { z } from 'zod';
import { isoDateSchema } from './identity.js';

/** A probation review (spec workflow 3) or, from slice 5c, an intern's assessment (decision #56). */
export const reviewKindSchema = z.enum(['probation', 'internship']);
export const reviewStatusSchema = z.enum(['due', 'submitted', 'decided', 'cancelled']);
export const probationOutcomeSchema = z.enum(['confirm', 'extend', 'terminate']);
export type ProbationOutcome = z.infer<typeof probationOutcomeSchema>;

/** POST /api/reviews/:id/submit (M5): the manager's review and recommendation. */
export const submitReviewSchema = z
  .object({
    recommendation: probationOutcomeSchema,
    /** Competency → 1..5, for the competencies the review form lists (setting). */
    ratings: z.record(z.string().min(1).max(100), z.number().int().min(1).max(5)),
    strengths: z.string().trim().max(2000).optional(),
    improvements: z.string().trim().max(2000).optional(),
    comments: z.string().trim().min(1).max(4000),
    /** Extend: the proposed new probation end date. */
    newEndDate: isoDateSchema.optional(),
    /** Terminate: the proposed last working day. */
    lastWorkingDate: isoDateSchema.optional(),
  })
  .refine((r) => r.recommendation !== 'extend' || r.newEndDate, {
    path: ['newEndDate'],
    message: 'an extension needs a new end date',
  })
  .refine((r) => r.recommendation !== 'terminate' || r.lastWorkingDate, {
    path: ['lastWorkingDate'],
    message: 'a termination needs a last working day',
  });
export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;

export const reviewQuerySchema = z.object({ status: reviewStatusSchema.optional() });

export interface ReviewView {
  id: string;
  kind: z.infer<typeof reviewKindSchema>;
  status: z.infer<typeof reviewStatusSchema>;
  person: { personId: string; name: string };
  employeeCode: string;
  designation: string | null;
  joiningDate: string;
  dueOn: string;
  overdue: boolean;
  reviewer: string;
  /** The competencies to rate, from the review form setting. */
  competencies: string[];
  recommendation: ProbationOutcome | null;
  ratings: Record<string, number>;
  strengths: string | null;
  improvements: string | null;
  comments: string | null;
  newEndDate: string | null;
  lastWorkingDate: string | null;
  submittedAt: string | null;
  decision: ProbationOutcome | null;
  decidedAt: string | null;
  requestId: string | null;
  /** Extensions already used, and the policy limits (setting probation_extension). */
  extensions: { used: number; max: number; maxMonths: number };
  /** What the signed-in user may do now. */
  canSubmit: boolean;
}

/** H7 probation dashboard: exceptions first. */
export interface ProbationDashboard {
  overdue: ReviewView[];
  awaitingDecision: ReviewView[];
  dueSoon: { personId: string; name: string; probationEndDate: string; reviewId: string | null }[];
  extended: { personId: string; name: string; probationEndDate: string }[];
}
