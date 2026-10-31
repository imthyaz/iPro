import { Module } from '@nestjs/common';
import { CatalogService } from './catalog.service.js';
import { DatedUnitsService } from './dated-units.service.js';
import { OrgController } from './org.controller.js';

@Module({
  controllers: [OrgController],
  providers: [CatalogService, DatedUnitsService],
  exports: [DatedUnitsService],
})
export class OrgModule {}
