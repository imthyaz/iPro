import { describe, expect, it } from 'vitest';
import { anyWordQuery, MAX_CLAUSE_CHARS, policyFileType, splitClauses } from './clause-rules.js';

const leavePolicy = `Leave policy
Ideassion Technologies (synthetic)

1. Purpose. This policy sets out the leave employees may take.
2. Casual leave
Employees get 12 days of casual leave a year, credited monthly.
2.1 Casual leave can't be carried forward.
3. Earned leave. Up to 10 days of earned leave carry forward to the next year.
Anything above 10 days lapses on 31 December.
4.2 Notice period for leads: 60 days.`;

describe('splitting policy text into clauses (decision #89)', () => {
  it('keeps the document’s own numbers and headings', () => {
    const clauses = splitClauses(leavePolicy);
    expect(clauses.map((c) => [c.number, c.heading])).toEqual([
      [null, 'Introduction'],
      ['1', 'Purpose'],
      ['2', 'Casual leave'],
      ['2.1', "Casual leave can't be carried forward"],
      ['3', 'Earned leave'],
      ['4.2', 'Notice period for leads'],
    ]);
    const earned = clauses.find((c) => c.number === '3')!;
    expect(earned.body).toBe(
      'Up to 10 days of earned leave carry forward to the next year.\nAnything above 10 days lapses on 31 December.',
    );
    expect(clauses.find((c) => c.number === '2')!.body).toBe(
      'Employees get 12 days of casual leave a year, credited monthly.',
    );
  });

  it('splits an unnumbered document into paragraphs', () => {
    const text = [
      'Remote work',
      '',
      'People may work from home two days a week.',
      '',
      'Ask your manager first.',
    ].join('\n');
    const clauses = splitClauses(text);
    expect(clauses).toHaveLength(1);
    expect(clauses[0]).toMatchObject({
      number: null,
      heading: expect.stringContaining('Remote work'),
    });
  });

  it('continues a very long clause in a second one', () => {
    const long = `1. Long clause. ${'word '.repeat(1200)}\n2. Next. Short.`;
    const clauses = splitClauses(long);
    expect(clauses.every((c) => c.body.length <= MAX_CLAUSE_CHARS)).toBe(true);
    expect(clauses.filter((c) => c.number === '1').length).toBeGreaterThan(1);
    expect(clauses.find((c) => c.heading === 'Long clause (continued)')).toBeDefined();
  });

  it('returns nothing for a document with no text (e.g. a scanned PDF)', () => {
    expect(splitClauses('  \n\n ')).toEqual([]);
  });
});

describe('the search query', () => {
  it('matches any word of the question, letters and digits only', () => {
    expect(anyWordQuery('How many days can I carry forward?')).toBe(
      'how | many | days | can | carry | forward',
    );
    expect(anyWordQuery("notice period; DROP TABLE x -- ' & |")).toBe(
      'notice | period | drop | table',
    );
    expect(anyWordQuery('?!')).toBeNull();
  });
});

describe('policy file types', () => {
  it('accepts PDF and Word files, nothing else', () => {
    expect(policyFileType(Buffer.from('%PDF-1.4\n'), 'leave.pdf')).toBe('pdf');
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]);
    expect(policyFileType(zip, 'Leave policy.DOCX')).toBe('docx');
    expect(policyFileType(zip, 'leave.xlsx')).toBeNull();
    expect(policyFileType(Buffer.from('hello'), 'leave.pdf')).toBeNull();
  });
});
