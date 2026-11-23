import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { requireContext } from '../context/request-context.js';
import type { Tx } from '../db/tenant-context.js';
import {
  formatEmployeeCode,
  settingDefaults,
  settingSchemas,
  type SettingKey,
  type SettingValue,
} from './hr-settings.js';
import { employeeCodeCounters, tenantSettings } from './people.schema.js';

@Injectable()
export class SettingsService {
  /** The tenant's value for a setting, or the spec's proposed default. */
  async get<K extends SettingKey>(tx: Tx, key: K): Promise<SettingValue<K>> {
    const [row] = await tx
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(
        and(eq(tenantSettings.tenantId, requireContext().tenantId), eq(tenantSettings.key, key)),
      );
    if (!row) return settingDefaults[key];
    return settingSchemas[key].parse(row.value) as SettingValue<K>;
  }

  /** Issues the next employee code. The counter only goes up, so codes are never reused. */
  /** Sets a tenant value (for settings iPro itself writes, e.g. on a data migration). */
  async set<K extends SettingKey>(tx: Tx, key: K, value: SettingValue<K>): Promise<void> {
    const { tenantId, actor } = requireContext();
    await tx
      .insert(tenantSettings)
      .values({
        tenantId,
        key,
        value,
        createdBy: actor?.userId ?? null,
        updatedBy: actor?.userId ?? null,
      })
      .onConflictDoUpdate({
        target: [tenantSettings.tenantId, tenantSettings.key],
        set: { value, updatedAt: new Date(), updatedBy: actor?.userId ?? null },
      });
  }

  async nextEmployeeCode(tx: Tx): Promise<string> {
    const tenantId = requireContext().tenantId;
    const [counter] = await tx
      .insert(employeeCodeCounters)
      .values({ tenantId, lastValue: 1 })
      .onConflictDoUpdate({
        target: employeeCodeCounters.tenantId,
        set: { lastValue: sql`${employeeCodeCounters.lastValue} + 1` },
      })
      .returning({ value: employeeCodeCounters.lastValue });
    return formatEmployeeCode(counter!.value, await this.get(tx, 'employee_code'));
  }
}
