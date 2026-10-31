import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gte, isNull, lte, or, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { AuditService, diffFields } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { planChange, rowAt, type DatedRow } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import {
  businessUnits,
  businessUnitVersions,
  departments,
  departmentVersions,
  locations,
  locationVersions,
} from './org.schema.js';

export type DatedKind = 'business_unit' | 'department' | 'location';

interface KindConfig {
  unit: PgTable & { id: PgColumn; code: PgColumn; deletedAt: PgColumn };
  version: PgTable & { id: PgColumn; effectiveFrom: PgColumn; effectiveTo: PgColumn };
  unitIdColumn: PgColumn;
  unitIdField: string;
  /** Version fields carried forward to the next version. */
  fields: readonly string[];
  /** Identity fields stored on the unit row (not dated). */
  unitFields?: readonly string[];
}

const kinds: Record<DatedKind, KindConfig> = {
  business_unit: {
    unit: businessUnits,
    version: businessUnitVersions,
    unitIdColumn: businessUnitVersions.businessUnitId,
    unitIdField: 'businessUnitId',
    fields: ['name', 'headPersonId'],
  },
  department: {
    unit: departments,
    version: departmentVersions,
    unitIdColumn: departmentVersions.departmentId,
    unitIdField: 'departmentId',
    fields: ['name', 'businessUnitId', 'parentDepartmentId', 'headPersonId'],
  },
  location: {
    unit: locations,
    version: locationVersions,
    unitIdColumn: locationVersions.locationId,
    unitIdField: 'locationId',
    fields: ['name', 'type', 'address', 'state', 'timezone', 'holidayCalendarId', 'seatCount'],
    unitFields: ['legalEntityId'],
  },
};

type Row = Record<string, unknown> & DatedRow;

export interface DatedUnitView {
  id: string;
  code: string;
  versionId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  [field: string]: unknown;
}

const pick = (source: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key] ?? null]),
  );

/**
 * Business units, departments and locations: a stable id plus dated versions (decision #21).
 * Changes close the version in force the day before and open a new one; history is never rewritten.
 */
