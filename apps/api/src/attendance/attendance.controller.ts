import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  attendanceMonthQuerySchema,
  biometricDeviceInputSchema,
  biometricPushSchema,
  checkInSchema,
  type BiometricPush,
  type CheckInInput,
} from '@ipro/shared';
import type { z } from 'zod';
import { Authorize, Public, SignedIn } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AttendanceService } from './attendance.service.js';

const uuid = new ParseUUIDPipe();

/** Check-in (E2), the day and month views (E1, E3), and biometric devices (A5; decision #67). */
@Controller()
export class AttendanceController {
  constructor(@Inject(AttendanceService) private readonly attendance: AttendanceService) {}

  @Authorize('attendance', 'create')
  @Post('attendance/check-in')
  checkIn(@Body(new ZodPipe(checkInSchema)) body: CheckInInput) {
    return this.attendance.punch('in', body);
  }

  @Authorize('attendance', 'create')
  @Post('attendance/check-out')
  checkOut(@Body(new ZodPipe(checkInSchema)) body: CheckInInput) {
    return this.attendance.punch('out', body);
  }

  @SignedIn()
  @Get('attendance/today')
  today() {
    return this.attendance.today();
  }

  @Authorize('attendance', 'read')
  @Get('people/:id/attendance')
  month(
    @Param('id', uuid) id: string,
    @Query(new ZodPipe(attendanceMonthQuerySchema))
    query: z.infer<typeof attendanceMonthQuerySchema>,
  ) {
    return this.attendance.month(id, query.month);
  }

  /**
   * Biometric devices push punches here (decision #67), with their key in `X-Device-Key`. No session:
   * the key is the device's identity, and only its hash is stored.
   */
  @Public()
  @Post('biometric/punches')
  @HttpCode(200)
  push(
    @Headers('x-device-key') key: string | undefined,
    @Body(new ZodPipe(biometricPushSchema)) body: BiometricPush,
  ) {
    return this.attendance.push(key, body);
  }

  @Authorize('org_config', 'read')
  @Get('biometric/devices')
  devices() {
    return this.attendance.devices();
  }

  @Authorize('org_config', 'create')
  @Post('biometric/devices')
  addDevice(
    @Body(new ZodPipe(biometricDeviceInputSchema)) body: z.infer<typeof biometricDeviceInputSchema>,
  ) {
    return this.attendance.addDevice(body);
  }

  @Authorize('org_config', 'update')
  @Delete('biometric/devices/:id')
  @HttpCode(204)
  async revokeDevice(@Param('id', uuid) id: string) {
    await this.attendance.revokeDevice(id);
  }
}
