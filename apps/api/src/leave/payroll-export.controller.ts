import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { payrollMonthQuerySchema } from '@ipro/shared';
import type { z } from 'zod';
import { Authorize } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { PayrollExportService } from './payroll-export.service.js';

interface HttpResponse {
  setHeader(name: string, value: string): void;
}
type MonthQuery = z.infer<typeof payrollMonthQuerySchema>;

/**
 * H9 payroll export (decision #77): HR and HR head, who may change attendance, see a month and
 * download it as CSV for the current payroll.
 */
@Controller('payroll-export')
export class PayrollExportController {
  constructor(@Inject(PayrollExportService) private readonly exports: PayrollExportService) {}

  @Authorize('attendance', 'update')
  @Get()
  view(@Query(new ZodPipe(payrollMonthQuerySchema)) query: MonthQuery) {
    return this.exports.view(query.month);
  }

  @Authorize('attendance', 'update')
  @Get('csv')
  async csv(
    @Query(new ZodPipe(payrollMonthQuerySchema)) query: MonthQuery,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<string> {
    const file = await this.exports.csv(query.month);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return file.body;
  }
}
