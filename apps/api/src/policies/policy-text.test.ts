import { describe, expect, it } from 'vitest';
import { blankPdf, policyDocx, policyPdf } from '../../test/policy-files.js';
import { policyFileType, splitClauses } from './clause-rules.js';
import { readPolicyText } from './policy-text.js';

const LINES = [
  '1. Purpose. This policy sets out the leave employees may take.',
  '2. Casual leave. Employees get 12 days of casual leave a year.',
  '3. Earned leave. Up to 10 days of earned leave carry forward to the next year.',
];

describe('reading policy files (decision #89)', () => {
  it('reads a PDF’s text into its numbered clauses', async () => {
    const pdf = await policyPdf('Leave policy', LINES);
    expect(policyFileType(pdf, 'leave.pdf')).toBe('pdf');
    const clauses = splitClauses(await readPolicyText(pdf, 'pdf'));
    expect(clauses.filter((c) => c.number).map((c) => [c.number, c.heading])).toEqual([
      ['1', 'Purpose'],
      ['2', 'Casual leave'],
      ['3', 'Earned leave'],
    ]);
    expect(clauses.find((c) => c.number === '3')!.body).toContain('Up to 10 days of earned leave');
  });

  it('reads a Word file the same way', async () => {
    const docx = policyDocx(['Notice policy', ...LINES]);
    expect(policyFileType(docx, 'Notice.docx')).toBe('docx');
    const clauses = splitClauses(await readPolicyText(docx, 'docx'));
    expect(clauses.filter((c) => c.number).map((c) => c.number)).toEqual(['1', '2', '3']);
  });

  it('finds no clauses in a PDF with no text (a scan)', async () => {
    const pdf = await blankPdf();
    expect(splitClauses(await readPolicyText(pdf, 'pdf'))).toEqual([]);
  });
});
