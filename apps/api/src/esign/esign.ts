import { randomUUID } from 'node:crypto';

/**
 * iPro's own e-signature layer (spec: integrations). The provider is configuration; Zoho Sign in AWS,
 * the fake in tests and local development.
 */
export interface EsignRequest {
  pdf: Buffer;
  fileName: string;
  title: string;
  signer: { name: string; email: string };
  /** Our own reference (the letter id), for the provider's records. */
  reference: string;
}

export type EsignStatus =
  | { state: 'pending' }
  | { state: 'signed'; signedPdf: Buffer }
  | { state: 'declined' }
  | { state: 'cancelled' };

export interface EsignProvider {
  readonly name: 'fake' | 'zoho';
  send(request: EsignRequest): Promise<{ requestId: string }>;
  /** Always asks the provider; callers never trust webhook payloads for the outcome. */
  status(requestId: string): Promise<EsignStatus>;
  cancel(requestId: string): Promise<void>;
  /**
   * Checks a webhook's authenticity and returns the provider request id it is about, or null. The
   * caller then fetches the real status with `status`.
   */
  webhookRequestId(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): string | null;
}

export const ESIGN_PROVIDER = Symbol('ESIGN_PROVIDER');

/** In-memory signer for tests and local development (decision #51). */
export class FakeEsign implements EsignProvider {
  readonly name = 'fake' as const;
  readonly requests = new Map<string, { request: EsignRequest; status: EsignStatus }>();

  async send(request: EsignRequest) {
    const requestId = `fake-${randomUUID()}`;
    this.requests.set(requestId, { request, status: { state: 'pending' } });
    return { requestId };
  }

  async status(requestId: string): Promise<EsignStatus> {
    const entry = this.requests.get(requestId);
    if (!entry) throw new Error('Unknown e-sign request');
    return entry.status;
  }

  async cancel(requestId: string) {
    const entry = this.requests.get(requestId);
    if (entry && entry.status.state === 'pending') entry.status = { state: 'cancelled' };
  }

  webhookRequestId(rawBody: Buffer): string | null {
    try {
      const body = JSON.parse(rawBody.toString('utf8')) as { requestId?: unknown };
      return typeof body.requestId === 'string' && this.requests.has(body.requestId)
        ? body.requestId
        : null;
    } catch {
      return null;
    }
  }

  /** Test helper: the signer signs. The "signed" PDF is the original with a marker appended. */
  sign(requestId: string): void {
    const entry = this.requests.get(requestId);
    if (!entry) throw new Error('Unknown e-sign request');
    const marker = Buffer.from(`\n% Signed by ${entry.request.signer.email} (fake e-sign)\n`);
    entry.status = { state: 'signed', signedPdf: Buffer.concat([entry.request.pdf, marker]) };
  }

  decline(requestId: string): void {
    const entry = this.requests.get(requestId);
    if (entry) entry.status = { state: 'declined' };
  }
}
