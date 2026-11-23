/**
 * The A6 people file (slice 13b; decision #94): one row a person, checked before anything loads.
 * Pure, so every rule can be checked by hand; the import service then loads the rows through the
 * normal people service, managers first.
 */
export const PEOPLE_COLUMNS = [
  'employee_code',
  'legal_name',
  'preferred_name',
  'date_of_birth',
  'gender',
  'personal_email',
  'phone',
  'work_email',
  'legal_entity',
  'engagement_type',
  'joining_date',
  'confirmation_date',
  'status',
  'last_working_date',
  'exit_reason',
  'designation',
  'department',
  'location',
  'manager_code',
  'bucket',
  'ctc_amount',
  'ctc_rate_unit',
] as const;

export const REQUIRED_PEOPLE_COLUMNS = [
  'employee_code',
  'legal_name',
  'engagement_type',
  'joining_date',
  'designation',
  'department',
  'location',
  'bucket',
] as const;

export interface ImportLookups {
  today: string;
  existingCodes: ReadonlySet<string>;
  existingEmails: ReadonlySet<string>;
  /** Lower-cased name (and code, where there is one) → id. */
  designations: ReadonlyMap<string, string>;
  departments: ReadonlyMap<string, string>;
  locations: ReadonlyMap<string, string>;
  legalEntities: ReadonlyMap<string, string>;
  /** Used when the file leaves legal_entity blank and there is only one. */
  defaultLegalEntityId: string | null;
  buckets: readonly string[];
  engagementTypes: readonly string[];
}

export interface PersonRow {
  line: number;
  employeeCode: string;
  legalName: string;
  preferredName: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  personalEmail: string | null;
  phone: string | null;
  workEmail: string | null;
  legalEntityId: string;
  engagementType: string;
  joiningDate: string;
  confirmationDate: string | null;
  status: 'active' | 'on_notice' | 'exited';
  lastWorkingDate: string | null;
  exitReason: string | null;
  designationId: string;
  departmentId: string;
  locationId: string;
  managerCode: string | null;
  bucket: string;
  /** Current CTC in paise, and its rate unit. */
  ctc: { amount: string; rateUnit: string } | null;
}

