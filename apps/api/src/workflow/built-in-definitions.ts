import type { WorkflowDefinition } from '@ipro/shared';

/**
 * Defaults for workflows the system starts itself, used until an admin saves a version (stored as
 * version 1 on first use). Like HR settings, they are configuration with a sensible starting point.
 */
export const builtInDefinitions: Record<string, WorkflowDefinition> = {
  /** New pay from a date, e.g. an unpaid intern becoming paid (decision #64): HR head approves. */
  pay_change: {
    name: 'Pay change',
    steps: [
      {
        id: 'hr_head',
        label: 'HR head approval',
        approver: { kind: 'role', role: 'hr_head' },
        authorize: { area: 'compensation', action: 'approve' },
      },
    ],
    onApproved: 'pay.apply',
  },
  /** Retainer to payroll, or intern to employee (decisions #42, #64): HR head, then CXO. */
  conversion: {
    name: 'Conversion',
    steps: [
      {
        id: 'hr_head',
        label: 'HR head approval',
        approver: { kind: 'role', role: 'hr_head' },
        authorize: { area: 'assignment_history', action: 'approve' },
      },
      {
        id: 'cxo',
        label: 'CXO approval',
        approver: { kind: 'role', role: 'cxo' },
        authorize: { area: 'assignment_history', action: 'read' },
      },
    ],
    onApproved: 'conversion.apply',
  },
  /** An in-life change of role from a date (spec workflow 8, decision #62): HR head approves. */
  inlife_change: {
    name: 'In-life change',
    steps: [
      {
        id: 'hr_head',
        label: 'HR head approval',
        approver: { kind: 'role', role: 'hr_head' },
        authorize: { area: 'assignment_history', action: 'approve' },
      },
    ],
    onApproved: 'change.apply',
  },
  /**
   * The decision on a probation review (spec workflow 3, decision #60): HR confirms or extends; a
   * termination needs HR head. The manager who wrote the review submits it.
   */
  probation_decision: {
    name: 'Probation decision',
    steps: [
      {
        id: 'hr',
        label: 'HR decision',
        approver: { kind: 'role', role: 'hr' },
        authorize: { area: 'probation_review', action: 'approve' },
        when: { field: 'needsHrHead', equals: false },
      },
      {
        id: 'hr_head',
        label: 'HR head decision (termination)',
        approver: { kind: 'role', role: 'hr_head' },
        authorize: { area: 'probation_review', action: 'terminate' },
        when: { field: 'needsHrHead', equals: true },
      },
    ],
    onApproved: 'review.decide',
  },
  /**
   * An offer (spec workflow 1, decision #54): the hiring manager, then HR head when the pay is above
   * the grade band or can't be compared with it. Approval sends the letter for e-signature.
   */
  offer_approval: {
    name: 'Offer approval',
    steps: [
      {
        id: 'hiring_manager',
        label: 'Hiring manager approval',
        approver: { kind: 'manager' },
        authorize: { area: 'profile', action: 'read' },
      },
      {
        id: 'hr_head',
        label: 'HR head approval (pay above band)',
        approver: { kind: 'role', role: 'hr_head' },
        authorize: { area: 'compensation', action: 'approve' },
        when: { field: 'needsHrHead', equals: true },
      },
    ],
    onApproved: 'offer.release',
  },
  /** Employee updates their own personal details (profile "U via request" in the permissions table). */
  profile_change: {
    name: 'Profile change request',
    steps: [
      {
        id: 'hr',
        label: 'HR review',
        approver: { kind: 'role', role: 'hr' },
        authorize: { area: 'profile', action: 'update' },
      },
    ],
    onApproved: 'profile.apply',
  },
  /**
   * A generated letter waits for the template's approver role before it is released or sent for
   * signature (decision #51). One conditional step per allowed role.
   */
  letter_approval: {
    name: 'Letter approval',
    steps: [
      {
        id: 'hr',
        label: 'HR approval',
        approver: { kind: 'role', role: 'hr' },
        authorize: { area: 'documents', action: 'update' },
        when: { field: 'approverRole', equals: 'hr' },
      },
      {
        id: 'hr_head',
        label: 'HR head approval',
        approver: { kind: 'role', role: 'hr_head' },
        authorize: { area: 'documents', action: 'update' },
        when: { field: 'approverRole', equals: 'hr_head' },
      },
    ],
    onApproved: 'letter.release',
  },
  /** A manager asks for a team member's shift to change (decision #47). One item per person. */
  shift_change: {
    name: 'Shift change request',
    steps: [
      {
        id: 'hr',
        label: 'HR approval',
        approver: { kind: 'role', role: 'hr' },
        authorize: { area: 'assignment_history', action: 'update' },
      },
    ],
    onApproved: 'shift.allocate',
    journey: {
      eventType: 'shift_changed',
      category: 'work',
      title: 'Shift changed',
      sensitivity: 'public',
    },
  },
};
