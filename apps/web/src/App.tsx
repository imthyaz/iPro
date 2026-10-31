import { useEffect, useState } from 'react';
import { apiStatusLabel, fetchApiStatus, type ApiStatus } from './api-status.js';

// Placeholder shell. Real navigation arrives with each module; home becomes the Action inbox (slice 11).
const sections = ['Action inbox', 'Attendance', 'Leave', 'Plan my week', 'My journey'];

export function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking');

  useEffect(() => {
    void fetchApiStatus().then(setApiStatus);
  }, []);

  return (
    <div className="shell">
      <header className="shell-header">
        <span className="brand">iPro</span>
        <span className={`status status-${apiStatus}`} role="status" data-testid="api-status">
          {apiStatusLabel[apiStatus]}
        </span>
      </header>
      <nav className="shell-nav" aria-label="Main">
        {sections.map((section) => (
          <span key={section} className="nav-item" aria-disabled="true">
            {section}
          </span>
        ))}
      </nav>
      <main className="shell-main">
        <h1>Action inbox</h1>
        <p>
          Nothing here yet. Approvals, tasks and reminders will appear here as modules are built.
        </p>
      </main>
    </div>
  );
}
