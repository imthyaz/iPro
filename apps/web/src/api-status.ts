import type { HealthResponse } from '@ipro/shared';

export type ApiStatus = 'checking' | 'ok' | 'degraded' | 'unreachable';

/** Reads /api/health; a 503 still carries a valid body, so parse it before giving up. */
export async function fetchApiStatus(fetchFn: typeof fetch = fetch): Promise<ApiStatus> {
  try {
    const response = await fetchFn('/api/health');
    // Checked by hand rather than with the zod schema, which would put zod in the first download
    // (decision #97).
    const body = (await response.json()) as Partial<HealthResponse> | null;
    return body?.status === 'ok' || body?.status === 'degraded' ? body.status : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export const apiStatusLabel: Record<ApiStatus, string> = {
  checking: 'Checking…',
  ok: 'Connected',
  degraded: 'Database unavailable',
  unreachable: 'API unreachable',
};