@Injectable()
export class DatedUnitsService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Units with the version in force on `asOf` (units not in force that day are left out). */
  async list(kind: DatedKind, asOf: string): Promise<DatedUnitView[]> {
    await this.assert('read');
    const k = kinds[kind];
    return this.db.tx(async (tx) => {
      const rows = await tx
        .select({ unit: k.unit, version: k.version })
        .from(k.version)
        .innerJoin(k.unit, eq(k.unit.id, k.unitIdColumn))
        .where(
          and(
            isNull(k.unit.deletedAt),
            lte(k.version.effectiveFrom, asOf),
            or(isNull(k.version.effectiveTo), gte(k.version.effectiveTo, asOf)) as SQL,
          ),
        )
        .orderBy(asc(k.unit.code));
      return rows.map(({ unit, version }) => this.view(kind, unit as Row, version as Row));
    });
  }

  async history(kind: DatedKind, id: string): Promise<DatedUnitView[]> {
    await this.assert('read');
    return this.db.tx(async (tx) => {
      const unit = await this.loadUnit(tx, kind, id);
      const versions = await this.versions(tx, kind, id);
      return versions.map((version) => this.view(kind, unit, version));
    });
  }

  async create(
    kind: DatedKind,
    input: Record<string, unknown> & { code: string; effectiveFrom: string },
  ) {
    await this.assert('create');
    const k = kinds[kind];
    const { tenantId, actor } = requireContext();
    const by = { createdBy: actor!.userId, updatedBy: actor!.userId };
    return this.db.tx(async (tx) => {
      if (kind === 'department') await this.checkNoCycle(tx, null, input, input.effectiveFrom);
      const [unit] = (await tx
        .insert(k.unit)
        .values({ tenantId, code: input.code, ...pick(input, k.unitFields ?? []), ...by } as never)
        .returning()) as Row[];
      const [version] = (await tx
        .insert(k.version)
        .values({
          tenantId,
          [k.unitIdField]: unit!.id,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: null,
          ...pick(input, k.fields),
          ...by,
        } as never)
        .returning()) as Row[];
      await this.audit.record(tx, { action: 'create', table: kind, recordId: unit!.id });
      return this.view(kind, unit!, version!);
    });
  }

  /** New values effective from a date; unspecified fields carry forward from the version in force. */
  async change(
    kind: DatedKind,
    id: string,
    input: Record<string, unknown> & { effectiveFrom: string },
  ) {
    await this.assert('update');
    const k = kinds[kind];
    const { tenantId, actor } = requireContext();
    return this.db.tx(async (tx) => {
      const unit = await this.loadUnit(tx, kind, id);
      const versions = await this.versions(tx, kind, id);
      const plan = planChange(versions, input.effectiveFrom);
      if (!plan.ok) throw new BadRequestException({ message: plan.problem });
      const base = versions.find((v) => v.id === plan.basedOn) ?? {};
      const values = { ...pick(base, k.fields), ...pick(input, k.fields) };
      if (kind === 'department') await this.checkNoCycle(tx, id, values, input.effectiveFrom);

      if (plan.close) {
        await tx
          .update(k.version)
          .set({
            effectiveTo: plan.close.effectiveTo,
            updatedAt: new Date(),
            updatedBy: actor!.userId,
          } as never)
          .where(eq(k.version.id, plan.close.id));
      }
      const [version] = (await tx
        .insert(k.version)
        .values({
          tenantId,
          [k.unitIdField]: id,
          ...plan.newRow,
          ...values,
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        } as never)
        .returning()) as Row[];
      await this.audit.record(tx, {
        action: 'update',
        table: kind,
        recordId: id,
        fieldChanges: [
          { field: 'effective_from', to: input.effectiveFrom },
          ...diffFields(pick(base, k.fields), values),
        ],
      });
      return this.view(kind, unit, version!);
    });
  }

  /** Ends the unit on a date (inclusive). Refused if a later version is already planned. */
  async close(kind: DatedKind, id: string, effectiveTo: string) {
    await this.assert('update');
    const k = kinds[kind];
    const { actor } = requireContext();
    return this.db.tx(async (tx) => {
      const unit = await this.loadUnit(tx, kind, id);
      const versions = await this.versions(tx, kind, id);
      const current = rowAt(versions, effectiveTo);
      if (!current) throw new BadRequestException({ message: 'Not in force on that date' });
      if (versions.some((v) => v.effectiveFrom > effectiveTo)) {
        throw new BadRequestException({ message: 'A later version is planned; change it first' });
      }
      const [version] = (await tx
        .update(k.version)
        .set({ effectiveTo, updatedAt: new Date(), updatedBy: actor!.userId } as never)
        .where(eq(k.version.id, current.id))
        .returning()) as Row[];
      await this.audit.record(tx, {
        action: 'update',
        table: kind,
        recordId: id,
        fieldChanges: [{ field: 'effective_to', from: current.effectiveTo, to: effectiveTo }],
      });
      return this.view(kind, unit, version!);
    });
  }

  /** All versions of all units of a kind, for as-of queries (the org tree). */
  async allVersions(tx: Tx, kind: DatedKind): Promise<Row[]> {
    const k = kinds[kind];
    return (await tx.select().from(k.version).orderBy(asc(k.version.effectiveFrom))) as Row[];
  }

  private async checkNoCycle(
    tx: Tx,
    departmentId: string | null,
    values: Record<string, unknown>,
    asOf: string,
  ) {
    let parent = (values.parentDepartmentId as string | null | undefined) ?? null;
    if (!parent || !departmentId) return;
    const all = await this.allVersions(tx, 'department');
    const seen = new Set<string>();
    while (parent) {
      if (parent === departmentId)
        throw new BadRequestException({ message: 'Department would be its own ancestor' });
      if (seen.has(parent)) break;
      seen.add(parent);
      const version = rowAt(
        all.filter((v) => v.departmentId === parent),
        asOf,
      );
      parent = (version?.parentDepartmentId as string | null | undefined) ?? null;
    }
  }

  private async loadUnit(tx: Tx, kind: DatedKind, id: string): Promise<Row> {
    const k = kinds[kind];
    const [unit] = (await tx.select().from(k.unit).where(eq(k.unit.id, id))) as Row[];
    if (!unit || unit.deletedAt) throw new NotFoundException();
    return unit;
  }

  private async versions(tx: Tx, kind: DatedKind, id: string): Promise<Row[]> {
    const k = kinds[kind];
    return (await tx
      .select()
      .from(k.version)
      .where(eq(k.unitIdColumn, id))
      .orderBy(asc(k.version.effectiveFrom))) as Row[];
  }

  private view(kind: DatedKind, unit: Row, version: Row): DatedUnitView {
    const k = kinds[kind];
    return {
      id: unit.id,
      code: unit.code as string,
      ...pick(unit, k.unitFields ?? []),
      versionId: version.id,
      effectiveFrom: version.effectiveFrom,
      effectiveTo: version.effectiveTo,
      ...pick(version, k.fields),
    };
  }

  private assert(action: 'read' | 'create' | 'update') {
    return this.authz.assert(requireContext().actor!, action, { area: 'org_config' });
  }
}
