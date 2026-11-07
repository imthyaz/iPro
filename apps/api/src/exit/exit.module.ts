import { Module } from '@nestjs/common';
import { LettersModule } from '../letters/letters.module.js';
import { ExitController } from './exit.controller.js';
import { ExitService } from './exit.service.js';

/** Exit (slice 9; spec workflow 7). */
@Module({
  imports: [LettersModule],
  controllers: [ExitController],
  providers: [ExitService],
  exports: [ExitService],
})
export class ExitModule {}
