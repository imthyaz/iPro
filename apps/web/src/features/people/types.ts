import type { PersonSummary } from '@ipro/shared';

/** GET /api/people/:id */
export interface PersonDetail extends PersonSummary {
  profile: {
    dateOfBirth: string | null;
    gender: string | null;
    nationality: string | null;
    personalEmail: string | null;
    phone: string | null;
    priorExperienceMonths: number | null;
  };
  emergencyContacts: { id: string; name: string; relation: string; phone: string }[];
}

/** GET /api/people/:id/assignments */
export interface AssignmentRow {
  id: string;
  engagementId: string;
  employeeCode: string;
  engagementType: PersonSummary['engagementType'];
  effectiveFrom: string;
  effectiveTo: string | null;
  designation: { id: string; title: string };
  department: { id: string; name: string };
  location: { id: string; name: string };
  bucket: string;
  changeReason: string;
}

/** GET /api/people/:id/compensation */
export interface CompensationRow {
  id: string;
  employeeCode: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  amount: string;
  rateUnit: string;
  currency: string;
}
