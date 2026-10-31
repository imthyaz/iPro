import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeResponse, Role } from '@ipro/shared';
import { api, ApiError, errorMessage } from './api.js';

/** The signed-in user, or null when signed out. */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<MeResponse>('/me');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
  });
}

export const hasRole = (me: MeResponse | null | undefined, ...roles: Role[]) =>
  Boolean(me?.roles.some((grant) => roles.includes(grant.role)));

interface DevUser {
  id: string;
  displayName: string;
  roles: { role: Role }[];
}

/** Sign-in: Entra ID when configured, otherwise a pick-a-synthetic-user list for development. */
export function SignIn() {
  const client = useQueryClient();
  const mode = useQuery({
    queryKey: ['auth-mode'],
    queryFn: () => api<{ mode: 'dev' | 'entra' }>('/auth/mode'),
  });
  const devUsers = useQuery({
    queryKey: ['dev-users'],
    queryFn: () => api<DevUser[]>('/auth/dev/users'),
    enabled: mode.data?.mode === 'dev',
  });
  const signIn = useMutation({
    mutationFn: (userId: string) => api('/auth/dev/login', { body: { userId } }),
    onSuccess: () => client.invalidateQueries(),
  });
  const failed = new URLSearchParams(window.location.search).get('signin') === 'failed';

  return (
    <main className="sign-in">
      <h1>iPro</h1>
      {failed && (
        <p className="note note-error" role="alert">
          Sign-in didn’t complete. If it keeps happening, ask HR to check your access.
        </p>
      )}
      {mode.data?.mode === 'entra' && (
        <a
          className="button button-primary"
          href={`/api/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`}
        >
          Sign in with Microsoft
        </a>
      )}
      {mode.data?.mode === 'dev' && (
        <section aria-labelledby="dev-users">
          <h2 id="dev-users">Development sign-in</h2>
          <p className="muted">Synthetic users only. Not available in production.</p>
          <ul className="choice-list">
            {devUsers.data?.map((user) => (
              <li key={user.id}>
                <button
                  className="button"
                  onClick={() => signIn.mutate(user.id)}
                  disabled={signIn.isPending}
                >
                  {user.displayName}
                  <span className="muted"> · {user.roles.map((r) => r.role).join(', ')}</span>
                </button>
              </li>
            ))}
          </ul>
          {signIn.error && <p className="note note-error">{errorMessage(signIn.error)}</p>}
        </section>
      )}
    </main>
  );
}

export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      client.clear();
      window.location.assign('/');
    },
  });
}
