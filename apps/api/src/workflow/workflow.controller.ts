import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  allocateShiftSchema,
  approveSchema,
  commentSchema,
  profileChangeSchema,
  rejectSchema,
  submitWorkflowSchema,
  workflowDefinitionSchema,
  type AllocateShiftInput,
  type ProfileChange,
  type WorkflowDefinition,
} from '@ipro/shared';
import { z } from 'zod';
import { Authorize, SignedIn } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { RequestsService } from './requests.service.js';
import { WorkflowService } from './workflow.service.js';

const uuid = new ParseUUIDPipe();
const keySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.]*$/)
  .max(60);
const resubmitSchema = z.object({ payload: z.record(z.string(), z.unknown()).optional() });

/**
 * Approvals and requests. Approval routes need only a session here: the engine decides who may act on
 * each step (assignee, role holder, escalation, delegation) and checks the step's permission in authz.
 */
@Controller()
export class WorkflowController {
  constructor(
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(RequestsService) private readonly requests: RequestsService,
  ) {}

  @SignedIn()
  @Get('approvals')
  myApprovals() {
    return this.workflows.myApprovals();
  }

  @SignedIn()
  @Post('approvals/:id/approve')
  approve(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(approveSchema)) body: z.infer<typeof approveSchema>,
  ) {
    return this.workflows.approve(id, body.comment);
  }

  @SignedIn()
  @Post('approvals/:id/reject')
  reject(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(rejectSchema)) body: z.infer<typeof rejectSchema>,
  ) {
    return this.workflows.reject(id, body.comment);
  }

  @SignedIn()
  @Get('workflows')
  mine() {
    return this.workflows.mySubmissions();
  }

  @SignedIn()
  @Post('workflows')
  submit(@Body(new ZodPipe(submitWorkflowSchema)) body: z.infer<typeof submitWorkflowSchema>) {
    return this.workflows.submitGeneric(body);
  }

  @SignedIn()
  @Get('workflows/:id')
  get(@Param('id', uuid) id: string) {
    return this.workflows.get(id);
  }

  @SignedIn()
  @Post('workflows/:id/comments')
  comment(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(commentSchema)) body: z.infer<typeof commentSchema>,
  ) {
    return this.workflows.comment(id, body.body);
  }

  @SignedIn()
  @Post('workflows/:id/withdraw')
  withdraw(@Param('id', uuid) id: string) {
    return this.workflows.withdraw(id);
  }

  @SignedIn()
  @Post('workflows/:id/resubmit')
  resubmit(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(resubmitSchema)) body: z.infer<typeof resubmitSchema>,
  ) {
    return this.workflows.resubmit(id, body.payload);
  }

  @Authorize('org_config', 'read')
  @Get('workflow-definitions')
  definitions() {
    return this.workflows.listDefinitions();
  }

  @Authorize('org_config', 'update')
  @Put('workflow-definitions/:key')
  saveDefinition(
    @Param('key', new ZodPipe(keySchema)) key: string,
    @Body(new ZodPipe(workflowDefinitionSchema)) body: WorkflowDefinition,
  ) {
    return this.workflows.saveDefinition(key, body);
  }

  @SignedIn()
  @Get('notifications')
  notifications() {
    return this.workflows.myNotifications();
  }

  @SignedIn()
  @Post('notifications/:id/read')
  @HttpCode(204)
  async markRead(@Param('id', uuid) id: string) {
    await this.workflows.markRead(id);
  }

  /** HR changes directly; an employee's own change becomes a request for HR. */
  @Authorize('profile', 'update')
  @Patch('people/:id/profile')
  changeProfile(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(profileChangeSchema)) body: ProfileChange,
  ) {
    return this.requests.changeProfile(id, body);
  }

  /** A manager asks for team members' shifts to change; HR approves (decision #47). */
  @Authorize('attendance', 'approve')
  @Post('shifts/change-requests')
  requestShiftChange(@Body(new ZodPipe(allocateShiftSchema)) body: AllocateShiftInput) {
    return this.requests.requestShiftChange(body);
  }
}
