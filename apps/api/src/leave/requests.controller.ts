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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  leaveApplySchema,
  leaveRevokeSchema,
  leaveYearQuerySchema,
  type LeaveApplyInput,
  type LeaveRevokeInput,
} from '@ipro/shared';
import type { z } from 'zod';
import { Authorize, AuthorizeAny } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MAX_UPLOAD_BYTES, type IncomingFile } from '../people/documents.service.js';
import { LeaveRequestsService } from './requests.service.js';

const uuid = new ParseUUIDPipe();

/** E4 apply leave, E5 my requests, cancel; HR revokes; the person record's requests. */
@Controller()
export class LeaveRequestsController {
  constructor(@Inject(LeaveRequestsService) private readonly requests: LeaveRequestsService) {}

  @Authorize('leave', 'create')
  @Post('leave/requests/preview')
  @HttpCode(200)
  preview(@Body(new ZodPipe(leaveApplySchema)) body: LeaveApplyInput) {
    return this.requests.preview(body);
  }

  @Authorize('leave', 'create')
  @Post('leave/requests')
  apply(@Body(new ZodPipe(leaveApplySchema)) body: LeaveApplyInput) {
    return this.requests.apply(body);
  }

  @Authorize('leave', 'read')
  @Get('leave/requests/mine')
  mine(@Query(new ZodPipe(leaveYearQuerySchema)) query: z.infer<typeof leaveYearQuerySchema>) {
    return this.requests.mine(query.year);
  }

  @Authorize('leave', 'read')
  @Get('people/:id/leave/requests')
  forPerson(
    @Param('id', uuid) id: string,
    @Query(new ZodPipe(leaveYearQuerySchema)) query: z.infer<typeof leaveYearQuerySchema>,
  ) {
    return this.requests.forPerson(id, query.year);
  }

  @Authorize('leave', 'cancel')
  @Post('leave/requests/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id', uuid) id: string) {
    return this.requests.cancel(id);
  }

  @Authorize('leave', 'update')
  @Post('leave/requests/:id/revoke')
  @HttpCode(200)
  revoke(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(leaveRevokeSchema)) body: LeaveRevokeInput,
  ) {
    return this.requests.revoke(id, body);
  }

  /** Multipart `file`: a medical certificate, kept confidential. */
  @AuthorizeAny(['leave', 'create'], ['leave', 'update'])
  @Post('leave/requests/:id/certificate')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  certificate(@Param('id', uuid) id: string, @UploadedFile() file: IncomingFile | undefined) {
    return this.requests.attachCertificate(id, file);
  }
}
