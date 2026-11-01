import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  acceptPolicySchema,
  policyInputSchema,
  publishVersionSchema,
  type PolicyInput,
} from '@ipro/shared';
import type { z } from 'zod';
import { Authorize, SignedIn } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MAX_UPLOAD_BYTES, type IncomingFile } from '../people/documents.service.js';
import { PoliciesService } from './policies.service.js';

const uuid = new ParseUUIDPipe();

/**
 * Policies (A2) and in-app acknowledgements (E11, E1). Reading and accepting need a session only:
 * the service checks the policy applies to the person.
 */
@Controller('policies')
export class PoliciesController {
  constructor(@Inject(PoliciesService) private readonly policies: PoliciesService) {}

  @SignedIn()
  @Get('mine')
  mine() {
    return this.policies.mine();
  }

  @SignedIn()
  @Post('versions/:id/link')
  link(@Param('id', uuid) id: string) {
    return this.policies.fileLink(id);
  }

  @SignedIn()
  @Post('versions/:id/accept')
  accept(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(acceptPolicySchema)) body: z.infer<typeof acceptPolicySchema>,
  ) {
    return this.policies.accept(id, body.contentHash);
  }

  @Authorize('org_config', 'read')
  @Get()
  list() {
    return this.policies.list();
  }

  @Authorize('org_config', 'update')
  @Post()
  create(@Body(new ZodPipe(policyInputSchema)) body: PolicyInput) {
    return this.policies.create(body);
  }

  @Authorize('org_config', 'read')
  @Get(':id')
  status(@Param('id', uuid) id: string) {
    return this.policies.status(id);
  }

  /** Multipart: `file` (PDF) plus `effectiveFrom` and an optional `summary`. */
  @Authorize('org_config', 'update')
  @Post(':id/versions')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  publish(
    @Param('id', uuid) id: string,
    @UploadedFile() file: IncomingFile | undefined,
    @Body(new ZodPipe(publishVersionSchema)) body: z.infer<typeof publishVersionSchema>,
  ) {
    return this.policies.publish(id, file, body);
  }
}
