import { Module } from '@nestjs/common';
import { PeopleModule } from '../people/people.module.js';
import { ImportsController } from './imports.controller.js';
import { ImportService } from './import.service.js';

/** A6 import for the data migration (slice 13b; decision #94). */
@Module({
  imports: [PeopleModule],
  controllers: [ImportsController],
  providers: [ImportService],
})
export class ImportsModule {}
