import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router';
import { queryClient } from './api.js';
import { apiStatusLabel, fetchApiStatus, type ApiStatus } from './api-status.js';
import { hasRole, SignIn, useMe, useSignOut } from './auth.js';
import { Note } from './design-system/index.js';
import { useOnboarding } from './features/onboarding/use-onboarding.js';
import { Inbox, useNotifications } from './features/inbox/Inbox.js';

// Speed (decision #97): the home page ships in the first download; every other screen loads when
// it is opened, so employees and managers don't download and parse HR and admin screens.
const Import = lazy(() =>
  import('./features/admin/Import.js').then((m) => ({ default: m.Import })),
);
const PolicyAdmin = lazy(() =>
  import('./features/admin/PolicyAdmin.js').then((m) => ({ default: m.PolicyAdmin })),
);
const AskIproPanel = lazy(() =>
  import('./features/assistant/AskIpro.js').then((m) => ({ default: m.AskIproPanel })),
);
const Templates = lazy(() =>
  import('./features/admin/Templates.js').then((m) => ({ default: m.Templates })),
);
const MyAttendance = lazy(() =>
  import('./features/attendance/Attendance.js').then((m) => ({ default: m.MyAttendance })),
);
const BiometricDevices = lazy(() =>
  import('./features/attendance/Devices.js').then((m) => ({ default: m.BiometricDevices })),
);
const AttendanceExceptions = lazy(() =>
  import('./features/attendance/Exceptions.js').then((m) => ({ default: m.AttendanceExceptions })),
);
const Holidays = lazy(() =>
  import('./features/holidays/Holidays.js').then((m) => ({ default: m.Holidays })),
);
const MyLeave = lazy(() =>
  import('./features/leave/Leave.js').then((m) => ({ default: m.MyLeave })),
);
const LeaveImport = lazy(() =>
  import('./features/leave/LeaveAdmin.js').then((m) => ({ default: m.LeaveImport })),
);
const LeaveTypes = lazy(() =>
  import('./features/leave/LeaveAdmin.js').then((m) => ({ default: m.LeaveTypes })),
);
const AllLeaveBalances = lazy(() =>
  import('./features/leave/LeaveHr.js').then((m) => ({ default: m.AllLeaveBalances })),
);
const PayrollExport = lazy(() =>
  import('./features/leave/LeaveHr.js').then((m) => ({ default: m.PayrollExport })),
);
const Seats = lazy(() =>
  import('./features/hybrid/HybridAdmin.js').then((m) => ({ default: m.Seats })),
);
const WorkPolicies = lazy(() =>
  import('./features/hybrid/HybridAdmin.js').then((m) => ({ default: m.WorkPolicies })),
);
const PlanWeek = lazy(() =>
  import('./features/hybrid/PlanWeek.js').then((m) => ({ default: m.PlanWeek })),
);
const MyJourney = lazy(() =>
  import('./features/journey/Journey.js').then((m) => ({ default: m.MyJourney })),
);
const TeamJourneys = lazy(() =>
  import('./features/journey/TeamJourneys.js').then((m) => ({ default: m.TeamJourneys })),
);
const ExitTracker = lazy(() =>
  import('./features/exit/Exit.js').then((m) => ({ default: m.ExitTracker })),
);
const Resign = lazy(() => import('./features/exit/Exit.js').then((m) => ({ default: m.Resign })));
const HybridCompliance = lazy(() =>
  import('./features/hybrid/Team.js').then((m) => ({ default: m.HybridCompliance })),
);
const TeamCalendar = lazy(() =>
  import('./features/hybrid/Team.js').then((m) => ({ default: m.TeamCalendar })),
);
const TeamToday = lazy(() =>
  import('./features/hybrid/Team.js').then((m) => ({ default: m.TeamToday })),
);
const ChecklistRuns = lazy(() =>
  import('./features/checklists/ChecklistRuns.js').then((m) => ({ default: m.ChecklistRuns })),
);
const NewOffer = lazy(() =>
  import('./features/offers/NewOffer.js').then((m) => ({ default: m.NewOffer })),
);
const Offers = lazy(() =>
  import('./features/offers/Offers.js').then((m) => ({ default: m.Offers })),
);
const Probation = lazy(() =>
  import('./features/reviews/Probation.js').then((m) => ({ default: m.Probation })),
);
const Reviews = lazy(() =>
  import('./features/reviews/Reviews.js').then((m) => ({ default: m.Reviews })),
);
const NotificationsPage = lazy(() =>
  import('./features/inbox/NotificationsPage.js').then((m) => ({ default: m.NotificationsPage })),
);
const OrgSetup = lazy(() =>
  import('./features/org/OrgSetup.js').then((m) => ({ default: m.OrgSetup })),
);
const OrgTree = lazy(() =>
  import('./features/org/OrgTree.js').then((m) => ({ default: m.OrgTree })),
);
const Directory = lazy(() =>
  import('./features/people/Directory.js').then((m) => ({ default: m.Directory })),
);
const NewPerson = lazy(() =>
  import('./features/people/NewPerson.js').then((m) => ({ default: m.NewPerson })),
);
const PersonRecord = lazy(() =>
  import('./features/people/PersonRecord.js').then((m) => ({ default: m.PersonRecord })),
);
const MyPolicies = lazy(() =>
  import('./features/policies/MyPolicies.js').then((m) => ({ default: m.MyPolicies })),
);
const Reports = lazy(() =>
  import('./features/reports/Reports.js').then((m) => ({ default: m.Reports })),
);
const Requests = lazy(() =>
  import('./features/requests/Requests.js').then((m) => ({ default: m.Requests })),
);
const Shifts = lazy(() =>
  import('./features/shifts/Shifts.js').then((m) => ({ default: m.Shifts })),
);
const Onboarding = lazy(() =>
  import('./features/onboarding/Onboarding.js').then((m) => ({ default: m.Onboarding })),
);

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
  const unread = useUnread(Boolean(user));
  const [asking, setAsking] = useState(false);
  const seesPeople = hasRole(user, 'manager', 'hr', 'hr_head', 'cxo');
  const seesOrgSetup = hasRole(user, 'hr', 'hr_head', 'admin');
  const seesChecklists = hasRole(user, 'hr', 'hr_head');
  const seesOffers = hasRole(user, 'hr', 'hr_head', 'manager');
  const seesProbation = hasRole(user, 'hr', 'hr_head');
  const seesReports = hasRole(user, 'hr', 'hr_head', 'cxo');
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
              <button
                className="button ask-button"
                aria-expanded={asking}
                onClick={() => setAsking((open) => !open)}
              >
                Ask iPro
              </button>
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
          <NavLink to="/notifications" className="nav-item">
            Notifications{unread > 0 ? ` (${unread})` : ''}
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
            <NavLink to="/journey" className="nav-item">
              My journey
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
          {hasRole(user, 'hr', 'hr_head', 'manager', 'cxo') && (
            <NavLink to="/team-journeys" className="nav-item">
              Team journeys
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
          {seesReports && (
            <NavLink to="/reports" className="nav-item">
              Reports
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
          {hasRole(user, 'hr', 'hr_head') && (
            <NavLink to="/import" className="nav-item">
              Import people
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
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <Routes>
              <Route path="/" element={<Inbox />} />
              <Route path="/approvals" element={<Inbox />} />
              <Route path="/tasks" element={<Inbox />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/attendance" element={<MyAttendance />} />
              <Route path="/devices" element={<BiometricDevices />} />
              <Route path="/attendance-exceptions" element={<AttendanceExceptions />} />
              <Route path="/leave" element={<MyLeave />} />
              <Route path="/hybrid" element={<PlanWeek />} />
              <Route path="/journey" element={<MyJourney />} />
              <Route path="/team-journeys" element={<TeamJourneys />} />
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
              <Route path="/import" element={<Import />} />
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
          </Suspense>
        )}
      </div>
      {user && asking && (
        <Suspense fallback={null}>
          <AskIproPanel onClose={() => setAsking(false)} />
        </Suspense>
      )}
    </div>
  );
}

/** Unread notifications for the nav, once signed in. */
function useUnread(signedIn: boolean): number {
  const notes = useNotifications(signedIn);
  return notes.data?.filter((n) => !n.read).length ?? 0;
}
