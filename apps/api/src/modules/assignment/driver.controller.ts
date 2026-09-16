import { Body, Controller, Get, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import {
  type DriverHomeState,
  type DriverShiftState,
  type PendingCashTripsResponse,
  ReportDriverLocationDTO,
  UpdateDriverShiftDTO,
} from '@voyyaa/shared';
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
  @HttpCode(200)
  async reportLocation(
    @Body(new ZodValidationPipe(ReportDriverLocationDTO)) dto: ReportDriverLocationDTO,
    @CurrentUserId() driverId: number,
    @CurrentTenant() companyId: number,
  ): Promise<{ ok: true }> {
    await this.driverShift.reportLocation(driverId, companyId, dto);
    return { ok: true };
  }

  @Get('me')
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
