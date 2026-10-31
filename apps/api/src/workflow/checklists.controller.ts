import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import {
  cancelRunSchema,
  checklistTemplateSchema,
  completeTaskSchema,
  startChecklistSchema,
  waiveTaskSchema,
  type ChecklistTemplateInput,
} from '@ipro/shared';
import { z } from 'zod';
import { Authorize, SignedIn } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ChecklistsService } from './checklists.service.js';

const uuid = new ParseUUIDPipe();
const keySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.]*$/)
  .max(60);

/**
 * Checklist templates (A3), runs per person (H2, H5) and tasks (Action inbox). Task routes need a
 * session only: the service checks the task's owner, or HR rights over the person.
 */
@Controller()
export class ChecklistsController {
  constructor(@Inject(ChecklistsService) private readonly checklists: ChecklistsService) {}

  @Authorize('org_config', 'read')
  @Get('checklist-templates')
  templates() {
    return this.checklists.listTemplates();
  }

  @Authorize('org_config', 'update')
  @Put('checklist-templates/:key')
  saveTemplate(
    @Param('key', new ZodPipe(keySchema)) key: string,
    @Body(new ZodPipe(checklistTemplateSchema)) body: ChecklistTemplateInput,
  ) {
    return this.checklists.saveTemplate(key, body);
  }

  @Authorize('assignment_history', 'update')
  @Post('people/:id/checklists')
  start(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(startChecklistSchema)) body: z.infer<typeof startChecklistSchema>,
  ) {
    return this.checklists.start(id, body);
  }

  @Authorize('profile', 'read')
  @Get('people/:id/checklists')
  forPerson(@Param('id', uuid) id: string) {
    return this.checklists.runsFor(id);
  }

  @Authorize('assignment_history', 'read')
  @Get('checklist-runs')
  open() {
    return this.checklists.openRuns();
  }

  @Authorize('assignment_history', 'update')
  @Post('checklist-runs/:id/cancel')
  cancel(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(cancelRunSchema)) body: z.infer<typeof cancelRunSchema>,
  ) {
    return this.checklists.cancelRun(id, body.reason);
  }

  @SignedIn()
  @Get('checklist-tasks/mine')
  mine() {
    return this.checklists.myTasks();
  }

  @SignedIn()
  @Post('checklist-tasks/:id/done')
  done(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(completeTaskSchema)) body: z.infer<typeof completeTaskSchema>,
  ) {
    return this.checklists.completeTask(id, body);
  }

  @Authorize('assignment_history', 'update')
  @Post('checklist-tasks/:id/waive')
  waive(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(waiveTaskSchema)) body: z.infer<typeof waiveTaskSchema>,
  ) {
    return this.checklists.waiveTask(id, body.reason);
  }
}
