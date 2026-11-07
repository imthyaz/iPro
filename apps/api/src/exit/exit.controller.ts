import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  exitWithdrawSchema,
  hrAcceptSchema,
  managerAcceptSchema,
  resignationSchema,
  terminationSchema,
  type HrAcceptInput,
  type ResignationInput,
  type TerminationInput,
} from '@ipro/shared';
import { z } from 'zod';
import { Authorize, AuthorizeAny } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ExitService } from './exit.service.js';

const listQuerySchema = z.object({ closed: z.enum(['true', 'false']).optional() });

/** E10 Resign, the exit page for managers and HR, H8 Exit tracker, termination (spec workflow 7). */
@Controller()
export class ExitController {
  constructor(@Inject(ExitService) private readonly exits: ExitService) {}

  @Authorize('exit', 'create')
  @Get('exits/mine')
  mine() {
    return this.exits.mine();
  }

  @Authorize('exit', 'create')
  @Post('exits/resign')
  resign(@Body(new ZodPipe(resignationSchema)) body: ResignationInput) {
    return this.exits.resign(body);
  }

  @AuthorizeAny(['exit', 'read'])
  @Get('exits')
  list(@Query(new ZodPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>) {
    return this.exits.list(query.closed === 'true');
  }

  @AuthorizeAny(['exit', 'read'], ['exit', 'create'])
  @Get('exits/:id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.exits.get(id);
  }

  @Authorize('exit', 'withdraw')
  @Post('exits/:id/withdraw')
  @HttpCode(200)
  withdraw(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(exitWithdrawSchema)) body: z.infer<typeof exitWithdrawSchema>,
  ) {
    return this.exits.withdraw(id, body.reason);
  }

  @Authorize('exit', 'approve')
  @Post('exits/:id/manager-accept')
  @HttpCode(200)
  managerAccept(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(managerAcceptSchema)) body: z.infer<typeof managerAcceptSchema>,
  ) {
    return this.exits.managerAccept(id, body.retentionNote);
  }

  @Authorize('exit', 'update')
  @Post('exits/:id/hr-accept')
  @HttpCode(200)
  hrAccept(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(hrAcceptSchema)) body: HrAcceptInput,
  ) {
    return this.exits.hrAccept(id, body);
  }

  @Authorize('exit', 'terminate')
  @Post('people/:id/terminate')
  terminate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(terminationSchema)) body: TerminationInput,
  ) {
    return this.exits.terminate(id, body);
  }
}
