import { Global, Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { WorkflowActions } from './actions.js';
import { ChecklistsController } from './checklists.controller.js';
import { ChecklistsService } from './checklists.service.js';
import { RequestsService } from './requests.service.js';
import { WorkflowController } from './workflow.controller.js';
import { WorkflowService } from './workflow.service.js';

/**
 * Daily sweeps, India time: approval reminders and escalations at 06:30 (escalation window), checklist
 * task reminders at 07:00 (due date, then daily while overdue).
 */
@Injectable()
class WorkflowSweepJob implements OnModuleInit {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(ChecklistsService) private readonly checklists: ChecklistsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'workflow-sweep',
      cron: '30 6 * * *',
      run: () => runWithContext({ tenantId: this.config.TENANT_ID }, () => this.workflows.sweep()),
    });
    this.jobs.register({
      name: 'checklist-sweep',
      cron: '0 7 * * *',
      run: () => runWithContext({ tenantId: this.config.TENANT_ID }, () => this.checklists.sweep()),
    });
  }
}

/** Global so other modules can start workflows and register the actions that run on approval. */
@Global()
@Module({
  imports: [AttendanceModule],
  controllers: [WorkflowController, ChecklistsController],
  providers: [
    WorkflowActions,
    WorkflowService,
    RequestsService,
    ChecklistsService,
    WorkflowSweepJob,
  ],
  exports: [WorkflowActions, WorkflowService, ChecklistsService],
})
export class WorkflowModule {}
