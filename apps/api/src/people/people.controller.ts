import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  changeAssignmentSchema,
  changeCompensationSchema,
  convertEngagementSchema,
  createPersonSchema,
  emergencyContactInputSchema,
  peopleQuerySchema,
  type ChangeAssignmentInput,
  type ChangeCompensationInput,
  type ConvertEngagementInput,
  type CreatePersonInput,
} from '@ipro/shared';
import type { z } from 'zod';
import { Authorize } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { PeopleService } from './people.service.js';

const uuid = new ParseUUIDPipe();

/** People directory (H1), person record (H2, E7, M7). */
@Controller('people')
export class PeopleController {
  constructor(@Inject(PeopleService) private readonly people: PeopleService) {}

  @Authorize('profile', 'read')
  @Get()
  directory(@Query(new ZodPipe(peopleQuerySchema)) query: z.infer<typeof peopleQuerySchema>) {
    return this.people.directory(query);
  }

  @Authorize('assignment_history', 'create')
  @Post()
  create(@Body(new ZodPipe(createPersonSchema)) body: CreatePersonInput) {
    return this.people.create(body);
  }

  @Authorize('assignment_history', 'create')
  @Get('form-options')
  formOptions() {
    return this.people.formOptions();
  }

  @Authorize('profile', 'read')
  @Get(':id')
  get(@Param('id', uuid) id: string) {
    return this.people.get(id);
  }

  @Authorize('assignment_history', 'read')
  @Get(':id/assignments')
  assignments(@Param('id', uuid) id: string) {
    return this.people.assignmentHistory(id);
  }

  @Authorize('assignment_history', 'update')
  @Post(':id/assignments')
  changeAssignment(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(changeAssignmentSchema)) body: ChangeAssignmentInput,
  ) {
    return this.people.changeAssignment(id, body);
  }

  @Authorize('compensation', 'read')
  @Get(':id/compensation')
  compensation(@Param('id', uuid) id: string) {
    return this.people.compensationHistory(id);
  }

  @Authorize('compensation', 'create')
  @Post(':id/compensation')
  changeCompensation(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(changeCompensationSchema)) body: ChangeCompensationInput,
  ) {
    return this.people.changeCompensation(id, body);
  }

  /** Retainer or consultant to payroll (done-when: one person, one continuous journey). */
  @Authorize('assignment_history', 'update')
  @Post(':id/convert')
  convert(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(convertEngagementSchema)) body: ConvertEngagementInput,
  ) {
    return this.people.convert(id, body);
  }

  @Authorize('journey_public', 'read')
  @Get(':id/journey')
  journey(@Param('id', uuid) id: string) {
    return this.people.journeyOf(id);
  }

  @Authorize('profile', 'update')
  @Post(':id/emergency-contacts')
  addEmergencyContact(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(emergencyContactInputSchema))
    body: z.infer<typeof emergencyContactInputSchema>,
  ) {
    return this.people.addEmergencyContact(id, body);
  }

  @Authorize('profile', 'update')
  @Delete(':id/emergency-contacts/:contactId')
  removeEmergencyContact(
    @Param('id', uuid) id: string,
    @Param('contactId', uuid) contactId: string,
  ) {
    return this.people.removeEmergencyContact(id, contactId);
  }
}
