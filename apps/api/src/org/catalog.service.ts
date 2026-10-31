import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { AuditService, diffFields } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import { costCentres, designations, grades, legalEntities, positions } from './org.schema.js';

export type CatalogKind = 'legal_entity' | 'cost_centre' | 'grade' | 'designation' | 'position';

interface CatalogConfig {
  table: PgTable & { id: PgColumn; deletedAt: PgColumn };
  orderBy: PgColumn;
  /** Money columns: bigint paise in the database, digit strings in JSON (decision #33). */
  money?: readonly string[];
}

const catalogs: Record<CatalogKind, CatalogConfig> = {
  legal_entity: { table: legalEntities, orderBy: legalEntities.name },
  cost_centre: { table: costCentres, orderBy: costCentres.code },
  grade: { table: grades, orderBy: grades.levelOrder, money: ['bandMin', 'bandMax'] },
  designation: { table: designations, orderBy: designations.title },
  position: { table: positions, orderBy: positions.code, money: ['budgetedCtc'] },
};

type Row = Record<string, unknown> & { id: string };

const hidden = new Set(['tenantId', 'deletedAt', 'deletedBy']);

/** Org records without effective dating (screen A1). Deletes are soft and audited. */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(kind: CatalogKind): Promise<Row[]> {
    await this.assert('read');
    const c = catalogs[kind];
    const rows = await this.db.tx((tx) =>
      tx.select().from(c.table).where(isNull(c.table.deletedAt)).orderBy(asc(c.orderBy)),
    );
    return (rows as Row[]).map((row) => this.toJson(row));
  }

  async create(kind: CatalogKind, input: Record<string, unknown>): Promise<Row> {
    await this.assert('create');
    const c = catalogs[kind];
    const { tenantId, actor } = requireContext();
    return this.db.tx(async (tx) => {
      const [row] = (await tx
        .insert(c.table)
        .values({
          ...this.fromJson(kind, input),
          tenantId,
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        } as never)
        .returning()) as Row[];
      await this.audit.record(tx, { action: 'create', table: kind, recordId: row!.id });
      return this.toJson(row!);
    });
  }

  async update(kind: CatalogKind, id: string, input: Record<string, unknown>): Promise<Row> {
    await this.assert('update');
    const c = catalogs[kind];
    const { actor } = requireContext();
    return this.db.tx(async (tx) => {
      const before = await this.load(kind, id, tx);
      const values = this.fromJson(kind, input);
      const [row] = (await tx
        .update(c.table)
        .set({ ...values, updatedAt: new Date(), updatedBy: actor!.userId } as never)
        .where(eq(c.table.id, id))
        .returning()) as Row[];
      await this.audit.record(tx, {
        action: 'update',
        table: kind,
        recordId: id,
        fieldChanges: diffFields(this.toJson(before), this.toJson({ id, ...values })),
      });
      return this.toJson(row!);
    });
  }

  async remove(kind: CatalogKind, id: string): Promise<void> {
    await this.assert('delete');
    const c = catalogs[kind];
    const { actor } = requireContext();
    await this.db.tx(async (tx) => {
      await this.load(kind, id, tx);
      const now = new Date();
      await tx
        .update(c.table)
        .set({
          deletedAt: now,
          deletedBy: actor!.userId,
          updatedAt: now,
          updatedBy: actor!.userId,
        } as never)
        .where(and(eq(c.table.id, id), isNull(c.table.deletedAt)));
      await this.audit.record(tx, { action: 'delete', table: kind, recordId: id });
    });
  }

  private async load(
    kind: CatalogKind,
    id: string,
    tx: Parameters<Parameters<TenantDb['tx']>[0]>[0],
  ) {
    const c = catalogs[kind];
    const [row] = (await tx.select().from(c.table).where(eq(c.table.id, id))) as Row[];
    if (!row || row.deletedAt) throw new NotFoundException();
    return row;
  }

  private fromJson(kind: CatalogKind, input: Record<string, unknown>): Record<string, unknown> {
    const values = { ...input };
    for (const field of catalogs[kind].money ?? []) {
      if (typeof values[field] === 'string') values[field] = BigInt(values[field] as string);
    }
    return values;
  }

  private toJson(row: Row): Row {
    const out: Row = { id: row.id };
    for (const [key, value] of Object.entries(row)) {
      if (hidden.has(key)) continue;
      out[key] = typeof value === 'bigint' ? value.toString() : value;
    }
    return out;
  }

  private assert(action: 'read' | 'create' | 'update' | 'delete') {
    return this.authz.assert(requireContext().actor!, action, { area: 'org_config' });
  }
}
