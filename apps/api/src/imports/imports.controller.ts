import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import {
  historyImportSchema,
  importFileSchema,
  type HistoryImportInput,
  type ImportFileInput,
} from '@ipro/shared';
import { AuthorizeAny } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ImportService } from './import.service.js';

/**
 * A6 import (decision #94): for those who may create people (HR, HR head) and update KYC. The
 * service checks each company in the file, and loads only a file with no errors.
 */
@Controller('imports')
export class ImportsController {
  constructor(@Inject(ImportService) private readonly imports: ImportService) {}

  @AuthorizeAny(['assignment_history', 'create'])
  @Post('people')
  @HttpCode(200)
  people(@Body(new ZodPipe(importFileSchema)) body: ImportFileInput) {
    return this.imports.peopleFile(body);
  }

  @AuthorizeAny(['assignment_history', 'create'])
  @Post('history')
  @HttpCode(200)
  history(@Body(new ZodPipe(historyImportSchema)) body: HistoryImportInput) {
    return this.imports.historyFile(body);
  }

  @AuthorizeAny(['kyc', 'update'])
  @Post('kyc')
  @HttpCode(200)
  kyc(@Body(new ZodPipe(importFileSchema)) body: ImportFileInput) {
    return this.imports.kycFile(body);
  }
}
