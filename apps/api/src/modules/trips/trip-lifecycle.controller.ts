import { Body, Controller, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { CompleteTripDTO, type TripTransitionResult } from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentTenant, CurrentUserId } from '../tenancy/identity.decorators';
import { TenantGuard } from '../tenancy/tenant.guard';
import { TripLifecycleService } from './trip-lifecycle.service';

@Controller('trips')
@Roles('driver')
@UseGuards(TenantGuard)
export class TripLifecycleController {
  constructor(private readonly lifecycle: TripLifecycleService) {}

  @Post(':id/en-route')
  @HttpCode(200)
  markEnRoute(
    @Param('id', ParseIntPipe) tripRequestId: number,
    @CurrentUserId() driverId: number,
    @CurrentTenant() companyId: number,
  ): Promise<TripTransitionResult> {
    return this.lifecycle.markEnRoute(tripRequestId, driverId, companyId);
  }

  @Post(':id/arrived')
  @HttpCode(200)
  markArrived(
    @Param('id', ParseIntPipe) tripRequestId: number,
    @CurrentUserId() driverId: number,
    @CurrentTenant() companyId: number,
  ): Promise<TripTransitionResult> {
    return this.lifecycle.markArrived(tripRequestId, driverId, companyId);
  }

  @Post(':id/start')
  @HttpCode(200)
  markStarted(
    @Param('id', ParseIntPipe) tripRequestId: number,
    @CurrentUserId() driverId: number,
    @CurrentTenant() companyId: number,
  ): Promise<TripTransitionResult> {
    return this.lifecycle.markStarted(tripRequestId, driverId, companyId);
  }

  @Post(':id/complete')
  @HttpCode(200)
  complete(
    @Param('id', ParseIntPipe) tripRequestId: number,
    @Body(new ZodValidationPipe(CompleteTripDTO)) dto: CompleteTripDTO,
    @CurrentUserId() driverId: number,
    @CurrentTenant() companyId: number,
  ): Promise<TripTransitionResult> {
    return this.lifecycle.complete(tripRequestId, driverId, companyId, dto);
  }

  @Post(':id/no-show')
  @HttpCode(200)
  declareNoShow(
    @Param('id', ParseIntPipe) tripRequestId: number,
    @CurrentUserId() driverId: number,
    @CurrentTenant() companyId: number,
  ): Promise<TripTransitionResult> {
    return this.lifecycle.declareNoShow(tripRequestId, driverId, companyId);
  }

  @Post(':id/cash-collected')
  @HttpCode(200)
  confirmCashCollected(
    @Param('id', ParseIntPipe) tripRequestId: number,
    @CurrentUserId() driverId: number,
    @CurrentTenant() companyId: number,
  ): Promise<TripTransitionResult> {
    return this.lifecycle.confirmCashCollected(tripRequestId, driverId, companyId);
  }
}
