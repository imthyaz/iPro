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
import { askSchema, type AskInput } from '@ipro/shared';
import { SignedIn } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AssistantService } from './assistant.service.js';
import { AssistantRetentionService } from './retention.service.js';

/**
 * X2 Ask iPro, for every signed-in user. What the answer may contain is decided by each tool's own
 * permission checks, as the user; a conversation is only ever its owner's.
 */
@Controller('assistant')
export class AssistantController {
  constructor(
    @Inject(AssistantService) private readonly assistant: AssistantService,
    @Inject(AssistantRetentionService) private readonly retention: AssistantRetentionService,
  ) {}

  @SignedIn()
  @Post('ask')
  @HttpCode(200)
  ask(@Body(new ZodPipe(askSchema)) body: AskInput) {
    return this.assistant.ask(body);
  }

  /** The user's tap on a confirmation card (decision #91): the only way an answer changes anything. */
  @SignedIn()
  @Post('actions/:id/confirm')
  @HttpCode(200)
  confirm(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.assistant.confirm(id);
  }

  @SignedIn()
  @Post('actions/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.assistant.cancel(id);
  }

  /** Conversations older than 180 days, as summaries (decision #92); q matches topics or people. */
  @SignedIn()
  @Get('archive')
  archive(@Query('q') q?: string) {
    return this.retention.archived(typeof q === 'string' ? q.slice(0, 100) : undefined);
  }

  @SignedIn()
  @Get('conversations')
  conversations() {
    return this.assistant.conversations();
  }

  @SignedIn()
  @Get('conversations/:id')
  conversation(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.assistant.conversation(id);
  }
}
