import { Body, Controller, Get, Param, ParseIntPipe, Put, Query } from '@nestjs/common';
import {
  ActivatableServiceType,
  ConfigHistoryQuery,
  UpdateMunicipalityFareDTO,
  type MunicipalityFare,
  type MunicipalityFareHistory,
} from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUserId } from '../tenancy/identity.decorators';
import { PlatformFareService } from './platform-fare.service';
import { ServiceConfigBodyPipe } from './service-config-body.pipe';

@Controller('platform/municipalities/:municipalityId/services/:serviceType/fare')
@Roles('platform_admin')
export class PlatformFareController {
  constructor(private readonly service: PlatformFareService) {}

  @Get()
  history(
    @Param('municipalityId', ParseIntPipe) municipalityId: number,
    @Param('serviceType', new ZodValidationPipe(ActivatableServiceType)) serviceType: ActivatableServiceType,
    @Query(new ZodValidationPipe(ConfigHistoryQuery)) query: ConfigHistoryQuery,
  ): Promise<MunicipalityFareHistory> {
    return this.service.history(municipalityId, serviceType, query);
  }

  @Put()
  update(
    @Param('municipalityId', ParseIntPipe) municipalityId: number,
    @Param('serviceType', new ZodValidationPipe(ActivatableServiceType)) serviceType: ActivatableServiceType,
    @Body(new ServiceConfigBodyPipe(UpdateMunicipalityFareDTO)) dto: UpdateMunicipalityFareDTO,
    @CurrentUserId() userId: number,
  ): Promise<MunicipalityFare> {
    return this.service.update(municipalityId, serviceType, dto, userId);
  }
}
