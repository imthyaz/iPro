import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { AttendanceModule } from './attendance/attendance.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthzModule } from './authz/authz.module.js';
import { ConfigModule } from './config.module.js';
import { RequestContextMiddleware } from './context/request-context.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { LettersModule } from './letters/letters.module.js';
import { OrgModule } from './org/org.module.js';
import { PeopleModule } from './people/people.module.js';
import { PoliciesModule } from './policies/policies.module.js';
import { StorageModule } from './storage/storage.module.js';
import { WorkflowModule } from './workflow/workflow.module.js';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    JobsModule,
    AuditModule,
    StorageModule,
    IdentityModule,
    AuthzModule,
    HealthModule,
    OrgModule,
    PeopleModule,
    AttendanceModule,
    WorkflowModule,
    LettersModule,
    PoliciesModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
