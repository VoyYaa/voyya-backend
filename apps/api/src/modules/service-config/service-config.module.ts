import { Global, Module } from '@nestjs/common';
import { CompanyCommissionReader } from './company-commission.reader';
import { CompanyCommissionRepository } from './company-commission.repository';
import { MunicipalityFareReader } from './municipality-fare.reader';
import { MunicipalityFareRepository } from './municipality-fare.repository';
import { OperationalParamsRepository } from './operational-params.repository';
import { OperationalParamsService } from './operational-params.service';
import { PlatformCommissionController } from './platform-commission.controller';
import { PlatformCommissionService } from './platform-commission.service';
import { PlatformConfigQueryRepository } from './platform-config-query.repository';
import { PlatformFareController } from './platform-fare.controller';
import { PlatformFareService } from './platform-fare.service';
import { PlatformOperationalParamsController } from './platform-operational-params.controller';
import { PlatformOperationalParamsService } from './platform-operational-params.service';
import { PlatformServiceConfigController } from './platform-service-config.controller';
import { PlatformServiceConfigService } from './platform-service-config.service';
import { ServiceCatalog } from './service-catalog';
import { ServiceConfigProvisioner } from './service-config-provisioner';

@Global()
@Module({
  controllers: [
    PlatformServiceConfigController,
    PlatformFareController,
    PlatformOperationalParamsController,
    PlatformCommissionController,
  ],
  providers: [
    MunicipalityFareRepository,
    OperationalParamsRepository,
    CompanyCommissionRepository,
    PlatformConfigQueryRepository,
    MunicipalityFareReader,
    OperationalParamsService,
    CompanyCommissionReader,
    ServiceCatalog,
    ServiceConfigProvisioner,
    PlatformServiceConfigService,
    PlatformFareService,
    PlatformOperationalParamsService,
    PlatformCommissionService,
  ],
  exports: [
    MunicipalityFareReader,
    OperationalParamsService,
    CompanyCommissionReader,
    ServiceCatalog,
    ServiceConfigProvisioner,
  ],
})
export class ServiceConfigModule {}
