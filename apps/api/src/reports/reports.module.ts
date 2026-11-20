import { Module } from '@nestjs/common';
import { HybridModule } from '../hybrid/hybrid.module.js';
import { LeaveModule } from '../leave/leave.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/** H12 Phase 1 reports (slice 13a; decision #93). */
@Module({
  imports: [HybridModule, LeaveModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
