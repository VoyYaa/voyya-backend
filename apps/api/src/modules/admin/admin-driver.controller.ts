import { Body, Controller, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  type CreatedDriver,
  CreateDriverDTO,
  type ResendDriverPinResponse,
  SuspendDriverDTO,
  type SuspendDriverResponse,
} from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentTenant } from '../tenancy/identity.decorators';
import { TenantGuard } from '../tenancy/tenant.guard';
import { AdminDriverService } from './admin-driver.service';

@Controller('admin/drivers')
@Roles('admin')
@UseGuards(TenantGuard)
export class AdminDriverController {
  constructor(private readonly service: AdminDriverService) {}

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(CreateDriverDTO)) dto: CreateDriverDTO,
    @CurrentTenant() companyId: number,
  ): Promise<CreatedDriver> {
    return this.service.create(companyId, dto);
  }

  @Post(':driverId/pin/resend')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  resendPin(
    @Param('driverId', ParseIntPipe) driverId: number,
    @CurrentTenant() companyId: number,
  ): Promise<ResendDriverPinResponse> {
    return this.service.resendPin(companyId, driverId);
  }

  @Post(':driverId/suspend')
  @HttpCode(200)
  suspend(
    @Param('driverId', ParseIntPipe) driverId: number,
    @Body(new ZodValidationPipe(SuspendDriverDTO)) dto: SuspendDriverDTO,
    @CurrentTenant() companyId: number,
  ): Promise<SuspendDriverResponse> {
    return this.service.suspend(companyId, driverId, dto.reason);
  }
}
