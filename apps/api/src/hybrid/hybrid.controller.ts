import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  complianceQuerySchema,
  seatInputSchema,
  seatQuerySchema,
  teamAnchorSchema,
  teamMonthQuerySchema,
  teamTodayQuerySchema,
  weekPlanSchema,
  weekQuerySchema,
  workPolicyInputSchema,
  type SeatInput,
  type WeekPlanInput,
  type WorkPolicyInput,
} from '@ipro/shared';
import { z } from 'zod';
import { Authorize, AuthorizeAny } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ComplianceService } from './compliance.service.js';
import { HybridService } from './hybrid.service.js';

const seatActiveSchema = z.object({ active: z.boolean() });
const locationQuerySchema = z.object({ locationId: z.uuid() });

/** E6 Plan my week, the team anchor day, and the configuration behind them (A2). */
@Controller()
export class HybridController {
  constructor(
    @Inject(HybridService) private readonly hybrid: HybridService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
  ) {}

  /** M2 Team today: managers (their team) and HR (their entities). */
  @AuthorizeAny(['hybrid_booking', 'approve'], ['attendance', 'update'])
  @Get('hybrid/team-today')
  teamToday(@Query(new ZodPipe(teamTodayQuerySchema)) query: z.infer<typeof teamTodayQuerySchema>) {
    return this.compliance.teamToday(query.scope);
  }

  /** M3 Team calendar. */
  @AuthorizeAny(['hybrid_booking', 'approve'], ['attendance', 'update'])
  @Get('hybrid/team-calendar')
  teamCalendar(
    @Query(new ZodPipe(teamMonthQuerySchema)) query: z.infer<typeof teamMonthQuerySchema>,
  ) {
    return this.compliance.teamCalendar(query.month, query.scope);
  }

  /** M4 compliance: planned vs actual per person per week. */
  @AuthorizeAny(['hybrid_booking', 'approve'], ['attendance', 'update'])
  @Get('hybrid/compliance')
  complianceReport(
    @Query(new ZodPipe(complianceQuerySchema)) query: z.infer<typeof complianceQuerySchema>,
  ) {
    return this.compliance.report(query.from, query.to, query.scope);
  }

  @Authorize('hybrid_booking', 'read')
  @Get('hybrid/week')
  week(@Query(new ZodPipe(weekQuerySchema)) query: z.infer<typeof weekQuerySchema>) {
    return this.hybrid.week(query.start);
  }

  @Authorize('hybrid_booking', 'create')
  @Put('hybrid/week')
  save(@Body(new ZodPipe(weekPlanSchema)) body: WeekPlanInput) {
    return this.hybrid.savePlan(body);
  }

  @Authorize('hybrid_booking', 'read')
  @Get('hybrid/seats')
  seatsFree(@Query(new ZodPipe(seatQuerySchema)) query: z.infer<typeof seatQuerySchema>) {
    return this.hybrid.seatAvailability(query.locationId, query.date);
  }

  @Authorize('hybrid_booking', 'approve')
  @Get('hybrid/team-anchor')
  teamAnchor() {
    return this.hybrid.teamAnchor();
  }

  @Authorize('hybrid_booking', 'approve')
  @Put('hybrid/team-anchor')
  anchor(@Body(new ZodPipe(teamAnchorSchema)) body: z.infer<typeof teamAnchorSchema>) {
    return this.hybrid.setTeamAnchor(body.weekday);
  }

  @Authorize('org_config', 'read')
  @Get('work-policies')
  policies() {
    return this.hybrid.policies();
  }

  @Authorize('org_config', 'create')
  @Post('work-policies')
  createPolicy(@Body(new ZodPipe(workPolicyInputSchema)) body: WorkPolicyInput) {
    return this.hybrid.createPolicy(body);
  }

  @Authorize('org_config', 'update')
  @Put('work-policies/:id')
  updatePolicy(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(workPolicyInputSchema)) body: WorkPolicyInput,
  ) {
    return this.hybrid.updatePolicy(id, body);
  }

  @Authorize('org_config', 'read')
  @Get('seats')
  seats(@Query(new ZodPipe(locationQuerySchema)) query: z.infer<typeof locationQuerySchema>) {
    return this.hybrid.seats(query.locationId);
  }

  @Authorize('org_config', 'create')
  @Post('seats')
  addSeat(@Body(new ZodPipe(seatInputSchema)) body: SeatInput) {
    return this.hybrid.addSeat(body);
  }

  @Authorize('org_config', 'update')
  @Patch('seats/:id')
  @HttpCode(200)
  setSeat(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(seatActiveSchema)) body: z.infer<typeof seatActiveSchema>,
  ) {
    return this.hybrid.setSeatActive(id, body.active);
  }
}
