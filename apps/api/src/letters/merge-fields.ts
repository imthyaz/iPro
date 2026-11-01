/**
 * Letter merge fields (decision #51): a fixed list, plus `extra.*` values supplied with the letter
 * (e.g. an extension's new end date). Templates can't run code; unknown or missing fields refuse to
 * generate rather than printing a blank.
 */
export const mergeFields = {
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

export type MergeField = keyof typeof mergeFields;

const PLACEHOLDER = /\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g;

/** Own keys only: names inherited from Object (e.g. constructor) are not fields. */
export const isKnownField = (field: string) =>
  Object.hasOwn(mergeFields, field) || /^extra\.[a-zA-Z]\w{0,40}$/.test(field);

/** The fields a template body uses, in order of first use. */
export function fieldsIn(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/** Template problems found at save time: unknown fields and unbalanced braces. */
export function templateProblems(body: string): string[] {
  const problems = fieldsIn(body)
    .filter((field) => !isKnownField(field))
    .map((field) => `Unknown field {{${field}}}`);
  const stray = body.replace(PLACEHOLDER, '');
  if (stray.includes('{{') || stray.includes('}}'))
    problems.push('A {{ or }} is not part of a field');
  return problems;
}

export type MergeResult = { ok: true; text: string } | { ok: false; missing: string[] };

/** Fills the template; fails listing every field without a value. */
export function merge(
  body: string,
  values: Record<string, string | null | undefined>,
): MergeResult {
  const missing = fieldsIn(body).filter((field) => {
    const value = Object.hasOwn(values, field) ? values[field] : undefined;
    return value === undefined || value === null || value.trim() === '';
  });
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, text: body.replace(PLACEHOLDER, (_, field: string) => values[field]!) };
}

export type Block = { kind: 'heading'; text: string } | { kind: 'paragraph'; text: string };

/** Paragraphs are separated by blank lines; a line starting with "# " is a heading. */
export function toBlocks(text: string): Block[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) =>
      chunk.startsWith('# ')
        ? { kind: 'heading' as const, text: chunk.slice(2).trim() }
        : { kind: 'paragraph' as const, text: chunk },
    );
}
