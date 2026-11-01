import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router';
import { queryClient } from './api.js';
import { apiStatusLabel, fetchApiStatus, type ApiStatus } from './api-status.js';
import { hasRole, SignIn, useMe, useSignOut } from './auth.js';
import { Note } from './design-system/index.js';
import { PolicyAdmin } from './features/admin/PolicyAdmin.js';
import { Templates } from './features/admin/Templates.js';
import { ChecklistRuns } from './features/checklists/ChecklistRuns.js';
import { NewOffer } from './features/offers/NewOffer.js';
import { Offers } from './features/offers/Offers.js';
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
          <NavLink to="/requests" className="nav-item">
            My requests
          </NavLink>
          {user.personId && (
            <NavLink to="/policies" className="nav-item">
              Policies
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
            <Route path="/shifts" element={<Shifts />} />
            <Route path="/shifts/:shiftId" element={<Shifts />} />
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
