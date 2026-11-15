import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { askSchema, type AskInput } from '@ipro/shared';
import { SignedIn } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AssistantService } from './assistant.service.js';

/**
 * X2 Ask iPro, for every signed-in user. What the answer may contain is decided by each tool's own
 * permission checks, as the user; a conversation is only ever its owner's.
 */
@Controller('assistant')
export class AssistantController {
  constructor(@Inject(AssistantService) private readonly assistant: AssistantService) {}

  @SignedIn()
  @Post('ask')
  @HttpCode(200)
  ask(@Body(new ZodPipe(askSchema)) body: AskInput) {
    return this.assistant.ask(body);
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