export interface ImportError {
  line: number;
  message: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A real calendar date in YYYY-MM-DD (rejects 2026-02-30). */
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** "6,00,000" or "600000.50" rupees → paise digits; null if not an amount. */
export function rupeesToPaise(input: string): string | null {
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(input.replace(/[,\s₹]/g, ''));
  if (!match) return null;
  return (BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0')).toString();
}

/**
 * Checks every row; returns the rows that passed, every error found (with its line, the header
 * being line 1), and the order to load them in (managers before their reports).
 */
export function checkPeopleFile(
  records: Record<string, string>[],
  lookups: ImportLookups,
): { rows: PersonRow[]; errors: ImportError[]; order: string[] } {
  const errors: ImportError[] = [];
  if (records.length === 0) {
    return { rows: [], errors: [{ line: 1, message: 'The file has no rows' }], order: [] };
  }
  const header = Object.keys(records[0]!);
  const missing = REQUIRED_PEOPLE_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    return {
      rows: [],
      errors: [{ line: 1, message: `Missing columns: ${missing.join(', ')}` }],
      order: [],
    };
  }

  const rows: PersonRow[] = [];
  const codeLines = new Map<string, number>();
  const emailLines = new Map<string, number>();
  records.forEach((r, i) => {
    const line = i + 2;
    const fail = (message: string) => errors.push({ line, message });
    const v = (k: string) => (r[k] ?? '').trim();
    const opt = (k: string) => v(k) || null;
    const before = errors.length;

    const code = v('employee_code');
    if (!code) fail('employee_code is empty');
    else if (codeLines.has(code))
      fail(`Duplicate employee_code ${code} (also on line ${codeLines.get(code)})`);
    else if (lookups.existingCodes.has(code)) fail(`employee_code ${code} is already in iPro`);
    if (code && !codeLines.has(code)) codeLines.set(code, line);

    const email = opt('work_email')?.toLowerCase() ?? null;
    if (email) {
      if (!EMAIL.test(email)) fail(`work_email ${email} isn't an email address`);
      else if (emailLines.has(email))
        fail(`Duplicate work_email ${email} (also on line ${emailLines.get(email)})`);
      else if (lookups.existingEmails.has(email)) fail(`work_email ${email} is already in iPro`);
      if (!emailLines.has(email)) emailLines.set(email, line);
    }
    const personalEmail = opt('personal_email');
    if (personalEmail && !EMAIL.test(personalEmail)) fail("personal_email isn't an email address");

    if (!v('legal_name')) fail('legal_name is empty');

    const dates: Record<string, string | null> = {};
    for (const k of ['joining_date', 'date_of_birth', 'confirmation_date', 'last_working_date']) {
      const d = opt(k);
      if (d && !isRealDate(d)) fail(`${k} ${d} isn't a real date (use YYYY-MM-DD)`);
      dates[k] = d && isRealDate(d) ? d : null;
    }
    const joining = dates.joining_date;
    if (!v('joining_date')) fail('joining_date is empty');

    const status = (opt('status') ?? 'active').toLowerCase();
    if (!['active', 'on_notice', 'exited'].includes(status)) {
      fail(`status ${status} must be active, on_notice or exited`);
    }
    const lwd = dates.last_working_date;
    if ((status === 'exited' || status === 'on_notice') && !opt('last_working_date')) {
      fail(`${status} needs a last_working_date`);
    }
    if (status === 'active' && lwd)
      fail('an active person has no last_working_date (use on_notice)');
    if (status === 'exited' && lwd && lwd > lookups.today)
      fail('exited, but the last working day is still to come');
    if (status === 'on_notice' && lwd && lwd < lookups.today)
      fail('on notice, but the last working day has passed');
    if (joining && lwd && lwd < joining) fail('last_working_date is before joining_date');
    if (joining && dates.confirmation_date && dates.confirmation_date < joining) {
      fail('confirmation_date is before joining_date');
    }
    if (joining && dates.date_of_birth && dates.date_of_birth >= joining) {
      fail('date_of_birth is on or after joining_date');
    }
    if (joining && status === 'active' && joining > lookups.today) {
      fail('joining_date is in the future: add joiners through offers, not the import');
    }

    const type = v('engagement_type').toLowerCase();
    if (!lookups.engagementTypes.includes(type)) {
      fail(
        `engagement_type ${type || '(empty)'} must be one of ${lookups.engagementTypes.join(', ')}`,
      );
    }
    const bucket = v('bucket').toLowerCase();
    if (!lookups.buckets.includes(bucket))
      fail(`bucket ${bucket || '(empty)'} isn't one of iPro's buckets`);

    const find = (map: ReadonlyMap<string, string>, key: string, what: string) => {
      const value = v(key);
      const id = map.get(value.toLowerCase());
      if (!id) fail(`Unknown ${what} ${value || '(empty)'}`);
      return id ?? '';
    };
    const designationId = find(lookups.designations, 'designation', 'designation');
    const departmentId = find(lookups.departments, 'department', 'department');
    const locationId = find(lookups.locations, 'location', 'location');
    let legalEntityId = lookups.defaultLegalEntityId ?? '';
    if (opt('legal_entity'))
      legalEntityId = find(lookups.legalEntities, 'legal_entity', 'legal entity');
    else if (!legalEntityId) fail('legal_entity is empty and iPro has more than one');

    let ctc: PersonRow['ctc'] = null;
    if (opt('ctc_amount') || opt('ctc_rate_unit')) {
      const amount = rupeesToPaise(v('ctc_amount'));
      const unit = v('ctc_rate_unit').toLowerCase();
      if (!amount) fail(`ctc_amount ${v('ctc_amount') || '(empty)'} isn't an amount in rupees`);
      if (!['year', 'month', 'day', 'hour'].includes(unit)) {
        fail(`ctc_rate_unit ${unit || '(empty)'} must be year, month, day or hour`);
      }
      if (amount) ctc = { amount, rateUnit: unit };
    }

    const managerCode = opt('manager_code');
    if (managerCode && managerCode === code) fail('A person can’t be their own manager');

    if (errors.length === before) {
      rows.push({
        line,
        employeeCode: code,
        legalName: v('legal_name'),
        preferredName: opt('preferred_name'),
        dateOfBirth: dates.date_of_birth ?? null,
        gender: opt('gender'),
        personalEmail,
        phone: opt('phone'),
        workEmail: email,
        legalEntityId,
        engagementType: type,
        joiningDate: joining!,
        confirmationDate: dates.confirmation_date ?? null,
        status: status as PersonRow['status'],
        lastWorkingDate: lwd ?? null,
        exitReason: opt('exit_reason'),
        designationId,
        departmentId,
        locationId,
        managerCode,
        bucket,
        ctc,
      });
    }
  });

  // Managers must be in the file or already in iPro, and no one may manage themselves in a loop.
  const inFile = new Map(records.map((r, i) => [(r.employee_code ?? '').trim(), i + 2]));
  for (const row of rows) {
    if (
      row.managerCode &&
      !inFile.has(row.managerCode) &&
      !lookups.existingCodes.has(row.managerCode)
    ) {
      errors.push({
        line: row.line,
        message: `Manager ${row.managerCode} isn't in the file or in iPro`,
      });
    }
  }
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const byCode = new Map(rows.map((r) => [r.employeeCode, r]));
  const visit = (code: string, path: string[]): boolean => {
    if (state.get(code) === 'done') return true;
    if (state.get(code) === 'visiting') {
      const row = byCode.get(code)!;
      errors.push({ line: row.line, message: `Managers loop: ${[...path, code].join(' → ')}` });
      return false;
    }
    state.set(code, 'visiting');
    const manager = byCode.get(code)?.managerCode;
    const ok = !manager || !byCode.has(manager) || visit(manager, [...path, code]);
    state.set(code, 'done');
    order.push(code);
    return ok;
  };
  for (const row of rows) visit(row.employeeCode, []);
  errors.sort((a, b) => a.line - b.line);
  return { rows, errors, order };
}
