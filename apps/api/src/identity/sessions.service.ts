import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { requireContext, type Actor } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import { appUsers, sessions } from './identity.schema.js';
import {
  hashSessionToken,
  isSessionValid,
  newSessionToken,
  sessionCookie,
  clearSessionCookie,
  shouldTouch,
} from './session-token.js';
import { UsersService } from './users.service.js';

@Injectable()
export class SessionsService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Starts a session for an already-verified user; returns the Set-Cookie value. */
  async start(userId: string, now = new Date()): Promise<string> {
    const { tenantId, ip, userAgent } = requireContext();
    const token = newSessionToken();
    const maxAgeSeconds = this.config.SESSION_MAX_DAYS * 86_400;
    await this.db.tx(async (tx) => {
      await tx.insert(sessions).values({
        tenantId,
        userId,
        createdBy: userId,
        updatedBy: userId,
        tokenHash: hashSessionToken(token),
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + maxAgeSeconds * 1000),
        ip,
        userAgent,
      });
      await tx
        .update(appUsers)
        .set({ lastSignInAt: now, updatedAt: now, updatedBy: userId })
        .where(eq(appUsers.id, userId));
    });
    return sessionCookie(token, { maxAgeSeconds, secure: this.secureCookies });
  }

  /** The actor behind a session token, or null when the session is unknown, ended or the user disabled. */
  async resolve(token: string, now = new Date()): Promise<Actor | null> {
    const { tenantId } = requireContext();
    return this.db.tx(async (tx) => {
      const [session] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, hashSessionToken(token)));
      if (!session) return null;
      if (!isSessionValid(session, { idleHours: this.config.SESSION_IDLE_HOURS }, now)) return null;
      if (shouldTouch(session, now)) {
        await tx.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, session.id));
      }
      return this.users.loadActor(tx, tenantId, session.userId);
    });
  }

  /** Ends the session; returns the Set-Cookie value that clears the cookie. */
  async end(token: string | undefined, now = new Date()): Promise<string> {
    if (token) {
      await this.db.tx((tx) =>
        tx
          .update(sessions)
          .set({ revokedAt: now, updatedAt: now })
          .where(eq(sessions.tokenHash, hashSessionToken(token))),
      );
    }
    return clearSessionCookie(this.secureCookies);
  }

  private get secureCookies(): boolean {
    return this.config.NODE_ENV === 'production';
  }
}
