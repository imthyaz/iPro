import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import type { OrgTree as OrgTreeData } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { Empty, Field, formatDate, Note, Tabs, todayIso } from '../../design-system/index.js';

type Person = OrgTreeData['people'][number];
type Department = OrgTreeData['departments'][number];

/** Groups a flat list into children by parent id; null parent = root. */
function childrenOf<T>(items: T[], parent: (item: T) => string | null) {
  const map = new Map<string | null, T[]>();
  for (const item of items) {
    const key = parent(item);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return map;
}

/** Org tree as of a date (H10): who reported to whom, or how departments nested, on that day. */
export function OrgTree() {
  const [asOf, setAsOf] = useState(todayIso());
  const [view, setView] = useState<'people' | 'departments'>('people');
  const tree = useQuery({
    queryKey: ['org-tree', asOf],
    queryFn: () => api<OrgTreeData>(`/org-tree?asOf=${asOf}`),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(asOf),
  });

  return (
    <main className="page">
      <div className="toolbar">
        <h1>Org tree</h1>
        <Field label="As of">
          {(id) => (
            <input id={id} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          )}
        </Field>
      </div>
      <Tabs
        label="Tree view"
        active={view}
        onChange={setView}
        tabs={[
          { id: 'people', label: 'Reporting lines' },
          { id: 'departments', label: 'Departments' },
        ]}
      />
      {tree.error && <Note kind="error">{errorMessage(tree.error)}</Note>}
      {tree.data && (
        <section className="tab-panel" role="tabpanel" aria-labelledby={`tab-${view}`}>
          <p className="muted">As it stood on {formatDate(tree.data.asOf)}.</p>
          {view === 'people' ? (
            <PeopleTree people={tree.data.people} />
          ) : (
            <DepartmentTree departments={tree.data.departments} />
          )}
        </section>
      )}
    </main>
  );
}

function PeopleTree({ people }: { people: Person[] }) {
  if (people.length === 0) return <Empty>No one was in the organisation on this date.</Empty>;
  const reports = childrenOf(people, (p) => p.managerPersonId);
  const render = (parent: string | null, depth: number) => (
    <ul
      className={depth === 0 ? 'tree' : 'tree-children'}
      aria-label={depth === 0 ? 'Reporting lines' : undefined}
    >
      {reports.get(parent)?.map((person) => (
        <li key={person.personId}>
          <Link to={`/people/${person.personId}`} className="tree-node">
            <strong>{person.name}</strong>
            <span className="muted">
              {person.designation} · {person.departmentName}
            </span>
          </Link>
          {reports.has(person.personId) && render(person.personId, depth + 1)}
        </li>
      ))}
    </ul>
  );
  return render(null, 0);
}

function DepartmentTree({ departments }: { departments: Department[] }) {
  if (departments.length === 0) return <Empty>No departments on this date.</Empty>;
  const children = childrenOf(departments, (d) => d.parentDepartmentId);
  const render = (parent: string | null, depth: number) => (
    <ul
      className={depth === 0 ? 'tree' : 'tree-children'}
      aria-label={depth === 0 ? 'Departments' : undefined}
    >
      {children.get(parent)?.map((department) => (
        <li key={department.departmentId}>
          <span className="tree-node">
            <strong>{department.name}</strong>
            <span className="muted">
              {department.businessUnitName} · {department.headcount}{' '}
              {department.headcount === 1 ? 'person' : 'people'}
            </span>
          </span>
          {children.has(department.departmentId) && render(department.departmentId, depth + 1)}
        </li>
      ))}
    </ul>
  );
  return render(null, 0);
}
