import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { createDelegationSchema, type CreateDelegationInput, type Delegation } from '@ipro/shared';
import { Authorize } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DelegationsService } from './delegations.service.js';

@Controller('delegations')
export class DelegationsController {
  constructor(@Inject(DelegationsService) private readonly delegations: DelegationsService) {}

  @Authorize('approval_delegation', 'create')
  @Post()
  create(
    @Body(new ZodPipe(createDelegationSchema)) body: CreateDelegationInput,
  ): Promise<Delegation> {
    return this.delegations.create(body);
  }

  @Authorize('approval_delegation', 'read')
  @Get()
  list(): Promise<Delegation[]> {
    return this.delegations.listMine();
  }

  @Authorize('approval_delegation', 'update')
  @Post(':id/revoke')
  revoke(@Param('id', new ParseUUIDPipe()) id: string): Promise<Delegation> {
    return this.delegations.revoke(id);
  }
}
