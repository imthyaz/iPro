import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EsignProvider, EsignRequest, EsignStatus } from './esign.js';

export interface ZohoSignOptions {
  /** India data centre by default, so documents stay in India (DPDP). */
  accountsUrl: string;
  signUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** If set, webhooks must carry an HMAC-SHA256 (base64) of the raw body in `webhookHeader`. */
  webhookSecret?: string;
  webhookHeader: string;
  fetch?: typeof fetch;
}

/** Signature box on the last page, bottom left, in PDF points (A4 is 595 × 842). */
const SIGNATURE_FIELD = { x_coord: 56, y_coord: 700, abs_width: 180, abs_height: 48 };

/** Pages in a PDF, counted from its page objects (enough for the letters iPro generates). */
export function pageCount(pdf: Buffer): number {
  return Math.max(1, (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length);
}

/**
 * Zoho Sign (decision #51): OAuth refresh-token access, one signer per request, a signature field on the
 * last page. Built against Zoho Sign's v1 REST API; verified with simulated responses until real
 * credentials exist (docs/open-questions.md).
 */
export class ZohoSign implements EsignProvider {
  readonly name = 'zoho' as const;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly http: typeof fetch;

  constructor(private readonly options: ZohoSignOptions) {
    this.http = options.fetch ?? fetch;
  }

  async send(request: EsignRequest): Promise<{ requestId: string }> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(request.pdf)], { type: 'application/pdf' }),
      request.fileName,
    );
    form.append(
      'data',
      JSON.stringify({
        requests: {
          request_name: request.title,
          notes: `Reference ${request.reference}`,
          is_sequential: true,
          actions: [
            {
              action_type: 'SIGN',
              recipient_name: request.signer.name,
              recipient_email: request.signer.email,
              signing_order: 0,
              verify_recipient: true,
              verification_type: 'EMAIL',
            },
          ],
        },
      }),
    );
    const created = await this.call<{
      requests: {
        request_id: string;
        document_ids: { document_id: string }[];
        actions: { action_id: string }[];
      };
    }>('POST', '/api/v1/requests', form);
    const { request_id, document_ids, actions } = created.requests;

    const submit = new URLSearchParams({
      data: JSON.stringify({
        requests: {
          actions: [
            {
              action_id: actions[0]!.action_id,
              action_type: 'SIGN',
              recipient_name: request.signer.name,
              recipient_email: request.signer.email,
              fields: [
                {
                  field_type_name: 'Signature',
                  field_name: 'Signature',
                  document_id: document_ids[0]!.document_id,
                  page_no: pageCount(request.pdf) - 1,
                  is_mandatory: true,
                  ...SIGNATURE_FIELD,
                },
              ],
            },
          ],
        },
      }),
    });
    await this.call('POST', `/api/v1/requests/${encodeURIComponent(request_id)}/submit`, submit);
    return { requestId: request_id };
  }

  async status(requestId: string): Promise<EsignStatus> {
    const result = await this.call<{ requests: { request_status: string } }>(
      'GET',
      `/api/v1/requests/${encodeURIComponent(requestId)}`,
    );
    switch (result.requests.request_status) {
      case 'completed': {
        const response = await this.raw(
          'GET',
          `/api/v1/requests/${encodeURIComponent(requestId)}/pdf`,
        );
        return { state: 'signed', signedPdf: Buffer.from(await response.arrayBuffer()) };
      }
      case 'declined':
        return { state: 'declined' };
      case 'recalled':
      case 'expired':
        return { state: 'cancelled' };
      default:
        return { state: 'pending' };
    }
  }

  async cancel(requestId: string): Promise<void> {
    await this.call('POST', `/api/v1/requests/${encodeURIComponent(requestId)}/recall`);
  }

  webhookRequestId(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): string | null {
    if (this.options.webhookSecret) {
      const given = headers[this.options.webhookHeader.toLowerCase()];
      const expected = createHmac('sha256', this.options.webhookSecret)
        .update(rawBody)
        .digest('base64');
      if (typeof given !== 'string') return null;
      const a = Buffer.from(given);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    }
    try {
      const body = JSON.parse(rawBody.toString('utf8')) as { requests?: { request_id?: unknown } };
      const id = body.requests?.request_id;
      return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
    } catch {
      return null;
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const params = new URLSearchParams({
      refresh_token: this.options.refreshToken,
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      grant_type: 'refresh_token',
    });
    const response = await this.http(`${this.options.accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      body: params,
    });
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!response.ok || !body.access_token)
      throw new Error(`Zoho token request failed (${response.status})`);
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
    };
    return body.access_token;
  }

  private async raw(
    method: string,
    path: string,
    body?: FormData | URLSearchParams,
  ): Promise<Response> {
    const response = await this.http(`${this.options.signUrl}${path}`, {
      method,
      body,
      headers: { Authorization: `Zoho-oauthtoken ${await this.accessToken()}` },
    });
    // Status and path only: responses may contain names and emails.
    if (!response.ok) throw new Error(`Zoho Sign ${method} ${path} failed (${response.status})`);
    return response;
  }

  private async call<T>(
    method: string,
    path: string,
    body?: FormData | URLSearchParams,
  ): Promise<T> {
    return (await (await this.raw(method, path, body)).json()) as T;
  }
}
