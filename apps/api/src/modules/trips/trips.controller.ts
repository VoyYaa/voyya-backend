import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import {
  CancelTripRequestDTO,
  type QuoteResponse,
  QuoteFareDTO,
  CreateTripRequestDTO,
  type TripRequestStatus,
  type TripRequestCancelled,
  type TripRequestCreated,
} from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUserId } from '../tenancy/identity.decorators';
import { TripsService } from './trips.service';

@Controller('trips')
@Roles('passenger')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

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

  @Get(':id')
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
