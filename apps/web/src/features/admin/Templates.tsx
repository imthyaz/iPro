import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  checklistStageSchema,
  letterMergeFields,
  letterTypeSchema,
  roles,
  type AppliesTo,
  type ChecklistTemplateInput,
  type LetterTemplateInput,
  type LetterTemplateView,
  type TaskOwner,
} from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { hasRole, useMe } from '../../auth.js';
import { Chip, Empty, Field, ListDetail, Note, Tabs } from '../../design-system/index.js';
import { AppliesToEditor, describeAppliesTo, useOrgLookups } from './AppliesTo.js';

type Kind = 'checklists' | 'letters';
type ChecklistTemplate = ChecklistTemplateInput & { key: string; version: number };

const KEY = /^[a-z][a-z0-9_.]*$/;
const stageWords = { onboarding: 'Onboarding', exit: 'Exit', transfer: 'Transfer' } as const;
const roleWords: Record<(typeof roles)[number], string> = {
  employee: 'Employee',
  manager: 'Manager',
  hr: 'HR',
  hr_head: 'HR head',
  cxo: 'CXO',
  admin: 'Admin',
};

/**
 * Templates (A3): checklists and letters. Each save is a new version; checklists and letters already
 * started keep the version they were made from.
 */
export function Templates() {
  const { kind = 'checklists', templateKey } = useParams();
  const navigate = useNavigate();
  const me = useMe().data;
  const canEdit = hasRole(me, 'admin', 'hr_head');
  const active = kind as Kind;
  const base = `/templates/${active}`;

  const list = (
    <>
      <div className="toolbar">
        <h1>Templates</h1>
        {canEdit && (
          <Link className="button button-primary" to={`${base}/new`}>
            New {active === 'checklists' ? 'checklist' : 'letter'}
          </Link>
        )}
      </div>
      <Tabs
        label="Template kinds"
        active={active}
        onChange={(id) => navigate(`/templates/${id}`)}
        tabs={[
          { id: 'checklists', label: 'Checklists' },
          { id: 'letters', label: 'Letters' },
        ]}
      />
      <section className="tab-panel" role="tabpanel" aria-labelledby={`tab-${active}`}>
        {active === 'checklists' ? (
          <ChecklistList selected={templateKey} />
        ) : (
          <LetterList selected={templateKey} />
        )}
      </section>
    </>
  );

  const detail = !templateKey ? null : active === 'checklists' ? (
    <ChecklistEditor key={templateKey} templateKey={templateKey} canEdit={canEdit} />
  ) : (
    <LetterEditor key={templateKey} templateKey={templateKey} canEdit={canEdit} />
  );
  return (
    <ListDetail list={list} detail={detail} onClose={() => navigate(base)} detailLabel="Template" />
  );
}

const useChecklistTemplates = () =>
  useQuery({
    queryKey: ['checklist-templates'],
    queryFn: () => api<ChecklistTemplate[]>('/checklist-templates'),
  });
const useLetterTemplates = () =>
  useQuery({
    queryKey: ['letter-templates'],
    queryFn: () => api<LetterTemplateView[]>('/letter-templates'),
  });

