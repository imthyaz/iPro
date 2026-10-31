import { Global, Module } from '@nestjs/common';
import { KMSClient } from '@aws-sdk/client-kms';
import { and, eq, isNull } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { TenantDb } from '../db/tenant-db.js';
import { tenantDataKeys } from './audit.schema.js';
import { AuditService, FIELD_CIPHER, SensitiveReads } from './audit.service.js';
import { FieldCipher } from './field-cipher.js';
import { KmsDataKeyProvider, LocalDataKeyProvider, type DataKeyStore } from './key-providers.js';

function dataKeyStore(db: TenantDb): DataKeyStore {
  return {
    find: (tenantId) =>
      db.tx(async (tx) => {
        const [row] = await tx
          .select({ keyRef: tenantDataKeys.keyRef, wrappedKey: tenantDataKeys.wrappedKey })
          .from(tenantDataKeys)
          .where(and(eq(tenantDataKeys.tenantId, tenantId), isNull(tenantDataKeys.retiredAt)));
        return row ?? null;
      }),
    save: (tenantId, key) =>
      db.tx(async (tx) => {
        await tx.insert(tenantDataKeys).values({ tenantId, ...key });
      }),
  };
}

@Global()
@Module({
  providers: [
    AuditService,
    SensitiveReads,
    {
      provide: FIELD_CIPHER,
      inject: [APP_CONFIG, TenantDb],
      useFactory: (config: AppConfig, db: TenantDb) =>
        new FieldCipher(
          config.FIELD_KEY_PROVIDER === 'kms'
            ? new KmsDataKeyProvider(
                new KMSClient({ region: config.AWS_REGION }),
                config.KMS_KEY_ID!,
                dataKeyStore(db),
              )
            : new LocalDataKeyProvider(Buffer.from(config.LOCAL_FIELD_KEY!, 'base64')),
        ),
    },
  ],
  exports: [AuditService, SensitiveReads, FIELD_CIPHER],
})
export class AuditModule {}
