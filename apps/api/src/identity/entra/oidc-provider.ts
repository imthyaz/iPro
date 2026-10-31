import { Inject, Injectable } from '@nestjs/common';
import * as client from 'openid-client';
import { APP_CONFIG, type AppConfig } from '../../config.js';

export interface OidcChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** The OIDC calls sign-in needs; a fake replaces it in tests. */
export interface OidcProvider {
  authorizationUrl(checks: OidcChecks): Promise<URL>;
  /** Exchanges the code on the callback URL and returns the verified ID token claims. */
  exchange(callbackUrl: URL, checks: OidcChecks): Promise<Record<string, unknown>>;
}

export const OIDC_PROVIDER = Symbol('OIDC_PROVIDER');

/** Microsoft Entra ID (v2 endpoint), authorization code flow with PKCE, state and nonce. */
@Injectable()
export class EntraOidcProvider implements OidcProvider {
  private configuration?: Promise<client.Configuration>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async authorizationUrl(checks: OidcChecks): Promise<URL> {
    return client.buildAuthorizationUrl(await this.discover(), {
      redirect_uri: this.redirectUri,
      scope: 'openid profile email',
      state: checks.state,
      nonce: checks.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(checks.codeVerifier),
      code_challenge_method: 'S256',
    });
  }

  async exchange(callbackUrl: URL, checks: OidcChecks): Promise<Record<string, unknown>> {
    const tokens = await client.authorizationCodeGrant(await this.discover(), callbackUrl, {
      pkceCodeVerifier: checks.codeVerifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    });
    return { ...tokens.claims() };
  }

  private get redirectUri(): string {
    if (!this.config.OIDC_REDIRECT_URI) throw new Error('OIDC_REDIRECT_URI is not configured');
    return this.config.OIDC_REDIRECT_URI;
  }

  private discover(): Promise<client.Configuration> {
    const { ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET } = this.config;
    if (!ENTRA_TENANT_ID || !ENTRA_CLIENT_ID || !ENTRA_CLIENT_SECRET) {
      throw new Error('Entra ID is not configured');
    }
    this.configuration ??= client
      .discovery(
        new URL(`https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`),
        ENTRA_CLIENT_ID,
        ENTRA_CLIENT_SECRET,
      )
      .catch((error: unknown) => {
        this.configuration = undefined;
        throw error;
      });
    return this.configuration;
  }
}
