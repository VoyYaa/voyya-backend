import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CancelTripRequestDTO,
  type ActiveTripResponse,
  type QuoteResponse,
  QuoteFareDTO,
  CreateTripRequestDTO,
  type TripRequestStatus,
  type TripRequestCancelled,
  type TripRequestCreated,
  TripServiceOptionsQuery,
  type TripServiceOptionsResponse,
} from '@voyyaa/shared';
import { PER_USER_LIMITS, PerUserLimit, UserThrottlerGuard } from '../../shared/user-throttler.guard';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUserId } from '../tenancy/identity.decorators';
import { TripServiceOptionsService } from './trip-service-options.service';
import { TripsService } from './trips.service';

@Controller('trips')
@Roles('passenger')
export class TripsController {
  constructor(
    private readonly trips: TripsService,
    private readonly serviceOptions: TripServiceOptionsService,
  ) {}

  @Get('service-options')
  @UseGuards(UserThrottlerGuard)
  getServiceOptions(
    @Query(new ZodValidationPipe(TripServiceOptionsQuery)) query: TripServiceOptionsQuery,
  ): Promise<TripServiceOptionsResponse> {
    return this.serviceOptions.getOptions(query);
  }

  @Post('quote')
  @HttpCode(200)
  quote(
    @Body(new ZodValidationPipe(QuoteFareDTO)) dto: QuoteFareDTO,
  ): Promise<QuoteResponse> {
    return this.trips.quote(dto);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateTripRequestDTO)) dto: CreateTripRequestDTO,
    @CurrentUserId() passengerId: number,
  ): Promise<TripRequestCreated> {
    return this.trips.create(dto, passengerId);
  }

  @Get('active')
  @PerUserLimit(PER_USER_LIMITS.tripStatus)
  @Header('Cache-Control', 'no-store')
  getActive(@CurrentUserId() passengerId: number): Promise<ActiveTripResponse> {
    return this.trips.getActive(passengerId);
  }

  @Get(':id')
  @PerUserLimit(PER_USER_LIMITS.tripStatus)
  @Header('Cache-Control', 'no-store')
  getStatus(
    @Param('id', ParseIntPipe) tripRequestId: number,
    @CurrentUserId() passengerId: number,
  ): Promise<TripRequestStatus> {
    return this.trips.getStatus(tripRequestId, passengerId);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', ParseIntPipe) tripRequestId: number,
    @Body(new ZodValidationPipe(CancelTripRequestDTO)) dto: CancelTripRequestDTO,
    @CurrentUserId() passengerId: number,
  ): Promise<TripRequestCancelled> {
    return this.trips.cancel(tripRequestId, passengerId, dto);
  }
}
