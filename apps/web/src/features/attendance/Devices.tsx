import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { BiometricDeviceView } from '@ipro/shared';
import { api, errorMessage } from '../../api.js';
import { Chip, Empty, Field, formatDate, Note, todayIso } from '../../design-system/index.js';

interface LocationRow {
  id: string;
  code: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusMetres: number | null;
}

/**
 * Check-in sites (decisions #67, #68): where each office is, for the phone check-in geofence, and the
 * biometric devices that push punches. Admins and HR head keep them.
 */
export function BiometricDevices() {
  const locations = useQuery({
    queryKey: ['org', 'locations', todayIso()],
    queryFn: () => api<LocationRow[]>(`/org/units/locations?asOf=${todayIso()}`),
  });
  const devices = useQuery({
    queryKey: ['biometric-devices'],
    queryFn: () => api<BiometricDeviceView[]>('/biometric/devices'),
  });
  return (
    <main className="page">
      <h1>Check-in sites</h1>
      <section aria-labelledby="sites-geofence">
        <h2 id="sites-geofence">Office locations</h2>
        <p className="muted">
          Phone check-ins further than the radius from the office are marked for the manager. A
          location without coordinates isn’t checked.
        </p>
        {locations.error && <Note kind="error">{errorMessage(locations.error)}</Note>}
        <ul className="rows" aria-label="Office locations">
          {locations.data?.map((l) => (
            <Geofence key={l.id} location={l} />
          ))}
        </ul>
      </section>
      <section aria-labelledby="sites-devices">
        <h2 id="sites-devices">Biometric devices</h2>
        {devices.error && <Note kind="error">{errorMessage(devices.error)}</Note>}
        {devices.data?.length === 0 && <Empty>No devices yet.</Empty>}
        <ul className="rows" aria-label="Biometric devices">
          {devices.data?.map((d) => (
            <Device key={d.id} device={d} />
          ))}
        </ul>
        <AddDevice locations={locations.data ?? []} />
      </section>
    </main>
  );
}

function Geofence({ location }: { location: LocationRow }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    latitude: location.latitude?.toString() ?? '',
    longitude: location.longitude?.toString() ?? '',
    radius: location.geofenceRadiusMetres?.toString() ?? '',
    from: todayIso(),
  });
  const save = useMutation({
    mutationFn: () =>
      api(`/org/units/locations/${location.id}/changes`, {
        body: {
          effectiveFrom: form.from,
          latitude: form.latitude ? Number(form.latitude) : null,
          longitude: form.longitude ? Number(form.longitude) : null,
          geofenceRadiusMetres: form.radius ? Number(form.radius) : null,
        },
      }),
    onSuccess: () => {
      setEditing(false);
      return client.invalidateQueries({ queryKey: ['org', 'locations'] });
    },
  });
  const here = () =>
    navigator.geolocation?.getCurrentPosition((p) =>
      setForm({
        ...form,
        latitude: p.coords.latitude.toFixed(6),
        longitude: p.coords.longitude.toFixed(6),
      }),
    );
  return (
    <li className="row row-stack">
      <span className="row-main">
        <strong>{location.name}</strong>
        <span className="muted">
          {location.latitude === null
            ? 'No coordinates: check-ins aren’t checked'
            : `${location.latitude}, ${location.longitude} · ${
                location.geofenceRadiusMetres ?? 'default'
              } m`}
        </span>
      </span>
      {!editing ? (
        <button className="button button-quiet" onClick={() => setEditing(true)}>
          Set location
        </button>
      ) : (
        <form
          className="inline-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="form-grid">
            <Field label="Latitude">
              {(id) => (
                <input
                  id={id}
                  inputMode="decimal"
                  value={form.latitude}
                  onChange={(e) => setForm({ ...form, latitude: e.target.value })}
                />
              )}
            </Field>
            <Field label="Longitude">
              {(id) => (
                <input
                  id={id}
                  inputMode="decimal"
                  value={form.longitude}
                  onChange={(e) => setForm({ ...form, longitude: e.target.value })}
                />
              )}
            </Field>
            <Field label="Radius (m)" hint="Blank uses the default (200 m)">
              {(id) => (
                <input
                  id={id}
                  type="number"
                  min={25}
                  max={5000}
                  value={form.radius}
                  onChange={(e) => setForm({ ...form, radius: e.target.value })}
                />
              )}
            </Field>
            <Field label="From">
              {(id) => (
                <input
                  id={id}
                  type="date"
                  required
                  value={form.from}
                  onChange={(e) => setForm({ ...form, from: e.target.value })}
                />
              )}
            </Field>
          </div>
          <div className="form-actions">
            <button className="button button-primary" disabled={save.isPending}>
              Save from {formatDate(form.from)}
            </button>
            <button type="button" className="button" onClick={here}>
              Use where I am
            </button>
            <button type="button" className="button button-quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          {save.error && <Note kind="error">{errorMessage(save.error)}</Note>}
        </form>
      )}
    </li>
  );
}

function Device({ device }: { device: BiometricDeviceView }) {
  const client = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api(`/biometric/devices/${device.id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['biometric-devices'] }),
  });
  return (
    <li className="row">
      <span className="row-main">
        <strong>
          {device.name} ({device.code})
        </strong>
        <span className="muted">
          {device.location ?? '—'} · last push{' '}
          {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString('en-IN') : 'never'}
        </span>
      </span>
      <span className="row-side">
        {device.active ? (
          <button
            className="button button-quiet"
            disabled={revoke.isPending}
            onClick={() => {
              if (window.confirm(`Revoke ${device.name}? It will no longer be able to push.`))
                revoke.mutate();
            }}
          >
            Revoke
          </button>
        ) : (
          <Chip tone="muted">Revoked</Chip>
        )}
      </span>
      {revoke.error && <Note kind="error">{errorMessage(revoke.error)}</Note>}
    </li>
  );
}

function AddDevice({ locations }: { locations: LocationRow[] }) {
  const client = useQueryClient();
  const [form, setForm] = useState({ code: '', name: '', locationId: '' });
  const [key, setKey] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => api<{ id: string; key: string }>('/biometric/devices', { body: form }),
    onSuccess: (res) => {
      setKey(res.key);
      setForm({ code: '', name: '', locationId: '' });
      return client.invalidateQueries({ queryKey: ['biometric-devices'] });
    },
  });
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setKey(null);
        add.mutate();
      }}
    >
      <h3>Add a device</h3>
      <div className="form-grid">
        <Field label="Code">
          {(id) => (
            <input
              id={id}
              required
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          )}
        </Field>
        <Field label="Name" hint="e.g. Lobby reader">
          {(id) => (
            <input
              id={id}
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          )}
        </Field>
        <Field label="Location">
          {(id) => (
            <select
              id={id}
              required
              value={form.locationId}
              onChange={(e) => setForm({ ...form, locationId: e.target.value })}
            >
              <option value="">Choose…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <button className="button button-primary" disabled={add.isPending}>
        Add device
      </button>
      {key && (
        <Note kind="info">
          Device key (shown once; give it to whoever sets up the device’s push):{' '}
          <code data-testid="device-key">{key}</code>
        </Note>
      )}
      {add.error && <Note kind="error">{errorMessage(add.error)}</Note>}
    </form>
  );
}
