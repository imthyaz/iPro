import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { generateLetterSchema, letterTemplateSchema, type LetterTemplateInput } from '@ipro/shared';
import { z } from 'zod';
import { Authorize, Public } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { LettersService } from './letters.service.js';

const uuid = new ParseUUIDPipe();
const keySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.]*$/)
  .max(60);

/** Letter templates (A3), letters per person (H2), and the e-sign provider's webhook. */
@Controller()
export class LettersController {
  constructor(@Inject(LettersService) private readonly letters: LettersService) {}

  @Authorize('org_config', 'read')
  @Get('letter-templates')
  templates() {
    return this.letters.listTemplates();
  }

  @Authorize('org_config', 'update')
  @Put('letter-templates/:key')
  saveTemplate(
    @Param('key', new ZodPipe(keySchema)) key: string,
    @Body(new ZodPipe(letterTemplateSchema)) body: LetterTemplateInput,
  ) {
    return this.letters.saveTemplate(key, body);
  }

  @Authorize('documents', 'create')
  @Post('people/:id/letters')
  generate(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(generateLetterSchema)) body: z.infer<typeof generateLetterSchema>,
  ) {
    return this.letters.generate(id, body);
  }

  @Authorize('documents', 'read')
  @Get('people/:id/letters')
  forPerson(@Param('id', uuid) id: string) {
    return this.letters.lettersFor(id);
  }

  @Authorize('documents', 'update')
  @Post('letters/:id/send')
  send(@Param('id', uuid) id: string) {
    return this.letters.send(id);
  }

  @Authorize('documents', 'update')
  @Post('letters/:id/cancel')
  cancel(@Param('id', uuid) id: string) {
    return this.letters.cancel(id);
  }

  /**
   * Zoho Sign calls this when a request changes. Verified by HMAC when a secret is set, and only used
   * to learn which request to re-check with Zoho; the payload never decides the outcome.
   */
  @Public()
  @Post('esign/webhook')
  @HttpCode(204)
  async webhook(
    @Req() req: { rawBody?: Buffer; headers: Record<string, string | string[] | undefined> },
  ) {
    await this.letters.webhook(req.rawBody ?? Buffer.alloc(0), req.headers);
  }
}
