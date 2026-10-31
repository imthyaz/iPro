import { Injectable, Inject } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { RoleGrant } from '@ipro/shared';
import type { Actor } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { appUsers, roleAssignments } from './identity.schema.js';

export interface UserSummary {
  id: string;
  displayName: string;
  roles: RoleGrant[];
}

@Injectable()
export class UsersService {
  constructor(@Inject(TenantDb) private readonly db: TenantDb) {}

  /** The actor for an active user, or null if the user is missing or disabled. */
  async loadActor(tx: Tx, tenantId: string, userId: string): Promise<Actor | null> {
    const [user] = await tx
      .select({ id: appUsers.id, personId: appUsers.personId, status: appUsers.status })
      .from(appUsers)
      .where(eq(appUsers.id, userId));
    if (!user || user.status !== 'active') return null;
    return {
      userId: user.id,
      tenantId,
      personId: user.personId,
      roles: await this.grants(tx, user.id),
    };
  }

  async grants(tx: Tx, userId: string): Promise<RoleGrant[]> {
    const rows = await tx
      .select({ role: roleAssignments.role, legalEntityId: roleAssignments.legalEntityId })
      .from(roleAssignments)
      .where(and(eq(roleAssignments.userId, userId), isNull(roleAssignments.deletedAt)));
    return rows;
  }

  async displayName(userId: string): Promise<string | null> {
    return this.db.tx(async (tx) => {
      const [user] = await tx
        .select({ displayName: appUsers.displayName })
        .from(appUsers)
        .where(eq(appUsers.id, userId));
      return user?.displayName ?? null;
    });
  }

  /** Synthetic users for the dev sign-in screen (users without an Entra identity). */
  async listDevUsers(): Promise<UserSummary[]> {
    return this.db.tx(async (tx) => {
      const users = await tx
        .select({ id: appUsers.id, displayName: appUsers.displayName })
        .from(appUsers)
        .where(and(isNull(appUsers.entraObjectId), eq(appUsers.status, 'active')))
        .orderBy(appUsers.displayName);
      return Promise.all(
        users.map(async (user) => ({ ...user, roles: await this.grants(tx, user.id) })),
      );
    });
  }
}
