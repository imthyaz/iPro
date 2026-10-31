import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config.js';
import * as schema from './schema.js';
import { TenantDb } from './tenant-db.js';
import { DB, PG_POOL, type Db } from './tokens.js';

export { DB, PG_POOL, type Db } from './tokens.js';

@Injectable()
class PoolShutdown implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 }),
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): Db => drizzle({ client: pool, schema }),
    },
    PoolShutdown,
    TenantDb,
  ],
  exports: [PG_POOL, DB, TenantDb],
})
export class DbModule {}
