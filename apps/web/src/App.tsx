import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router';
import { queryClient } from './api.js';
import { apiStatusLabel, fetchApiStatus, type ApiStatus } from './api-status.js';
import { hasRole, SignIn, useMe, useSignOut } from './auth.js';
import { Note } from './design-system/index.js';
import { PolicyAdmin } from './features/admin/PolicyAdmin.js';
import { Templates } from './features/admin/Templates.js';
import { MyAttendance } from './features/attendance/Attendance.js';
import { BiometricDevices } from './features/attendance/Devices.js';
import { AttendanceExceptions } from './features/attendance/Exceptions.js';
import { Holidays } from './features/holidays/Holidays.js';
import { MyLeave } from './features/leave/Leave.js';
import { LeaveImport, LeaveTypes } from './features/leave/LeaveAdmin.js';
import { AllLeaveBalances, PayrollExport } from './features/leave/LeaveHr.js';
import { Seats, WorkPolicies } from './features/hybrid/HybridAdmin.js';
import { PlanWeek } from './features/hybrid/PlanWeek.js';
import { ExitTracker, Resign } from './features/exit/Exit.js';
import { HybridCompliance, TeamCalendar, TeamToday } from './features/hybrid/Team.js';
import { ChecklistRuns } from './features/checklists/ChecklistRuns.js';
import { NewOffer } from './features/offers/NewOffer.js';
import { Offers } from './features/offers/Offers.js';
import { Probation } from './features/reviews/Probation.js';
import { Reviews } from './features/reviews/Reviews.js';
import { Onboarding, useOnboarding } from './features/onboarding/Onboarding.js';
import { Inbox } from './features/inbox/Inbox.js';
import { OrgSetup } from './features/org/OrgSetup.js';
import { OrgTree } from './features/org/OrgTree.js';
import { Directory } from './features/people/Directory.js';
import { NewPerson } from './features/people/NewPerson.js';
import { PersonRecord } from './features/people/PersonRecord.js';
import { MyPolicies } from './features/policies/MyPolicies.js';
import { Requests } from './features/requests/Requests.js';
import { Shifts } from './features/shifts/Shifts.js';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function Shell() {
  const me = useMe();
  const signOut = useSignOut();
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking');
  useEffect(() => {
    void fetchApiStatus().then(setApiStatus);
  }, []);

  const user = me.data;
  const onboarding = useOnboarding(Boolean(user?.personId));
  const seesPeople = hasRole(user, 'manager', 'hr', 'hr_head', 'cxo');
  const seesOrgSetup = hasRole(user, 'hr', 'hr_head', 'admin');
  const seesChecklists = hasRole(user, 'hr', 'hr_head');
  const seesOffers = hasRole(user, 'hr', 'hr_head', 'manager');
  const seesProbation = hasRole(user, 'hr', 'hr_head');
  const seesShifts = hasRole(user, 'hr', 'hr_head', 'admin', 'manager');

  return (
    <div className="shell">
      <header className="shell-header">
        <span className="brand">iPro</span>
        <span className="header-side">
          <span className={`status status-${apiStatus}`} role="status" data-testid="api-status">
            {apiStatusLabel[apiStatus]}
          </span>
          {user && (
            <>
              <span className="muted user-name">{user.displayName}</span>
              <button className="button button-quiet" onClick={() => signOut.mutate()}>
                Sign out
              </button>
            </>
          )}
        </span>
      </header>
      {user && (
        <nav className="shell-nav" aria-label="Main">
          <NavLink to="/" end className="nav-item">
            Action inbox
          </NavLink>
          {onboarding.data && (
            <NavLink to="/onboarding" className="nav-item">
              Onboarding
            </NavLink>
          )}
          {user.personId && (
            <NavLink to="/me" className="nav-item">
              My profile
            </NavLink>
          )}
          {user.personId && (
            <NavLink to="/attendance" className="nav-item">
              My attendance
            </NavLink>
          )}
          {user.personId && (
            <NavLink to="/leave" className="nav-item">
              My leave
            </NavLink>
          )}
          {user.personId && (
            <NavLink to="/hybrid" className="nav-item">
              Plan my week
            </NavLink>
          )}
          <NavLink to="/requests" className="nav-item">
            My requests
          </NavLink>
          {user.personId && (
            <NavLink to="/policies" className="nav-item">
              Policies
            </NavLink>
          )}
          {hasRole(user, 'hr', 'hr_head', 'manager') && (
            <NavLink to="/exits" className="nav-item">
              Exits
            </NavLink>
          )}
          {hasRole(user, 'hr', 'hr_head', 'manager') && (
            <NavLink to="/team-today" className="nav-item">
              Team today
            </NavLink>
          )}
          {hasRole(user, 'hr', 'hr_head', 'manager') && (
            <NavLink to="/team-calendar" className="nav-item">
              Team calendar
            </NavLink>
          )}
          {hasRole(user, 'hr', 'hr_head', 'manager') && (
            <NavLink to="/hybrid-compliance" className="nav-item">
              Hybrid compliance
            </NavLink>
          )}
          {hasRole(user, 'hr', 'hr_head', 'manager') && (
            <NavLink to="/attendance-exceptions" className="nav-item">
              Attendance exceptions
            </NavLink>
          )}
          {seesPeople && (
            <NavLink to="/people" className="nav-item">
              People
            </NavLink>
          )}
          {seesPeople && (
            <NavLink to="/org-tree" className="nav-item">
              Org tree
            </NavLink>
          )}
          {seesOffers && (
            <NavLink to="/reviews" className="nav-item">
              Reviews
            </NavLink>
          )}
          {seesProbation && (
            <NavLink to="/probation" className="nav-item">
              Probation
            </NavLink>
          )}
          {seesOffers && (
            <NavLink to="/offers" className="nav-item">
              Offers
            </NavLink>
          )}
          {seesChecklists && (
            <NavLink to="/checklists" className="nav-item">
              Checklists
            </NavLink>
          )}
          {seesShifts && (
            <NavLink to="/shifts" className="nav-item">
              Shifts
            </NavLink>
          )}
          {seesOrgSetup && (
            <NavLink to="/org-setup" className="nav-item">
              Organisation setup
            </NavLink>
          )}
          {seesOrgSetup && (
            <NavLink to="/holidays" className="nav-item">
              Holidays
            </NavLink>
          )}
          {hasRole(user, 'admin', 'hr_head') && (
            <NavLink to="/devices" className="nav-item">
              Check-in sites
            </NavLink>
          )}
          {seesOrgSetup && (
            <NavLink to="/work-policies" className="nav-item">
              Work policies
            </NavLink>
          )}
          {seesOrgSetup && (
            <NavLink to="/seats" className="nav-item">
              Seats
            </NavLink>
          )}
          {seesOrgSetup && (
            <NavLink to="/leave-types" className="nav-item">
              Leave types
            </NavLink>
          )}
          {hasRole(user, 'hr', 'hr_head') && (
            <NavLink to="/leave-balances" className="nav-item">
              Leave balances
            </NavLink>
          )}
          {hasRole(user, 'hr', 'hr_head') && (
            <NavLink to="/payroll-export" className="nav-item">
              Payroll export
            </NavLink>
          )}
          {hasRole(user, 'hr', 'hr_head') && (
            <NavLink to="/leave-import" className="nav-item">
              Import leave
            </NavLink>
          )}
          {seesOrgSetup && (
            <NavLink to="/templates" className="nav-item">
              Templates
            </NavLink>
          )}
          {seesOrgSetup && (
            <NavLink to="/policy-admin" className="nav-item">
              Policy documents
            </NavLink>
          )}
        </nav>
      )}
      <div className="shell-main">
        {me.isLoading && <p className="muted">Loading…</p>}
        {me.error && (
          <Note kind="error">iPro can’t reach the server. Please try again shortly.</Note>
        )}
        {me.data === null && <SignIn />}
        {user && (
          <Routes>
            <Route path="/" element={<Inbox />} />
            <Route path="/approvals" element={<Inbox />} />
            <Route path="/tasks" element={<Inbox />} />
            <Route path="/attendance" element={<MyAttendance />} />
            <Route path="/devices" element={<BiometricDevices />} />
            <Route path="/attendance-exceptions" element={<AttendanceExceptions />} />
            <Route path="/leave" element={<MyLeave />} />
            <Route path="/hybrid" element={<PlanWeek />} />
            <Route path="/resign" element={<Resign />} />
            <Route path="/exits" element={<ExitTracker />} />
            <Route path="/exits/:exitId" element={<ExitTracker />} />
            <Route path="/team-today" element={<TeamToday />} />
            <Route path="/team-calendar" element={<TeamCalendar />} />
            <Route path="/hybrid-compliance" element={<HybridCompliance />} />
            <Route path="/work-policies" element={<WorkPolicies />} />
            <Route path="/work-policies/:policyId" element={<WorkPolicies />} />
            <Route path="/seats" element={<Seats />} />
            <Route path="/leave-types" element={<LeaveTypes />} />
            <Route path="/leave-types/:typeId" element={<LeaveTypes />} />
            <Route path="/leave-import" element={<LeaveImport />} />
            <Route path="/leave-balances" element={<AllLeaveBalances />} />
            <Route path="/payroll-export" element={<PayrollExport />} />
            <Route path="/requests" element={<Requests />} />
            <Route path="/requests/:requestId" element={<Requests />} />
            <Route path="/policies" element={<MyPolicies />} />
            <Route path="/onboarding" element={<Onboarding />} />
            <Route
              path="/me"
              element={
                user.personId ? (
                  <main className="page">
                    <PersonRecord personId={user.personId} />
                  </main>
                ) : (
                  <Navigate to="/" />
                )
              }
            />
            <Route path="/people" element={<Directory />} />
            <Route path="/people/new" element={<NewPerson />} />
            <Route path="/people/:personId" element={<Directory />} />
            <Route path="/org-tree" element={<OrgTree />} />
            <Route path="/org-setup" element={<OrgSetup />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/templates/:kind" element={<Templates />} />
            <Route path="/templates/:kind/:templateKey" element={<Templates />} />
            <Route path="/policy-admin" element={<PolicyAdmin />} />
            <Route path="/policy-admin/:policyId" element={<PolicyAdmin />} />
            <Route path="/holidays" element={<Holidays />} />
            <Route path="/holidays/:calendarId" element={<Holidays />} />
            <Route path="/shifts" element={<Shifts />} />
            <Route path="/shifts/:shiftId" element={<Shifts />} />
            <Route path="/reviews" element={<Reviews />} />
            <Route path="/reviews/:reviewId" element={<Reviews />} />
            <Route path="/probation" element={<Probation />} />
            <Route path="/offers" element={<Offers />} />
            <Route path="/offers/new" element={<NewOffer />} />
            <Route path="/offers/:offerId" element={<Offers />} />
            <Route path="/checklists" element={<ChecklistRuns />} />
            <Route path="/checklists/:runId" element={<ChecklistRuns />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        )}
      </div>
    </div>
  );
}
