import { Body, Controller, Get, Header, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import {
  type DriverHomeState,
  type DriverShiftState,
  type PendingCashTripsResponse,
  ReportDriverLocationDTO,
  type ReportDriverLocationResult,
  UpdateDriverShiftDTO,
} from '@voyyaa/shared';
import { PER_USER_LIMITS, PerUserLimit } from '../../shared/user-throttler.guard';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentTenant, CurrentUserId } from '../tenancy/identity.decorators';
import { TenantGuard } from '../tenancy/tenant.guard';
import { DriverShiftService } from './driver-shift.service';

@Controller('driver')
@Roles('driver')
@UseGuards(TenantGuard)
export class DriverController {
  constructor(private readonly driverShift: DriverShiftService) {}

  @Put('shift')
  updateShift(
    @Body(new ZodValidationPipe(UpdateDriverShiftDTO)) dto: UpdateDriverShiftDTO,
    @CurrentUserId() driverId: number,
    @CurrentTenant() companyId: number,
  ): Promise<DriverShiftState> {
    return this.driverShift.updateShift(driverId, companyId, dto);
  }

  @Post('location')
  @PerUserLimit(PER_USER_LIMITS.driverLocation)
  @HttpCode(200)
  reportLocation(
    @Body(new ZodValidationPipe(ReportDriverLocationDTO)) dto: ReportDriverLocationDTO,
    @CurrentUserId() driverId: number,
    @CurrentTenant() companyId: number,
  ): Promise<ReportDriverLocationResult> {
    return this.driverShift.reportLocation(driverId, companyId, dto);
  }

  @Get('me')
  @PerUserLimit(PER_USER_LIMITS.driverHome)
  @Header('Cache-Control', 'no-store')
  getHome(
    @CurrentUserId() driverId: number,
    @CurrentTenant() companyId: number,
  ): Promise<DriverHomeState> {
    return this.driverShift.getHome(driverId, companyId);
  }

  @Get('trips/cash-pending')
  listPendingCashTrips(
    @CurrentUserId() driverId: number,
    @CurrentTenant() companyId: number,
  ): Promise<PendingCashTripsResponse> {
    return this.driverShift.listPendingCashTrips(driverId, companyId);
  }
}
