import { z } from 'zod';

export const letterTypeSchema = z.enum([
  'offer',
  'loi',
  'confirmation',
  'extension',
  'transfer',
  'relieving',
  'experience',
  'termination',
  'other',
]);

/**
 * PUT /api/letter-templates/:key (screen A3). The body uses {{fields}} from a fixed list plus
 * {{extra.*}} values given when generating; paragraphs are separated by blank lines, "# " starts a heading.
 */
export const letterTemplateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: letterTypeSchema,
  body: z.string().min(1).max(20_000),
  /** Approval needed before the letter can be released or sent (spec: approver role). */
  approverRole: z.enum(['hr', 'hr_head']).nullable(),
  /** Whether the person signs it electronically (Zoho Sign). */
  signature: z.enum(['none', 'employee']),
});
export type LetterTemplateInput = z.infer<typeof letterTemplateSchema>;

/** POST /api/people/:id/letters */
export const generateLetterSchema = z.object({
  templateKey: z.string().min(1).max(60),
  /** Values for {{extra.*}} fields, e.g. { newEndDate: '31 Mar 2027' }. */
  extra: z.record(z.string().regex(/^[a-zA-Z]\w{0,40}$/), z.string().max(500)).default({}),
});

export const letterStatusSchema = z.enum([
  'pending_approval',
  'ready',
  'sent',
  'signed',
  'declined',
  'returned',
  'cancelled',
]);

export interface LetterView {
  id: string;
  title: string;
  type: z.infer<typeof letterTypeSchema>;
  templateVersion: number;
  status: z.infer<typeof letterStatusSchema>;
  /** The generated letter, and once signed, the signed copy (a newer document version). */
  documentId: string;
  documentVersion: number;
  signedDocumentId: string | null;
  needsSignature: boolean;
  approvalRequestId: string | null;
  createdAt: string;
  sentAt: string | null;
  signedAt: string | null;
}

export interface LetterTemplateView extends LetterTemplateInput {
  key: string;
  version: number;
  fields: string[];
}

/** Fields a letter template may use (decision #51), with what each prints; `{{extra.*}}` is given when generating. */
export const letterMergeFields = {
  'letter.date': 'Date of the letter',
  'company.name': 'Legal entity name',
  'company.address': 'Registered address',
  'person.legalName': 'Legal name',
  'person.preferredName': 'Preferred name (falls back to legal name)',
  'engagement.employeeCode': 'Employee code',
  'engagement.type': 'Engagement type',
  'engagement.joiningDate': 'Joining date',
  'engagement.probationEndDate': 'Probation end date',
  'engagement.noticePeriodDays': 'Notice period (days)',
  'engagement.lastWorkingDate': 'Last working date',
  'assignment.designation': 'Designation',
  'assignment.department': 'Department',
  'assignment.location': 'Location',
  'assignment.grade': 'Grade',
  'manager.name': 'Reporting manager',
  /** Reading pay for a letter is an audited compensation read. */
  'compensation.amount': 'Pay (formatted, e.g. ₹12,00,000 a year)',
} as const;
