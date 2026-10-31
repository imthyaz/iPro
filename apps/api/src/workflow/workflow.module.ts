import { Global, Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { WorkflowActions } from './actions.js';
import { RequestsService } from './requests.service.js';
import { WorkflowController } from './workflow.controller.js';
import { WorkflowService } from './workflow.service.js';

/** Reminders and escalations, daily at 06:30 India time (spec: approvals, escalation window). */
@Injectable()
class WorkflowSweepJob implements OnModuleInit {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'workflow-sweep',
      cron: '30 6 * * *',
      run: () => runWithContext({ tenantId: this.config.TENANT_ID }, () => this.workflows.sweep()),
    });
  }
}

/** Global so other modules can start workflows and register the actions that run on approval. */
@Global()
@Module({
  imports: [AttendanceModule],
  controllers: [WorkflowController],
  providers: [WorkflowActions, WorkflowService, RequestsService, WorkflowSweepJob],
  exports: [WorkflowActions, WorkflowService],
})
export class WorkflowModule {}
