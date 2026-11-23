import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  kycSubmitSchema,
  type HistoryImportInput,
  type ImportFileInput,
  type ImportResult,
} from '@ipro/shared';
import { JourneyService } from '../journey/journey.service.js';
import { checkHistoryFile, HISTORY_EVENTS, type HistoryPerson } from './history-rules.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { parseCsv } from '../leave/csv.js';
import {
  departments,
  departmentVersions,
  designations,
  legalEntities,
  locations,
  locationVersions,
} from '../org/org.schema.js';
import { KycService } from '../people/kyc.service.js';
import { inForce } from '../people/people.queries.js';
import { employeeCodeCounters, engagements, engagementTypes } from '../people/people.schema.js';
import { PeopleService } from '../people/people.service.js';
import { SettingsService } from '../people/settings.service.js';
import { checkPeopleFile, type ImportError, type PersonRow } from './people-import-rules.js';

/** A stable id per migrated event, so loading the same history twice adds nothing. */
function migrationId(tenantId: string, code: string, event: string, date: string): string {
  const h = createHash('sha256').update(`${tenantId}:${code}:${event}:${date}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Thrown inside the import transaction to roll everything back after a check. */
class RollBack extends Error {}

/**
 * The A6 import (slice 13b; decision #94). A file is checked by loading it in one transaction,
 * through the same people and KYC services as the screens, and the transaction is rolled back
 * unless the user asked to load and every row went in: nothing loads until the error count is
 * zero, and a check finds the errors the services would raise as well as the file's own.
 */
@Injectable()
export class ImportService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(KycService) private readonly kyc: KycService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(JourneyService) private readonly journey: JourneyService,
  ) {}

  /**
   * Migration step 5 (spec; decision #95): past confirmations, designation changes, team moves and
   * exits become journey events marked migrated, and `recordedFrom` is kept so each journey says
   * history before it isn't recorded. Loaded once: the same event can't be added twice.
   */
  async historyFile(input: HistoryImportInput): Promise<ImportResult> {
    const actor = requireContext().actor!;
    const records = this.parse(input.csv);
    if ('error' in records) return records.error;
    let outcome: ImportResult = { committed: false, rows: records.length, ready: 0, errors: [] };
    try {
      await this.db.tx(async (tx) => {
        const people = await this.historyPeople(tx);
        const { rows, errors } = checkHistoryFile(records, people, businessDate(new Date()));
        for (const entity of new Set(rows.map((r) => people.get(r.employeeCode)!.legalEntityId))) {
          await this.authz.assert(actor, 'create', {
            area: 'assignment_history',
            legalEntityId: entity,
          });
        }
        let ready = 0;
        if (errors.length === 0) {
          for (const row of rows) {
            const person = people.get(row.employeeCode)!;
            const kind = HISTORY_EVENTS[row.event];
            const added = await this.journey.record(tx, {
              engagementId: person.engagementId,
              personId: person.personId,
              eventType: kind.eventType,
              category: kind.category,
              occurredOn: row.date,
              title: kind.title(row.detail),
              detail: row.detail ? { note: row.detail } : {},
              // Why someone left stays with HR, as for exits recorded in iPro.
              sensitivity: row.event === 'exited' ? 'hr' : 'public',
              sourceTable: 'migration',
              sourceId: migrationId(
                requireContext().tenantId,
                row.employeeCode,
                row.event,
                row.date,
              ),
              migrated: true,
            });
            if (added) ready += 1;
            else errors.push({ line: row.line, message: 'This event is already in the journey' });
          }
          if (errors.length === 0) {
            await this.settings.set(tx, 'history_recorded_from', input.recordedFrom);
          }
        }
        errors.sort((a, b) => a.line - b.line);
        outcome = { committed: false, rows: records.length, ready, errors };
        if (!input.commit || errors.length > 0) throw new RollBack();
        await this.audit.record(tx, {
          action: 'create',
          table: 'import',
          fieldChanges: [{ field: 'history', from: null, to: ready }],
        });
        outcome = { ...outcome, committed: true };
      });
    } catch (error) {
      if (!(error instanceof RollBack)) throw error;
    }
    return outcome;
  }

  private async historyPeople(
    tx: Tx,
  ): Promise<Map<string, HistoryPerson & { legalEntityId: string }>> {
    const rows = await tx
      .select({
        code: engagements.employeeCode,
        personId: engagements.personId,
        engagementId: engagements.id,
        joiningDate: engagements.joiningDate,
        status: engagements.status,
        lastWorkingDate: engagements.lastWorkingDate,
        legalEntityId: engagements.legalEntityId,
      })
      .from(engagements);
    return new Map(rows.map((r) => [r.code, r]));
  }

  /**
   * People with their engagement, first assignment, manager and current CTC, keeping the old
   * system's employee codes. Their joining events are marked migrated.
   */
  async peopleFile(input: ImportFileInput): Promise<ImportResult> {
    const actor = requireContext().actor!;
    const records = this.parse(input.csv);
    if ('error' in records) return records.error;
    let outcome: ImportResult = { committed: false, rows: records.length, ready: 0, errors: [] };
    try {
      await this.db.tx(async (tx) => {
        const lookups = await this.lookups(tx);
        const { rows, errors, order } = checkPeopleFile(records, lookups);
        // The user must be allowed to create people (and pay, if the file has it) in each company.
        for (const entity of new Set(rows.map((r) => r.legalEntityId))) {
          await this.authz.assert(actor, 'create', {
            area: 'assignment_history',
            legalEntityId: entity,
          });
          if (rows.some((r) => r.legalEntityId === entity && r.ctc)) {
            await this.authz.assert(actor, 'create', {
              area: 'compensation',
              legalEntityId: entity,
            });
          }
        }
        const byCode = new Map(rows.map((r) => [r.employeeCode, r]));
        const engagementOf = new Map<string, string>();
        const now = new Date();
        let ready = 0;
        if (errors.length === 0) {
          for (const code of order) {
            const row = byCode.get(code)!;
            const loaded = await this.savepoint(tx, errors, row.line, () =>
              this.loadPerson(tx, row, engagementOf, now),
            );
            if (loaded) ready += 1;
          }
          if (errors.length === 0) await this.bumpCounter(tx, rows);
        }
        errors.sort((a, b) => a.line - b.line);
        outcome = { committed: false, rows: records.length, ready, errors };
        if (!input.commit || errors.length > 0) throw new RollBack();
        await this.audit.record(tx, {
          action: 'create',
          table: 'import',
          fieldChanges: [{ field: 'people', from: null, to: ready }],
        });
        outcome = { ...outcome, committed: true };
      });
    } catch (error) {
      if (!(error instanceof RollBack)) throw error;
    }
    return outcome;
  }

  /** KYC values (encrypted on load, masked when shown), one row per person and type. */
  async kycFile(input: ImportFileInput): Promise<ImportResult> {
    const records = this.parse(input.csv);
    if ('error' in records) return records.error;
    let outcome: ImportResult = { committed: false, rows: records.length, ready: 0, errors: [] };
    try {
      await this.db.tx(async (tx) => {
        const errors: ImportError[] = [];
        const seen = new Map<string, number>();
        const codes = await this.codes(tx);
        const valid: {
          line: number;
          personId: string;
          input: ReturnType<typeof kycSubmitSchema.parse>;
        }[] = [];
        records.forEach((r, i) => {
          const line = i + 2;
          const code = (r.employee_code ?? '').trim();
          const type = (r.type ?? '').trim().toLowerCase();
          const personId = codes.get(code);
          if (!personId)
            errors.push({ line, message: `No one with employee_code ${code || '(empty)'}` });
          const key = `${code}:${type}`;
          if (seen.has(key)) {
            errors.push({
              line,
              message: `Duplicate ${type} for ${code} (also on line ${seen.get(key)})`,
            });
          }
          seen.set(key, seen.get(key) ?? line);
          const parsed = kycSubmitSchema.safeParse({
            type,
            value: r.value ?? '',
            ...(r.ifsc?.trim() ? { ifsc: r.ifsc.trim() } : {}),
          });
          if (!parsed.success) {
            errors.push({
              line,
              message: `${type || 'KYC'}: ${parsed.error.issues.map((x) => x.message).join('; ')}`,
            });
          } else if (personId) {
            valid.push({ line, personId, input: parsed.data });
          }
        });
        let ready = 0;
        if (errors.length === 0) {
          for (const v of valid) {
            if (
              await this.savepoint(tx, errors, v.line, () => this.kyc.submit(v.personId, v.input))
            ) {
              ready += 1;
            }
          }
        }
        errors.sort((a, b) => a.line - b.line);
        outcome = { committed: false, rows: records.length, ready, errors };
        if (!input.commit || errors.length > 0) throw new RollBack();
        await this.audit.record(tx, {
          action: 'create',
          table: 'import',
          fieldChanges: [{ field: 'kyc', from: null, to: ready }],
        });
        outcome = { ...outcome, committed: true };
      });
    } catch (error) {
      if (!(error instanceof RollBack)) throw error;
    }
    return outcome;
  }

  private parse(csv: string): Record<string, string>[] | { error: ImportResult } {
    try {
      return parseCsv(csv);
    } catch {
      return {
        error: {
          committed: false,
          rows: 0,
          ready: 0,
          errors: [{ line: 1, message: 'The file isn’t a readable CSV' }],
        },
      };
    }
  }

  /** Runs one row in a savepoint; a refusal is recorded against its line and the row undone. */
  private async savepoint(
    tx: Tx,
    errors: ImportError[],
    line: number,
    fn: () => Promise<unknown>,
  ): Promise<boolean> {
    try {
      await tx.transaction(async () => {
        await fn();
      });
      return true;
    } catch (error) {
      if (error instanceof HttpException) {
        const body = error.getResponse();
        const message =
          typeof body === 'object' && body && 'message' in body && typeof body.message === 'string'
            ? body.message
            : error.message;
        errors.push({
          line,
          message: error.getStatus() === 403 ? 'Not allowed for this person' : message,
        });
        return false;
      }
      throw error;
    }
  }

  private async loadPerson(
    tx: Tx,
    row: PersonRow,
    engagementOf: Map<string, string>,
    now: Date,
  ): Promise<void> {
    let managerEngagementId: string | null = null;
    if (row.managerCode) {
      managerEngagementId =
        engagementOf.get(row.managerCode) ?? (await this.engagementByCode(tx, row.managerCode));
    }
    const created = await this.people.createIn(
      tx,
      {
        person: {
          legalName: row.legalName,
          preferredName: row.preferredName,
          dateOfBirth: row.dateOfBirth,
          gender: row.gender,
          personalEmail: row.personalEmail,
          phone: row.phone,
        },
        engagement: {
          legalEntityId: row.legalEntityId,
          type: row.engagementType as (typeof engagementTypes)[number],
          workEmail: row.workEmail,
          joiningDate: row.joiningDate,
        },
        assignment: {
          designationId: row.designationId,
          departmentId: row.departmentId,
          locationId: row.locationId,
          managerEngagementId,
          bucket: row.bucket,
        },
        ...(row.ctc
          ? { compensation: { amount: row.ctc.amount, rateUnit: row.ctc.rateUnit as 'year' } }
          : {}),
      },
      now,
      { employeeCode: row.employeeCode, migrated: true },
    );
    engagementOf.set(row.employeeCode, created.engagementId);
    // The facts the old system knew that a new hire doesn't have yet.
    await tx
      .update(engagements)
      .set({
        status: row.status,
        confirmationDate: row.confirmationDate,
        lastWorkingDate: row.lastWorkingDate,
        exitReason: row.exitReason ?? (row.status === 'exited' ? 'migrated' : null),
        updatedAt: new Date(),
      })
      .where(eq(engagements.id, created.engagementId));
  }

  /** New hires after go-live continue after the highest imported code in iPro's format. */
  private async bumpCounter(tx: Tx, rows: PersonRow[]) {
    const { prefix } = await this.settings.get(tx, 'employee_code');
    const numbers = rows
      .map((r) => r.employeeCode)
      .filter((c) => c.startsWith(prefix) && /^\d+$/.test(c.slice(prefix.length)))
      .map((c) => Number(c.slice(prefix.length)));
    if (numbers.length === 0) return;
    const highest = Math.max(...numbers);
    await tx
      .insert(employeeCodeCounters)
      .values({ tenantId: requireContext().tenantId, lastValue: highest })
      .onConflictDoUpdate({
        target: employeeCodeCounters.tenantId,
        set: { lastValue: sql`greatest(${employeeCodeCounters.lastValue}, ${highest})` },
      });
  }

  private async engagementByCode(tx: Tx, code: string): Promise<string | null> {
    const [row] = await tx
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.employeeCode, code));
    return row?.id ?? null;
  }

  private async codes(tx: Tx): Promise<Map<string, string>> {
    const rows = await tx
      .select({ code: engagements.employeeCode, personId: engagements.personId })
      .from(engagements);
    return new Map(rows.map((r) => [r.code, r.personId]));
  }

  private async lookups(tx: Tx) {
    const today = businessDate(new Date());
    const existing = await tx
      .select({ code: engagements.employeeCode, email: engagements.workEmail })
      .from(engagements);
    const desig = await tx
      .select({ id: designations.id, title: designations.title })
      .from(designations)
      .where(isNull(designations.deletedAt));
    const depts = await tx
      .select({ id: departments.id, code: departments.code, name: departmentVersions.name })
      .from(departments)
      .innerJoin(departmentVersions, eq(departmentVersions.departmentId, departments.id))
      .where(
        and(
          isNull(departments.deletedAt),
          inForce(departmentVersions.effectiveFrom, departmentVersions.effectiveTo, today),
        ),
      );
    const locs = await tx
      .select({ id: locations.id, code: locations.code, name: locationVersions.name })
      .from(locations)
      .innerJoin(locationVersions, eq(locationVersions.locationId, locations.id))
      .where(
        and(
          isNull(locations.deletedAt),
          inForce(locationVersions.effectiveFrom, locationVersions.effectiveTo, today),
        ),
      );
    const entities = await tx
      .select({ id: legalEntities.id, name: legalEntities.name })
      .from(legalEntities)
      .where(isNull(legalEntities.deletedAt));
    const byName = (rows: { id: string; name: string; code?: string }[]) => {
      const map = new Map<string, string>();
      for (const r of rows) {
        map.set(r.name.toLowerCase(), r.id);
        if (r.code) map.set(r.code.toLowerCase(), r.id);
      }
      return map;
    };
    return {
      today,
      existingCodes: new Set(existing.map((e) => e.code)),
      existingEmails: new Set(
        existing.map((e) => e.email?.toLowerCase()).filter((e): e is string => Boolean(e)),
      ),
      designations: byName(desig.map((d) => ({ id: d.id, name: d.title }))),
      departments: byName(depts),
      locations: byName(locs),
      legalEntities: byName(entities),
      defaultLegalEntityId: entities.length === 1 ? entities[0]!.id : null,
      buckets: (await this.settings.get(tx, 'buckets')).map((b) => b.toLowerCase()),
      engagementTypes: [...engagementTypes],
    };
  }
}
