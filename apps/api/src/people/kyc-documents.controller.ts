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
import { documentUploadSchema, kycSubmitSchema, type KycSubmitInput } from '@ipro/shared';
import type { z } from 'zod';
import { Authorize, AuthorizeAny } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DocumentsService, MAX_UPLOAD_BYTES, type IncomingFile } from './documents.service.js';
import { KycService } from './kyc.service.js';

const uuid = new ParseUUIDPipe();

/** KYC (H2 tab, E7, E11 uploads) and person documents (H2 tab, E9). */
@Controller('people/:id')
export class KycDocumentsController {
  constructor(
    @Inject(KycService) private readonly kyc: KycService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  @Authorize('kyc', 'read')
  @Get('kyc')
  listKyc(@Param('id', uuid) id: string) {
    return this.kyc.list(id);
  }

  @Authorize('kyc', 'unmask')
  @Post('kyc/:kycId/unmask')
  unmask(@Param('id', uuid) id: string, @Param('kycId', uuid) kycId: string) {
    return this.kyc.unmask(id, kycId);
  }

  @AuthorizeAny(['kyc', 'create'], ['kyc', 'update'])
  @Post('kyc')
  submit(@Param('id', uuid) id: string, @Body(new ZodPipe(kycSubmitSchema)) body: KycSubmitInput) {
    return this.kyc.submit(id, body);
  }

  @Authorize('kyc', 'verify')
  @Post('kyc/:kycId/verify')
  verify(@Param('id', uuid) id: string, @Param('kycId', uuid) kycId: string) {
    return this.kyc.verify(id, kycId);
  }

  @Authorize('documents', 'read')
  @Get('documents')
  listDocuments(@Param('id', uuid) id: string) {
    return this.documents.list(id);
  }

  /** Multipart: `file` plus `type`, `title`, `confidential`. KYC scans are checked as KYC in the service. */
  @AuthorizeAny(['kyc', 'create'], ['kyc', 'update'], ['documents', 'create'])
  @Post('documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(
    @Param('id', uuid) id: string,
    @UploadedFile() file: IncomingFile | undefined,
    @Body(new ZodPipe(documentUploadSchema)) body: z.infer<typeof documentUploadSchema>,
  ) {
    return this.documents.upload(id, file, body);
  }

  @Authorize('documents', 'read')
  @Post('documents/:documentId/link')
  link(@Param('id', uuid) id: string, @Param('documentId', uuid) documentId: string) {
    return this.documents.downloadLink(id, documentId);
  }
}
