import { Body, Controller, Inject, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { inLifeChangeSchema, type InLifeChangeInput } from '@ipro/shared';
import { Authorize } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { LettersModule } from '../letters/letters.module.js';
import { ChangesService } from './changes.service.js';

const uuid = new ParseUUIDPipe();

/** In-life change requests (H6). HR asks; HR head approves through the workflow engine. */
@Controller()
export class ChangesController {
  constructor(@Inject(ChangesService) private readonly changes: ChangesService) {}

  @Authorize('assignment_history', 'update')
  @Post('people/:id/changes')
  request(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(inLifeChangeSchema)) body: InLifeChangeInput,
  ) {
    return this.changes.request(id, body);
  }
}

@Module({
  imports: [LettersModule],
  controllers: [ChangesController],
  providers: [ChangesService],
})
export class ChangesModule {}
