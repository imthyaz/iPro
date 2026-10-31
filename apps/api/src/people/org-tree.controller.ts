import { Controller, Get, Inject, Query } from '@nestjs/common';
import { asOfQuerySchema } from '@ipro/shared';
import { Authorize } from '../authz/decorators.js';
import { businessDate } from '../common/effective-dating.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { OrgTreeService } from './org-tree.service.js';

/** Org tree as of a date (screen H10). */
@Controller('org-tree')
export class OrgTreeController {
  constructor(@Inject(OrgTreeService) private readonly tree: OrgTreeService) {}

  @Authorize('assignment_history', 'read')
  @Get()
  get(@Query(new ZodPipe(asOfQuerySchema)) query: { asOf?: string }) {
    return this.tree.asOf(query.asOf ?? businessDate(new Date()));
  }
}
