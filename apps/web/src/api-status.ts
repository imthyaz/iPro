import { healthResponseSchema } from '@ipro/shared';

export type ApiStatus = 'checking' | 'ok' | 'degraded' | 'unreachable';

/** Reads /api/health; a 503 still carries a valid body, so parse it before giving up. */
export async function fetchApiStatus(fetchFn: typeof fetch = fetch): Promise<ApiStatus> {
  try {
    const response = await fetchFn('/api/health');
    const parsed = healthResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.status : 'unreachable';
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
