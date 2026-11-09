import { createSign, generateKeyPairSync } from 'node:crypto';
import type { BotKey, BotKeySource } from './bot-auth.js';

/**
 * Test-only signing keys standing in for Microsoft's Bot Framework token service, so tests can send
 * the bot endpoint correctly signed (or wrongly signed) activities. Never used outside tests.
 */
export class TestBotKeys implements BotKeySource {
  private readonly pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly kid = 'test-key-1';

  async keys(): Promise<BotKey[]> {
    return [
      {
        ...this.pair.publicKey.export({ format: 'jwk' }),
        kid: this.kid,
        endorsements: ['msteams'],
      },
    ];
  }

  sign(claims: Record<string, unknown>, kid = this.kid): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString(
      'base64url',
    );
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${payload}`)
      .sign(this.pair.privateKey)
      .toString('base64url');
    return `${header}.${payload}.${signature}`;
  }
}
