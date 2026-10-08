import { Body, Controller, Get, Param, ParseIntPipe, Put, Query } from '@nestjs/common';
import {
  ActivatableServiceType,
  ConfigHistoryQuery,
  UpdateMunicipalityOperationalParamsDTO,
  type MunicipalityOperationalParams,
  type MunicipalityOperationalParamsHistory,
} from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUserId } from '../tenancy/identity.decorators';
import { PlatformOperationalParamsService } from './platform-operational-params.service';
import { ServiceConfigBodyPipe } from './service-config-body.pipe';

@Controller('platform/municipalities/:municipalityId/services/:serviceType/operational-params')
@Roles('platform_admin')
export class PlatformOperationalParamsController {
  constructor(private readonly service: PlatformOperationalParamsService) {}

  @Get()
  history(
    @Param('municipalityId', ParseIntPipe) municipalityId: number,
    @Param('serviceType', new ZodValidationPipe(ActivatableServiceType)) serviceType: ActivatableServiceType,
    @Query(new ZodValidationPipe(ConfigHistoryQuery)) query: ConfigHistoryQuery,
  ): Promise<MunicipalityOperationalParamsHistory> {
    return this.service.history(municipalityId, serviceType, query);
  }

  @Put()
  update(
    @Param('municipalityId', ParseIntPipe) municipalityId: number,
    @Param('serviceType', new ZodValidationPipe(ActivatableServiceType)) serviceType: ActivatableServiceType,
    @Body(new ServiceConfigBodyPipe(UpdateMunicipalityOperationalParamsDTO))
    dto: UpdateMunicipalityOperationalParamsDTO,
    @CurrentUserId() userId: number,
  ): Promise<MunicipalityOperationalParams> {
    return this.service.update(municipalityId, serviceType, dto, userId);
  }
}
