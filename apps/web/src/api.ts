import { QueryClient } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { message?: string; problems?: string[]; fields?: string[] } | null,
  ) {
    super(body?.message ?? `Request failed (${status})`);
  }
}

/** Calls the iPro API on the same origin with the session cookie. */
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; form?: FormData } = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? (options.body || options.form ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.form ?? (options.body ? JSON.stringify(options.body) : undefined),
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}

/** A readable message for an API error, including field names and business-rule problems. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  if (error.status === 403) return 'You don’t have access to this.';
  const parts = [error.body?.message ?? error.message];
  if (error.body?.problems?.length) parts.push(error.body.problems.join('; '));
  if (error.body?.fields?.length) parts.push(`Check: ${error.body.fields.join(', ')}`);
  return parts.join(' — ');
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});
