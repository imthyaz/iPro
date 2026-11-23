import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import type { ImportResult } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { Field, Note, Tabs } from '../../design-system/index.js';

type Kind = 'people' | 'kyc';

const TEMPLATES: Record<Kind, { columns: string; example: string; notes: string[] }> = {
  people: {
    columns:
      'employee_code,legal_name,preferred_name,date_of_birth,gender,personal_email,phone,work_email,legal_entity,engagement_type,joining_date,confirmation_date,status,last_working_date,exit_reason,designation,department,location,manager_code,bucket,ctc_amount,ctc_rate_unit',
    example:
      'IDS-0100,Anbu Arasu,,,,,,anbu@example.test,,permanent,2023-04-10,2023-10-10,active,,,Software Engineer,Engineering,Chennai office,,billable,"12,00,000",year',
    notes: [
      'One row a person, active or exited, with their current assignment.',
      'Dates as YYYY-MM-DD. status is active, on_notice or exited; the last two need a last_working_date.',
      'manager_code is the manager’s employee_code, in this file or already in iPro.',
      'designation, department, location and legal_entity use the names (or codes) set up in iPro.',
      'ctc_amount is the current CTC in rupees, with ctc_rate_unit year, month, day or hour.',
    ],
  },
  kyc: {
    columns: 'employee_code,type,value,ifsc',
    example: 'IDS-0100,pan,ABCDE1234F,',
    notes: [
      'type is pan, aadhaar, passport, bank, uan or esic; a bank row needs its IFSC.',
      'Values are encrypted when loaded and shown masked afterwards.',
    ],
  },
};

/**
 * A6 Import (slice 13b; decision #94): check a file, fix it until it has no errors, then load it.
 * Nothing loads while a single error remains. Leave balances have their own import (H9).
 */
export function Import() {
  const [kind, setKind] = useState<Kind>('people');
  return (
    <main className="page">
      <h1>Import</h1>
      <p className="muted">
        For moving people from the old system. Leave balances are loaded from{' '}
        <Link to="/leave-import">Leave balance import</Link>.
      </p>
      <Tabs
        label="File"
        tabs={[
          { id: 'people', label: 'People' },
          { id: 'kyc', label: 'KYC' },
        ]}
        active={kind}
        onChange={setKind}
      />
      <ImportFile key={kind} kind={kind} />
    </main>
  );
}

function ImportFile({ kind }: { kind: Kind }) {
  const [csv, setCsv] = useState('');
  const [checked, setChecked] = useState<ImportResult | null>(null);
  const run = useMutation({
    mutationFn: (commit: boolean) =>
      api<ImportResult>(`/imports/${kind}`, { body: { csv, commit } }),
    onSuccess: setChecked,
  });
  const template = TEMPLATES[kind];
  const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent(
    `${template.columns}\n${template.example}\n`,
  )}`;
  const canLoad = checked !== null && !checked.committed && checked.errors.length === 0 && csv;

  return (
    <section aria-label={`${kind === 'people' ? 'People' : 'KYC'} file`}>
      <ul className="muted">
        {template.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <p>
        <a href={templateHref} download={`ipro-${kind}-template.csv`}>
          Download the template
        </a>
      </p>
      <Field label="CSV file">
        {(id) => (
          <input
            id={id}
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              setChecked(null);
              setCsv(file ? await file.text() : '');
            }}
          />
        )}
      </Field>
      <div className="form-actions">
        <button
          className="button"
          disabled={!csv || run.isPending}
          onClick={() => run.mutate(false)}
        >
          Check
        </button>
        <button
          className="button button-primary"
          disabled={!canLoad || run.isPending}
          onClick={() => run.mutate(true)}
        >
          Load {checked?.ready ?? ''} rows
        </button>
      </div>
      {run.error && <Note kind="error">{errorMessage(run.error)}</Note>}
      {checked && (
        <div role="status" aria-label="Result">
          {checked.committed ? (
            <Note kind="info">
              Loaded {checked.ready} of {checked.rows} rows.
            </Note>
          ) : checked.errors.length === 0 ? (
            <Note kind="info">
              {checked.ready} of {checked.rows} rows are ready to load. Nothing has been loaded yet.
            </Note>
          ) : (
            <>
              <Note kind="error">
                {checked.errors.length} error{checked.errors.length === 1 ? '' : 's'} to fix.
                Nothing was loaded.
              </Note>
              <table className="report-table" aria-label="Errors">
                <thead>
                  <tr>
                    <th scope="col">Line</th>
                    <th scope="col">Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {checked.errors.map((e, i) => (
                    <tr key={`${e.line}-${i}`}>
                      <td>{e.line}</td>
                      <td>{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </section>
  );
}