function ChecklistList({ selected }: { selected?: string }) {
  const templates = useChecklistTemplates();
  const lookups = useOrgLookups();
  if (templates.error) return <Note kind="error">{errorMessage(templates.error)}</Note>;
  if (templates.data?.length === 0) return <Empty>No checklist templates yet.</Empty>;
  return (
    <ul className="rows" aria-label="Checklist templates">
      {templates.data?.map((t) => (
        <li key={t.key}>
          <Link
            to={`/templates/checklists/${t.key}`}
            className={t.key === selected ? 'row row-selected' : 'row'}
          >
            <span className="row-main">
              <strong>{t.name}</strong>
              <span className="muted">
                {stageWords[t.stage]} · {t.tasks.length} tasks ·{' '}
                {describeAppliesTo(t.appliesTo, lookups)}
              </span>
            </span>
            <Chip tone="muted">v{t.version}</Chip>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function LetterList({ selected }: { selected?: string }) {
  const templates = useLetterTemplates();
  if (templates.error) return <Note kind="error">{errorMessage(templates.error)}</Note>;
  if (templates.data?.length === 0) return <Empty>No letter templates yet.</Empty>;
  return (
    <ul className="rows" aria-label="Letter templates">
      {templates.data?.map((t) => (
        <li key={t.key}>
          <Link
            to={`/templates/letters/${t.key}`}
            className={t.key === selected ? 'row row-selected' : 'row'}
          >
            <span className="row-main">
              <strong>{t.name}</strong>
              <span className="muted">
                {t.type} · {t.signature === 'employee' ? 'e-signed' : 'no signature'}
                {t.approverRole ? ` · approved by ${roleWords[t.approverRole]}` : ''}
              </span>
            </span>
            <Chip tone="muted">v{t.version}</Chip>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The template key for a new template: chosen once, then fixed. */
function KeyField({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  return (
    <Field label="Key" hint="Lower case, e.g. onboarding_engineering. It can’t change later.">
      {(id) => (
        <input
          id={id}
          required
          pattern={KEY.source}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

type TaskRow = ChecklistTemplateInput['tasks'][number];
const blankTask = (): TaskRow => ({
  title: '',
  owner: { kind: 'employee' },
  dueOffsetDays: 0,
  mandatory: true,
  requiresDocument: false,
});

const ownerValue = (owner: TaskOwner) =>
  owner.kind === 'role' ? `role:${owner.role}` : owner.kind === 'user' ? 'user' : owner.kind;

function ChecklistEditor({ templateKey, canEdit }: { templateKey: string; canEdit: boolean }) {
  const isNew = templateKey === 'new';
  const client = useQueryClient();
  const navigate = useNavigate();
  const templates = useChecklistTemplates();
  const existing = templates.data?.find((t) => t.key === templateKey);
  const [draft, setDraft] = useState<(ChecklistTemplateInput & { key: string }) | null>(null);
  const loaded = isNew || existing;
  const form =
    draft ??
    (existing
      ? { ...existing }
      : {
          key: '',
          name: '',
          stage: 'onboarding' as const,
          appliesTo: {} as AppliesTo,
          tasks: [blankTask()],
        });
  const update = (patch: Partial<typeof form>) => setDraft({ ...form, ...patch });
  const setTask = (index: number, patch: Partial<TaskRow>) =>
    update({ tasks: form.tasks.map((t, i) => (i === index ? { ...t, ...patch } : t)) });

  const save = useMutation({
    mutationFn: () => {
      const { key, name, stage, appliesTo, tasks } = form;
      return api<ChecklistTemplate>(`/checklist-templates/${key}`, {
        method: 'PUT',
        body: { name, stage, appliesTo, tasks },
      });
    },
    onSuccess: async (saved) => {
      setDraft(null);
      await client.invalidateQueries({ queryKey: ['checklist-templates'] });
      if (isNew) navigate(`/templates/checklists/${saved.key ?? form.key}`);
    },
  });

  if (templates.error) return <Note kind="error">{errorMessage(templates.error)}</Note>;
  if (!loaded) return templates.data ? <Note kind="error">Not found.</Note> : <p>Loading…</p>;

  return (
    <form
      className="record"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <header className="record-header">
        <h2>{isNew ? 'New checklist' : form.name}</h2>
        {existing && (
          <p className="muted">
            Version {existing.version}. Saving makes version {existing.version + 1}; checklists
            already started keep theirs.
          </p>
        )}
      </header>
      <fieldset disabled={!canEdit} className="plain-fieldset">
        <div className="form-grid">
          {isNew && <KeyField value={form.key} onChange={(key) => update({ key })} />}
          <Field label="Name">
            {(id) => (
              <input
                id={id}
                required
                value={form.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Stage">
            {(id) => (
              <select
                id={id}
                value={form.stage}
                onChange={(e) =>
                  update({ stage: e.target.value as ChecklistTemplateInput['stage'] })
                }
              >
                {checklistStageSchema.options.map((s) => (
                  <option key={s} value={s}>
                    {stageWords[s]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <AppliesToEditor value={form.appliesTo} onChange={(appliesTo) => update({ appliesTo })} />

        <h3>Tasks</h3>
        <p className="muted field-hint">
          Due days count from the anchor date (joining day, last working day…); negative means
          before it.
        </p>
        <ol className="task-editor" aria-label="Tasks">
          {form.tasks.map((task, i) => (
            <li key={i} className="card" aria-label={`Task ${i + 1}`}>
              <Field label="Task">
                {(id) => (
                  <input
                    id={id}
                    required
                    value={task.title}
                    onChange={(e) => setTask(i, { title: e.target.value })}
                  />
                )}
              </Field>
              <div className="form-grid">
                <Field label="Done by">
                  {(id) => (
                    <select
                      id={id}
                      value={ownerValue(task.owner)}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === 'user') return;
                        setTask(i, {
                          owner: v.startsWith('role:')
                            ? { kind: 'role', role: v.slice(5) as (typeof roles)[number] }
                            : { kind: v as 'employee' | 'manager' },
                        });
                      }}
                    >
                      <option value="employee">The person</option>
                      <option value="manager">Their manager</option>
                      {roles
                        .filter((r) => r !== 'employee' && r !== 'manager')
                        .map((r) => (
                          <option key={r} value={`role:${r}`}>
                            {roleWords[r]}
                          </option>
                        ))}
                      {task.owner.kind === 'user' && (
                        <option value="user">{task.owner.label}</option>
                      )}
                    </select>
                  )}
                </Field>
                <Field label="Due (days)">
                  {(id) => (
                    <input
                      id={id}
                      type="number"
                      min={-180}
                      max={365}
                      value={task.dueOffsetDays}
                      onChange={(e) => setTask(i, { dueOffsetDays: Number(e.target.value) })}
                    />
                  )}
                </Field>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={task.mandatory}
                  onChange={(e) => setTask(i, { mandatory: e.target.checked })}
                />
                Mandatory
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={task.requiresDocument}
                  onChange={(e) => setTask(i, { requiresDocument: e.target.checked })}
                />
                Needs a document
              </label>
              {canEdit && form.tasks.length > 1 && (
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => update({ tasks: form.tasks.filter((_, j) => j !== i) })}
                >
                  Remove task
                </button>
              )}
            </li>
          ))}
        </ol>
        {canEdit && (
          <div className="form-actions">
            <button
              type="button"
              className="button"
              onClick={() => update({ tasks: [...form.tasks, blankTask()] })}
            >
              Add task
            </button>
            <button className="button button-primary" disabled={save.isPending}>
              Save {isNew ? 'template' : 'new version'}
            </button>
          </div>
        )}
      </fieldset>
      {save.error && <Note kind="error">{errorMessage(save.error)}</Note>}
    </form>
  );
}

const fieldNames = Object.keys(letterMergeFields) as (keyof typeof letterMergeFields)[];

function LetterEditor({ templateKey, canEdit }: { templateKey: string; canEdit: boolean }) {
  const isNew = templateKey === 'new';
  const client = useQueryClient();
  const navigate = useNavigate();
  const body = useRef<HTMLTextAreaElement>(null);
  const templates = useLetterTemplates();
  const existing = templates.data?.find((t) => t.key === templateKey);
  const [draft, setDraft] = useState<(LetterTemplateInput & { key: string }) | null>(null);
  const form =
    draft ??
    (existing
      ? {
          key: existing.key,
          name: existing.name,
          type: existing.type,
          body: existing.body,
          approverRole: existing.approverRole,
          signature: existing.signature,
        }
      : {
          key: '',
          name: '',
          type: 'other' as const,
          body: '',
          approverRole: null,
          signature: 'none' as const,
        });
  const update = (patch: Partial<typeof form>) => setDraft({ ...form, ...patch });

  /** Puts {{field}} at the cursor. */
  const insert = (field: string) => {
    const el = body.current;
    const at = el?.selectionStart ?? form.body.length;
    const token = `{{${field}}}`;
    update({ body: form.body.slice(0, at) + token + form.body.slice(el?.selectionEnd ?? at) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const save = useMutation({
    mutationFn: () => {
      const { key, ...input } = form;
      return api<LetterTemplateView>(`/letter-templates/${key}`, { method: 'PUT', body: input });
    },
    onSuccess: async (saved) => {
      setDraft(null);
      await client.invalidateQueries({ queryKey: ['letter-templates'] });
      if (isNew) navigate(`/templates/letters/${saved.key}`);
    },
  });

  if (templates.error) return <Note kind="error">{errorMessage(templates.error)}</Note>;
  if (!isNew && !existing)
    return templates.data ? <Note kind="error">Not found.</Note> : <p>Loading…</p>;

  return (
    <form
      className="record"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <header className="record-header">
        <h2>{isNew ? 'New letter' : form.name}</h2>
        {existing && (
          <p className="muted">
            Version {existing.version}. Saving makes version {existing.version + 1}; letters already
            generated keep theirs.
          </p>
        )}
      </header>
      <fieldset disabled={!canEdit} className="plain-fieldset">
        <div className="form-grid">
          {isNew && <KeyField value={form.key} onChange={(key) => update({ key })} />}
          <Field label="Name">
            {(id) => (
              <input
                id={id}
                required
                value={form.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Letter type">
            {(id) => (
              <select
                id={id}
                value={form.type}
                onChange={(e) => update({ type: e.target.value as LetterTemplateInput['type'] })}
              >
                {letterTypeSchema.options.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Approval before sending">
            {(id) => (
              <select
                id={id}
                value={form.approverRole ?? ''}
                onChange={(e) =>
                  update({
                    approverRole: (e.target.value || null) as LetterTemplateInput['approverRole'],
                  })
                }
              >
                <option value="">None</option>
                <option value="hr">HR</option>
                <option value="hr_head">HR head</option>
              </select>
            )}
          </Field>
          <Field label="Signature">
            {(id) => (
              <select
                id={id}
                value={form.signature}
                onChange={(e) =>
                  update({ signature: e.target.value as LetterTemplateInput['signature'] })
                }
              >
                <option value="none">Not signed</option>
                <option value="employee">Signed by the person (e-signature)</option>
              </select>
            )}
          </Field>
        </div>
        <Field
          label="Letter text"
          hint="Blank line between paragraphs; “# ” starts a heading. {{extra.name}} asks for a value when the letter is made."
        >
          {(id) => (
            <textarea
              id={id}
              ref={body}
              required
              rows={14}
              className="letter-body"
              value={form.body}
              onChange={(e) => update({ body: e.target.value })}
            />
          )}
        </Field>
        {canEdit && (
          <div className="field-chips" aria-label="Insert a field">
            {fieldNames.map((name) => (
              <button
                key={name}
                type="button"
                className="button button-quiet"
                title={letterMergeFields[name]}
                onClick={() => insert(name)}
              >
                {`{{${name}}}`}
              </button>
            ))}
          </div>
        )}
        {canEdit && (
          <div className="form-actions">
            <button className="button button-primary" disabled={save.isPending}>
              Save {isNew ? 'template' : 'new version'}
            </button>
          </div>
        )}
      </fieldset>
      {save.error && <Note kind="error">{errorMessage(save.error)}</Note>}
    </form>
  );
}
