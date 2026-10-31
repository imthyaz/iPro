import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { CreateDelegationInput, Delegation } from '@ipro/shared';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { businessDate, delegationProblems, effectiveApprovers } from './delegation-rules.js';
import { approvalDelegations } from './identity.schema.js';
import { UsersService } from './users.service.js';

type Row = typeof approvalDelegations.$inferSelect;

const toDto = (row: Row): Delegation => ({
  id: row.id,
  delegatorUserId: row.delegatorUserId,
  delegateUserId: row.delegateUserId,
  startsOn: row.startsOn,
  endsOn: row.endsOn,
  reason: row.reason,
  revokedAt: row.revokedAt?.toISOString() ?? null,
});

@Injectable()
export class DelegationsService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  async create(input: CreateDelegationInput, now = new Date()): Promise<Delegation> {
    const { actor, tenantId } = requireContext();
    const delegatorUserId = input.delegatorUserId ?? actor!.userId;
    await this.authz.assert(actor!, 'create', {
      area: 'approval_delegation',
      subjectUserId: delegatorUserId,
    });

    return this.db.tx(async (tx) => {
      const request = { ...input, delegatorUserId };
      const problems = delegationProblems(request, {
        delegatorIsManager: await this.isManager(tx, delegatorUserId),
        delegateIsManager: await this.isManager(tx, input.delegateUserId),
        existing: await this.forDelegator(tx, delegatorUserId),
        today: businessDate(now),
      });
      if (problems.length > 0)
        throw new BadRequestException({ message: 'Invalid delegation', problems });

      const [row] = await tx
        .insert(approvalDelegations)
        .values({
          tenantId,
          delegatorUserId,
          delegateUserId: input.delegateUserId,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          reason: input.reason ?? null,
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        })
        .returning();
      await this.audit.record(tx, {
        action: 'create',
        table: 'approval_delegation',
        recordId: row!.id,
      });
      return toDto(row!);
    });
  }

  /** Delegations the actor gave or received. */
  async listMine(): Promise<Delegation[]> {
    const { actor } = requireContext();
    const rows = await this.db.tx((tx) =>
      tx
        .select()
        .from(approvalDelegations)
        .where(
          or(
            eq(approvalDelegations.delegatorUserId, actor!.userId),
            eq(approvalDelegations.delegateUserId, actor!.userId),
          ),
        )
        .orderBy(approvalDelegations.startsOn),
    );
    return rows.map(toDto);
  }

  async revoke(id: string, now = new Date()): Promise<Delegation> {
    const { actor } = requireContext();
    return this.db.tx(async (tx) => {
      const [row] = await tx
        .select()
        .from(approvalDelegations)
        .where(eq(approvalDelegations.id, id));
      if (!row) throw new NotFoundException();
      await this.authz.assert(actor!, 'update', {
        area: 'approval_delegation',
        subjectUserId: row.delegatorUserId,
      });
      if (row.revokedAt) return toDto(row);
      const [updated] = await tx
        .update(approvalDelegations)
        .set({ revokedAt: now, revokedBy: actor!.userId, updatedAt: now, updatedBy: actor!.userId })
        .where(eq(approvalDelegations.id, id))
        .returning();
      await this.audit.record(tx, {
        action: 'update',
        table: 'approval_delegation',
        recordId: id,
        fieldChanges: [{ field: 'revoked_at', from: null, to: now.toISOString() }],
      });
      return toDto(updated!);
    });
  }

  /** For the workflow engine (slice 3): who may act on `approverUserId`'s approvals on a date. */
  async approversFor(tx: Tx, approverUserId: string, onDate: string): Promise<string[]> {
    return effectiveApprovers(approverUserId, onDate, await this.forDelegator(tx, approverUserId));
  }

  private forDelegator(tx: Tx, delegatorUserId: string) {
    return tx
      .select()
      .from(approvalDelegations)
      .where(
        and(
          eq(approvalDelegations.delegatorUserId, delegatorUserId),
          isNull(approvalDelegations.revokedAt),
        ),
      );
  }

  private async isManager(tx: Tx, userId: string): Promise<boolean> {
    return (await this.users.grants(tx, userId)).some((grant) => grant.role === 'manager');
  }
}
