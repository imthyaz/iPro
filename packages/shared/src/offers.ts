import { z } from 'zod';
import { isoDateSchema } from './identity.js';
import {
  assignmentFieldsSchema,
  compensationInputSchema,
  engagementTypeSchema,
  personFieldsSchema,
} from './people.js';

/**
 * Offer to joining (spec workflow 1; decision #54). Draft → Pending approval → Offered → Accepted →
 * Joined, with Declined, Withdrawn and No-show as side exits. A returned offer goes back to Draft.
 */
export const offerStatusSchema = z.enum([
  'draft',
  'pending_approval',
  'offered',
  'accepted',
  'joined',
  'declined',
  'withdrawn',
  'no_show',
]);
export type OfferStatus = z.infer<typeof offerStatusSchema>;

/**
 * How the offered pay compares with the grade band. HR head approves anything above the band, and
 * day or hour rates, which can't be compared with an annual band.
 */
export const bandCheckSchema = z.enum(['within', 'above', 'no_band', 'not_comparable']);
export type BandCheck = z.infer<typeof bandCheckSchema>;

/** POST /api/offers (H3): the candidate, the role and pay, and the offer letter template. */
export const createOfferSchema = z
  .object({
    /** The personal email receives the offer for e-signature and the pre-joining invitation. */
    person: personFieldsSchema.extend({ personalEmail: z.email() }),
    engagement: z.object({
      legalEntityId: z.uuid(),
      type: engagementTypeSchema,
      joiningDate: isoDateSchema,
      /** Planned last day, for interns and fixed-term engagements (decision #56). */
      endDate: isoDateSchema.optional(),
    }),
    assignment: assignmentFieldsSchema,
    /** Left out only for an unpaid internship. */
    compensation: compensationInputSchema.optional(),
    letterTemplateKey: z.string().min(1).max(60),
    /** Values for the template's {{extra.*}} fields. */
    extra: z.record(z.string().regex(/^[a-zA-Z]\w{0,40}$/), z.string().max(500)).optional(),
  })
  .refine((o) => o.compensation || o.engagement.type === 'intern', {
    path: ['compensation'],
    message: 'pay is required except for an unpaid internship',
  })
  .refine((o) => o.engagement.type !== 'intern' || o.engagement.endDate, {
    path: ['engagement', 'endDate'],
    message: 'an internship needs an end date',
  })
  .refine((o) => !o.engagement.endDate || o.engagement.endDate >= o.engagement.joiningDate, {
    path: ['engagement', 'endDate'],
    message: 'ends before it starts',
  });
export type CreateOfferInput = z.infer<typeof createOfferSchema>;

export const offerReasonSchema = z.object({ reason: z.string().trim().min(1).max(500) });

/** POST /api/offers/:id/join — the work account the joiner signs in with from Day 1. */
export const joinOfferSchema = z.object({ workEmail: z.email() });

export const offerQuerySchema = z.object({ status: offerStatusSchema.optional() });

export interface OfferView {
  id: string;
  status: OfferStatus;
  person: { personId: string; name: string };
  engagementId: string;
  employeeCode: string;
  engagementType: z.infer<typeof engagementTypeSchema>;
  joiningDate: string;
  endDate: string | null;
  /** False for an unpaid internship. */
  paid: boolean;
  designation: string | null;
  department: string | null;
  hiringManager: string | null;
  bandCheck: BandCheck;
  /** True when HR head must approve (above band, or a day or hour rate). */
  needsHrHead: boolean;
  letter: { id: string; status: string } | null;
  approvalRequestId: string | null;
  offeredAt: string | null;
  expiresOn: string | null;
  acceptedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  /** The pre-joiner's sign-in invitation (decision #55). */
  guest: { status: 'invited' | 'failed' | 'retired'; invitedAt: string | null } | null;
  createdAt: string;
}

/** GET /api/onboarding/me (E11): what a joiner needs before and on Day 1, or null when not joining. */
export interface OnboardingView {
  name: string;
  status: 'pre_joining' | 'active';
  joiningDate: string;
  /** Days until joining; 0 on the day, negative after. */
  daysToGo: number;
  endDate: string | null;
  designation: string | null;
  department: string | null;
  location: string | null;
  manager: string | null;
  /** Day 1 times, from the shift they are on that day. */
  dayOne: { startTime: string; endTime: string; shiftCode: string } | null;
  checklists: { runId: string; name: string; done: number; total: number; overdue: number }[];
}
