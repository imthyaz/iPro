import { createPublicKey, verify } from 'node:crypto';

/**
 * Checks the token Microsoft's Bot Framework sends with each Teams activity (decision #87), with
 * Node's own crypto: RS256 signature against Microsoft's published keys, issuer, audience (our bot's
 * app id), expiry, and that the token was issued for the service URL the activity names.
 */
export const BOT_KEYS = Symbol('BOT_KEYS');

/** A JSON Web Key as Node's createPublicKey reads it. */
type Jwk = Extract<Parameters<typeof createPublicKey>[0], { format: 'jwk' }>['key'];

export type BotKey = Jwk & { kid: string; endorsements?: string[] };

export interface BotKeySource {
  keys(): Promise<BotKey[]>;
}

export const BOT_ISSUER = 'https://api.botframework.com';
const OPENID_CONFIG = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const DAY = 24 * 60 * 60 * 1000;
/** Allowed clock difference with Microsoft's token service. */
const SKEW_SECONDS = 300;

/** Microsoft's published Bot Framework signing keys, fetched once a day. */
export class BotFrameworkKeys implements BotKeySource {
  private cached: { keys: BotKey[]; until: number } | null = null;

  constructor(private readonly http: typeof fetch = fetch) {}

  async keys(): Promise<BotKey[]> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.keys;
    const config = (await (await this.http(OPENID_CONFIG)).json()) as { jwks_uri: string };
    const { keys } = (await (await this.http(config.jwks_uri)).json()) as { keys: BotKey[] };
    this.cached = { keys, until: Date.now() + DAY };
    return keys;
  }
}

export class BotAuthError extends Error {}

export interface BotTokenClaims {
  iss: string;
  aud: string;
  exp: number;
  nbf?: number;
  serviceurl?: string;
  serviceUrl?: string;
}

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

export async function verifyBotToken(
  authorization: string | undefined,
  options: {
    appId: string;
    serviceUrl: string;
    channelId?: string;
    keys: BotKeySource;
    now?: Date;
  },
): Promise<BotTokenClaims> {
  const match = /^Bearer (.+)$/.exec(authorization ?? '');
  if (!match) throw new BotAuthError('No bearer token');
  const parts = match[1]!.split('.');
  if (parts.length !== 3) throw new BotAuthError('Malformed token');
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: BotTokenClaims;
  try {
    header = decode(rawHeader);
    claims = decode(rawPayload);
  } catch {
    throw new BotAuthError('Malformed token');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new BotAuthError('Unexpected algorithm');
  const key = (await options.keys.keys()).find((k) => k.kid === header.kid);
  if (!key) throw new BotAuthError('Unknown signing key');
  if (options.channelId && key.endorsements && !key.endorsements.includes(options.channelId)) {
    throw new BotAuthError('Key not endorsed for this channel');
  }
  const signed = verify(
    'RSA-SHA256',
    Buffer.from(`${rawHeader}.${rawPayload}`),
    createPublicKey({ key, format: 'jwk' }),
    Buffer.from(rawSignature, 'base64url'),
  );
  if (!signed) throw new BotAuthError('Bad signature');
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.iss !== BOT_ISSUER) throw new BotAuthError('Wrong issuer');
  if (claims.aud !== options.appId) throw new BotAuthError('Wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < now) {
    throw new BotAuthError('Expired');
  }
  if (claims.nbf !== undefined && claims.nbf - SKEW_SECONDS > now) {
    throw new BotAuthError('Not yet valid');
  }
  const issuedFor = claims.serviceurl ?? claims.serviceUrl;
  if (issuedFor && issuedFor.replace(/\/$/, '') !== options.serviceUrl.replace(/\/$/, '')) {
    throw new BotAuthError('Service URL mismatch');
  }
  return claims;
}
