import { describe, expect, it } from 'vitest';
import { fetchApiStatus } from './api-status.js';

const respond = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status });

describe('fetchApiStatus', () => {
  it('returns ok for a healthy API', async () => {
    const fetchFn = respond(200, {
      status: 'ok',
      checks: { database: 'ok' },
      time: '2026-10-31T10:00:00.000Z',
    });
    expect(await fetchApiStatus(fetchFn as typeof fetch)).toBe('ok');
  });

  it('returns degraded from a 503 body', async () => {
    const fetchFn = respond(503, {
      status: 'degraded',
      checks: { database: 'down' },
      time: '2026-10-31T10:00:00.000Z',
    });
    expect(await fetchApiStatus(fetchFn as typeof fetch)).toBe('degraded');
  });

  it('returns unreachable when the request fails', async () => {
    const fetchFn = async () => {
      throw new TypeError('network');
    };
    expect(await fetchApiStatus(fetchFn as typeof fetch)).toBe('unreachable');
  });
});
