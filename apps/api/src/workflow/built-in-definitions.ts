import type { WorkflowDefinition } from '@ipro/shared';

/**
 * Defaults for workflows the system starts itself, used until an admin saves a version (stored as
 * version 1 on first use). Like HR settings, they are configuration with a sensible starting point.
 */
export const builtInDefinitions: Record<string, WorkflowDefinition> = {
  /**
   * A leave request (spec workflow 4, decision #74): the manager, then the manager's manager for leave
   * over the second-approval threshold (HR when there is none). The steps name who approves; the
   * check is that they can see the person's leave.
   */
  leave_request: {
    name: 'Leave request',
    steps: [
      {
        id: 'manager',
        label: 'Manager approval',
        approver: { kind: 'manager' },
        authorize: { area: 'leave', action: 'read' },
      },
      {
        id: 'manager_of_manager',
        label: 'Second approval (long leave)',
        approver: { kind: 'manager_of_manager' },
        authorize: { area: 'leave', action: 'read' },
        when: { field: 'needsSecondApproval', equals: true },
      },
    ],
    onApproved: 'leave.approve',
  },
  /** Comp-off for a weekly off or holiday worked (decisions #73, #76): the manager grants it. */
  comp_off_request: {
    name: 'Comp-off request',
    steps: [
      {
        id: 'manager',
        label: 'Manager approval',
        approver: { kind: 'manager' },
        authorize: { area: 'leave', action: 'read' },
      },
    ],
    onApproved: 'leave.grant_comp_off',
  },
  /**
   * A week below the hybrid policy (spec workflow 6; decision #78): the manager approves, whatever
   * their own role; the check is that they can see the person's bookings.
   */
  hybrid_exception: {
    name: 'Hybrid week below policy',
    steps: [
      {
        id: 'manager',
        label: 'Manager approval',
        approver: { kind: 'manager' },
        authorize: { area: 'hybrid_booking', action: 'read' },
      },
    ],
    onApproved: 'hybrid.approve_exception',
    journey: {
      eventType: 'hybrid_exception_approved',
      category: 'attendance',
      title: 'Hybrid week below policy approved',
      sensitivity: 'manager',
    },
  },
  /**
   * A resignation (spec workflow 7; decision #80): the manager after the retention conversation,
   * then HR, who fixes the last day; HR head too when the last day is earlier than the notice.
   * The manager's and HR's steps wait for what they record on the exit page.
   */
  resignation: {
    name: 'Resignation',
    steps: [
      {
        id: 'manager',
        label: 'Manager: retention conversation',
        approver: { kind: 'manager' },
        authorize: { area: 'exit', action: 'approve' },
      },
      {
        id: 'hr',
        label: 'HR: last working day',
        approver: { kind: 'role', role: 'hr' },
        authorize: { area: 'exit', action: 'update' },
      },
      {
        id: 'hr_head',
        label: 'HR head: early release',
        approver: { kind: 'role', role: 'hr_head' },
        authorize: { area: 'exit', action: 'approve' },
        when: { field: 'earlyRelease', equals: true },
      },
    ],
    onApproved: 'exit.accept_resignation',
  },
  /** Withdrawing an accepted resignation (spec workflow 7): the manager, then HR. */
  resignation_withdrawal: {
    name: 'Withdraw resignation',
    steps: [
      {
        id: 'manager',
        label: 'Manager approval',
        approver: { kind: 'manager' },
        authorize: { area: 'exit', action: 'approve' },
      },
      {
        id: 'hr',
        label: 'HR approval',
        approver: { kind: 'role', role: 'hr' },
        authorize: { area: 'exit', action: 'approve' },
      },
    ],
    onApproved: 'exit.withdraw',
  },
  /**
   * Correcting a day of attendance (spec workflow 5, decision #69): the employee's manager approves,
   * whatever their own role (e.g. HR head managing HR). The step already names who approves; the
   * check is that they can see the person's attendance.
   */
  attendance_regularisation: {
    name: 'Attendance regularisation',
    steps: [
      {
        id: 'manager',
        label: 'Manager approval',
        approver: { kind: 'manager' },
        authorize: { area: 'attendance', action: 'read' },
      },
    ],
    onApproved: 'attendance.regularise',
    journey: {
      eventType: 'attendance_regularised',
      category: 'attendance',
      title: 'Attendance regularised',
      sensitivity: 'manager',
    },
  },
  /** The decision on an intern's assessment (decision #65): HR decides; a conversion then goes to HR head and CXO. */
  internship_decision: {
    name: 'Internship decision',
    steps: [
      {
        id: 'hr',
        label: 'HR decision',
        approver: { kind: 'role', role: 'hr' },
        authorize: { area: 'probation_review', action: 'approve' },
      },
    ],
    onApproved: 'review.decide',
  },
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
