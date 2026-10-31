import { z } from 'zod';

export const kycTypeSchema = z.enum(['pan', 'aadhaar', 'passport', 'bank', 'uan', 'esic']);
export type KycType = z.infer<typeof kycTypeSchema>;

export const kycTypeLabels: Record<KycType, string> = {
  pan: 'PAN',
  aadhaar: 'Aadhaar',
  passport: 'Passport',
  bank: 'Bank account',
  uan: 'UAN (EPF)',
  esic: 'ESIC number',
};

const formats: Record<KycType, RegExp> = {
  pan: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
  aadhaar: /^[2-9][0-9]{11}$/,
  passport: /^[A-Z][0-9]{7}$/,
  bank: /^[0-9]{9,18}$/,
  uan: /^[0-9]{12}$/,
  esic: /^[0-9]{10}([0-9]{7})?$/,
};

// Verhoeff checksum tables (Aadhaar's last digit).
const d = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const p = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeffValid(digits: string): boolean {
  let c = 0;
  [...digits].reverse().forEach((digit, i) => {
    c = d[c]![p[i % 8]![Number(digit)]!]!;
  });
  return c === 0;
}

/** Uppercase, without spaces or hyphens (how people type PAN and Aadhaar). */
export const normaliseKycValue = (value: string) => value.replace(/[\s-]/g, '').toUpperCase();

/** POST /api/people/:id/kyc. Values are validated by type; bank accounts also need an IFSC. */
export const kycSubmitSchema = z
  .object({
    type: kycTypeSchema,
    value: z.string().min(1).max(40).transform(normaliseKycValue),
    ifsc: z
      .string()
      .transform(normaliseKycValue)
      .pipe(z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'not a valid IFSC'))
      .optional(),
    documentId: z.uuid().optional(),
  })
  .superRefine((input, ctx) => {
    if (!formats[input.type].test(input.value)) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `not a valid ${kycTypeLabels[input.type]}`,
      });
    } else if (input.type === 'aadhaar' && !verhoeffValid(input.value)) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Aadhaar check digit does not match',
      });
    }
    if (input.type === 'bank' && !input.ifsc) {
      ctx.addIssue({
        code: 'custom',
        path: ['ifsc'],
        message: 'IFSC is required for a bank account',
      });
    }
  });
export type KycSubmitInput = z.infer<typeof kycSubmitSchema>;

/** A KYC record as listed: always masked; the full value needs a separate, audited unmask. */
export interface KycView {
  id: string;
  type: KycType;
  maskedValue: string;
  extra: Record<string, string>;
  documentId: string | null;
  verified: boolean;
  verifiedAt: string | null;
}

export const documentTypeSchema = z.enum(['kyc_scan', 'letter', 'certificate', 'photo', 'other']);
export const documentUploadSchema = z.object({
  type: documentTypeSchema,
  title: z.string().trim().min(1).max(200),
  /** Form fields arrive as strings. */
  confidential: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value !== 'false'),
});

export interface DocumentView {
  id: string;
  type: z.infer<typeof documentTypeSchema>;
  title: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  version: number;
  confidential: boolean;
  uploadedAt: string;
  signedAt: string | null;
}
