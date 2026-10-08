import { Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ChangeDriverPinDTO, type SessionResponse } from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { CurrentTenant, CurrentUserId } from '../tenancy/identity.decorators';
import { TenantGuard } from '../tenancy/tenant.guard';
import { AllowPendingPinChange } from './decorators/allow-pending-pin-change.decorator';
import { Roles } from './decorators/roles.decorator';
import { DriverPinService } from './driver-pin.service';

const CHANGE_PIN_LIMIT = { limit: 5, ttl: 60_000 } as const;

@Controller('auth/driver')
@Roles('driver')
@UseGuards(TenantGuard)
export class DriverCredentialsController {
  constructor(private readonly driverPin: DriverPinService) {}

  @Post('pin')
  @HttpCode(200)
  @AllowPendingPinChange()
  @Throttle({ default: CHANGE_PIN_LIMIT })
  changePin(
    @Body(new ZodValidationPipe(ChangeDriverPinDTO)) dto: ChangeDriverPinDTO,
    @CurrentUserId() driverId: number,
    @CurrentTenant() companyId: number,
    @Headers('user-agent') userAgent?: string,
  ): Promise<SessionResponse> {
    return this.driverPin.changePin(driverId, companyId, dto, userAgent);
  }
}
