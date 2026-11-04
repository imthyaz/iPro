import { z } from 'zod';
import { isoDateSchema } from './identity.js';

/** A probation review (spec workflow 3) or an intern's assessment (decision #56). */
export const reviewKindSchema = z.enum(['probation', 'internship']);
export type ReviewKind = z.infer<typeof reviewKindSchema>;
export const reviewStatusSchema = z.enum(['due', 'submitted', 'decided', 'cancelled']);
export const probationOutcomeSchema = z.enum(['confirm', 'extend', 'terminate']);
/** After an internship: convert to employee, extend, end it, or a break (decision #56). */
export const internshipOutcomeSchema = z.enum(['convert', 'extend', 'end', 'break']);
export const reviewOutcomeSchema = z.enum([
  'confirm',
  'extend',
  'terminate',
  'convert',
  'end',
  'break',
]);
export type ProbationOutcome = z.infer<typeof probationOutcomeSchema>;
export type InternshipOutcome = z.infer<typeof internshipOutcomeSchema>;
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

/** The outcomes each kind of review may recommend. */
export const outcomesByKind: Record<ReviewKind, readonly ReviewOutcome[]> = {
  probation: probationOutcomeSchema.options,
  internship: internshipOutcomeSchema.options,
};

/** POST /api/reviews/:id/submit (M5): the manager's review and recommendation. */
export const submitReviewSchema = z
  .object({
    recommendation: reviewOutcomeSchema,
    /** Competency → 1..5, for the competencies the review form lists (setting). */
    ratings: z.record(z.string().min(1).max(100), z.number().int().min(1).max(5)),
    strengths: z.string().trim().max(2000).optional(),
    improvements: z.string().trim().max(2000).optional(),
    comments: z.string().trim().min(1).max(4000),
    /** Extend: the proposed new end date (probation or internship). */
    newEndDate: isoDateSchema.optional(),
    /** Terminate, end or break: the last working day. */
    lastWorkingDate: isoDateSchema.optional(),
    /** Convert: what the intern becomes, and whether they serve probation (decision #42). */
    convertTo: z.enum(['permanent', 'fixed_term']).optional(),
    convertProbation: z.enum(['policy', 'none']).optional(),
    /** Break: when they expect to come back, if known. */
    returnBy: isoDateSchema.optional(),
  })
  .refine((r) => r.recommendation !== 'extend' || r.newEndDate, {
    path: ['newEndDate'],
    message: 'an extension needs a new end date',
  })
  .refine((r) => !['terminate', 'end', 'break'].includes(r.recommendation) || r.lastWorkingDate, {
    path: ['lastWorkingDate'],
    message: 'this needs a last working day',
  })
  .refine((r) => r.recommendation !== 'convert' || (r.convertTo && r.convertProbation), {
    path: ['convertTo'],
    message: 'a conversion needs what they become and whether they serve probation',
  });
export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;

export const reviewQuerySchema = z.object({ status: reviewStatusSchema.optional() });

export interface ReviewView {
  id: string;
  kind: ReviewKind;
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
  /** What this kind of review may recommend. */
  outcomes: ReviewOutcome[];
  recommendation: ReviewOutcome | null;
  ratings: Record<string, number>;
  strengths: string | null;
  improvements: string | null;
  comments: string | null;
  newEndDate: string | null;
  lastWorkingDate: string | null;
  convertTo: 'permanent' | 'fixed_term' | null;
  convertProbation: 'policy' | 'none' | null;
  returnBy: string | null;
  submittedAt: string | null;
  decision: ReviewOutcome | null;
  decidedAt: string | null;
  requestId: string | null;
  /** Extensions already used, and the policy limits (setting probation_extension). */
  extensions: { used: number; max: number; maxMonths: number };
  /** Monthly probation check-ins so far (decision #63). */
  checkIns: CheckInView[];
  /** What the signed-in user may do now. */
  canSubmit: boolean;
}

/** A monthly probation check-in (decision #63): how the month went, in a word and a note. */
export const checkInProgressSchema = z.enum(['on_track', 'needs_support', 'at_risk']);
export type CheckInProgress = z.infer<typeof checkInProgressSchema>;

/** POST /api/check-ins/:id */
export const recordCheckInSchema = z.object({
  progress: checkInProgressSchema,
  notes: z.string().trim().min(1).max(2000),
});

export interface CheckInView {
  id: string;
  person: { personId: string; name: string };
  month: number;
  dueOn: string;
  overdue: boolean;
  status: 'due' | 'done';
  progress: CheckInProgress | null;
  notes: string | null;
  recordedAt: string | null;
  recordedBy: string | null;
  canRecord: boolean;
}

/** H7 probation dashboard: exceptions first. */
export interface ProbationDashboard {
  overdue: ReviewView[];
  awaitingDecision: ReviewView[];
  dueSoon: { personId: string; name: string; probationEndDate: string; reviewId: string | null }[];
  extended: { personId: string; name: string; probationEndDate: string }[];
  /** Check-ins not recorded within a week of their date. */
  checkInsOverdue: CheckInView[];
  /** Intern assessments open now. */
  internships: ReviewView[];
}
