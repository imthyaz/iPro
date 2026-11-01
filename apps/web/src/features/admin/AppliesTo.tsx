import { useQuery } from '@tanstack/react-query';
import { engagementTypeSchema, type AppliesTo } from '@ipro/shared';
import { api } from '../../api.js';
import { todayIso } from '../../design-system/index.js';

type Named = { id: string; name: string };
type EngagementType = (typeof engagementTypeSchema.options)[number];

export const engagementTypeLabel = (type: string) => type.replace('_', '-');

/** Org units for the applies-to filter, from the organisation catalog (admins and HR can read it). */
export function useOrgLookups() {
  const asOf = todayIso();
  const entities = useQuery({
    queryKey: ['org', 'legal-entities', null],
    queryFn: () => api<Named[]>('/org/catalog/legal-entities'),
  });
  const departments = useQuery({
    queryKey: ['org', 'departments', asOf],
    queryFn: () => api<Named[]>(`/org/units/departments?asOf=${asOf}`),
  });
  const locations = useQuery({
    queryKey: ['org', 'locations', asOf],
    queryFn: () => api<Named[]>(`/org/units/locations?asOf=${asOf}`),
  });
  return {
    legalEntities: entities.data ?? [],
    departments: departments.data ?? [],
    locations: locations.data ?? [],
  };
}

/** "Everyone", or e.g. "Intern · Engineering, Sales · Chennai office". */
export function describeAppliesTo(
  appliesTo: AppliesTo,
  lookups: ReturnType<typeof useOrgLookups>,
): string {
  const names = (ids: string[] | undefined, from: Named[]) =>
    ids?.length ? ids.map((id) => from.find((n) => n.id === id)?.name ?? '…').join(', ') : null;
  const parts = [
    names(appliesTo.legalEntityIds, lookups.legalEntities),
    appliesTo.engagementTypes?.length
      ? appliesTo.engagementTypes.map(engagementTypeLabel).join(', ')
      : null,
    names(appliesTo.departmentIds, lookups.departments),
    names(appliesTo.locationIds, lookups.locations),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Everyone';
}

/** Who something applies to: tick nothing in a group to mean "any". */
export function AppliesToEditor(props: {
  value: AppliesTo;
  onChange: (value: AppliesTo) => void;
  disabled?: boolean;
}) {
  const lookups = useOrgLookups();
  const groups: { key: keyof AppliesTo; label: string; options: Named[] }[] = [
    { key: 'legalEntityIds', label: 'Legal entities', options: lookups.legalEntities },
    {
      key: 'engagementTypes',
      label: 'Engagement types',
      options: engagementTypeSchema.options.map((t) => ({ id: t, name: engagementTypeLabel(t) })),
    },
    { key: 'departmentIds', label: 'Departments', options: lookups.departments },
    { key: 'locationIds', label: 'Locations', options: lookups.locations },
  ];
  const toggle = (key: keyof AppliesTo, id: string, on: boolean) => {
    const current = (props.value[key] as string[] | undefined) ?? [];
    const next = on ? [...current, id] : current.filter((x) => x !== id);
    const value = { ...props.value } as Record<string, string[] | undefined>;
    if (next.length) value[key] = next;
    else delete value[key];
    props.onChange(value as AppliesTo);
  };
  return (
    <fieldset className="applies-to" disabled={props.disabled}>
      <legend>Applies to</legend>
      <p className="muted field-hint">
        Leave a group empty to include everyone. Now: {describeAppliesTo(props.value, lookups)}
      </p>
      {groups.map((group) => (
        <fieldset key={group.key} className="check-group">
          <legend>{group.label}</legend>
          {group.options.map((option) => (
            <label key={option.id} className="check">
              <input
                type="checkbox"
                checked={((props.value[group.key] as string[] | undefined) ?? []).includes(
                  option.id as EngagementType,
                )}
                onChange={(e) => toggle(group.key, option.id, e.target.checked)}
              />
              {option.name}
            </label>
          ))}
        </fieldset>
      ))}
    </fieldset>
  );
}
