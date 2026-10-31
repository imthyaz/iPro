import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { MemoryStorage, OBJECT_STORAGE, S3Storage, type ObjectStorage } from './object-storage.js';

@Injectable()
class LocalBucket implements OnApplicationBootstrap {
  private readonly logger = new Logger('Storage');

  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!(this.storage instanceof S3Storage) || !this.config.S3_ENDPOINT) return;
    try {
      await this.storage.ensureBucket();
    } catch (error) {
      // Documents fail until the local S3 server is up; the rest of the API still works.
      this.logger.warn(`Local S3 bucket not ready: ${(error as Error).name}`);
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): ObjectStorage =>
        config.STORAGE_PROVIDER === 'memory'
          ? new MemoryStorage()
          : new S3Storage({
              bucket: config.S3_BUCKET,
              region: config.AWS_REGION,
              endpoint: config.S3_ENDPOINT,
              accessKeyId: config.S3_ACCESS_KEY_ID,
              secretAccessKey: config.S3_SECRET_ACCESS_KEY,
            }),
    },
    LocalBucket,
  ],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}
