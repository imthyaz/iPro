import type { LeaveTypeInput } from '@ipro/shared';

/**
 * Leave rules that need no database (decisions #71, #72), so the accrual sample can be checked by
 * hand. Quantities are hundredths of a day.
 */

/**
 * The spec's proposed policy, confirmed by the owner (decisions #71, #73). Types are editable
 * afterwards.
 */
export const defaultLeaveTypes: (LeaveTypeInput & { sortOrder: number })[] = [
  type('CL', 'Casual leave', 'accrued', {
    daysPerYear: 12,
    creditOn: 'month_start',
    carryForwardCap: 0,
    sortOrder: 1,
  }),
  type('SL', 'Sick leave', 'accrued', {
    daysPerYear: 12,
    creditOn: 'month_start',
    carryForwardCap: 0,
    documentAfterDays: 2,
    sortOrder: 2,
  }),
  type('EL', 'Earned leave', 'accrued', {
    daysPerYear: 15,
    accruesAfterConfirmation: true,
    availableOnProbation: false,
    maxBalance: 30,
    carryForwardCap: 30,
    encashable: true,
    appliesTo: { engagementTypes: ['permanent', 'fixed_term'] },
    sortOrder: 3,
  }),
  type('CO', 'Comp-off', 'granted', { expiresAfterDays: 60, carryForwardCap: 0, sortOrder: 4 }),
  type('ML', 'Maternity leave', 'per_request', { maxDaysPerRequest: 182, sortOrder: 5 }),
  // Paternity and bereavement lengths aren't in the spec: proposed, to confirm (open questions).
  type('PTL', 'Paternity leave', 'per_request', { maxDaysPerRequest: 5, sortOrder: 6 }),
  type('BL', 'Bereavement leave', 'per_request', { maxDaysPerRequest: 3, sortOrder: 7 }),
  type('LOP', 'Loss of pay', 'unlimited', { paid: false, allowNegative: true, sortOrder: 8 }),
];

function type(
  code: string,
  name: string,
  kind: LeaveTypeInput['kind'],
  extra: Partial<LeaveTypeInput> & { sortOrder: number },
): LeaveTypeInput & { sortOrder: number } {
  return {
    code,
    name,
    kind,
    paid: true,
    daysPerYear: null,
    creditOn: 'month_end',
    accruesAfterConfirmation: false,
    availableOnProbation: true,
    maxBalance: null,
    carryForwardCap: null,
    encashable: false,
    documentAfterDays: null,
    allowNegative: false,
    maxDaysPerRequest: null,
    expiresAfterDays: null,
    // Employees on payroll and trainees/interns; retainers and consultants have no leave.
    appliesTo: { engagementTypes: ['permanent', 'fixed_term', 'trainee', 'intern'] },
    active: true,
    ...extra,
  };
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const daysInMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const dayCount = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
const shortDate = (iso: string) =>
  `${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1]!.slice(0, 3)}`;

/** Rounds hundredths of a day to the nearest half day (ties up). */
export const roundToHalfDay = (hundredths: number) => Math.round(hundredths / 50) * 50;

export interface AccrualFacts {
  joiningDate: string;
  lastWorkingDate: string | null;
  /** Null while on probation (or for a type with no probation). */
  confirmationDate: string | null;
  /** Whether the engagement has a probation at all. */
  hasProbation: boolean;
}

/**
 * One month's credit for an accrued type (decision #71): a twelfth of the yearly amount for a full
 * month; for part of a month (joining, leaving, or confirmation for types that accrue after it),
 * pro-rata by days, to the nearest half day. Returns the amount and the "why".
 */
export function monthlyAccrual(
  leaveType: { perYear: number; accruesAfterConfirmation: boolean },
  facts: AccrualFacts,
  month: string,
): { amount: number; note: string } {
  const first = `${month}-01`;
  const length = daysInMonth(month);
  const last = `${month}-${String(length).padStart(2, '0')}`;
  const name = MONTHS[Number(month.slice(5)) - 1]!;
  let from = first;
  let reason = '';
  if (facts.joiningDate > from) {
    from = facts.joiningDate;
    reason = `joined ${shortDate(facts.joiningDate)}`;
  }
  if (leaveType.accruesAfterConfirmation && facts.hasProbation) {
    if (!facts.confirmationDate) return { amount: 0, note: `${name}: on probation` };
    if (facts.confirmationDate > from) {
      from = facts.confirmationDate;
      reason = `confirmed ${shortDate(facts.confirmationDate)}`;
    }
  }
  let to = last;
  if (facts.lastWorkingDate && facts.lastWorkingDate < to) {
    to = facts.lastWorkingDate;
    reason = reason ? `${reason}, left ${shortDate(to)}` : `left ${shortDate(to)}`;
  }
  if (from > to) return { amount: 0, note: `${name}: not employed` };
  const monthly = Math.round(leaveType.perYear / 12);
  const covered = dayCount(from, to);
  const amount = covered === length ? monthly : roundToHalfDay((monthly * covered) / length);
  return {
    amount,
    note: `${name} accrual: ${covered} of ${length} days${reason ? ` (${reason})` : ''}`,
  };
}

/**
 * Year end: up to the cap carries into the next year and the rest lapses. A negative balance (for
 * types that allow it) carries in full.
 */
export function yearEnd(balance: number, carryForwardCap: number | null) {
  if (balance <= 0) return { carry: balance, lapse: 0 };
  const carry = carryForwardCap === null ? balance : Math.min(balance, carryForwardCap);
  return { carry, lapse: balance - carry };
}
