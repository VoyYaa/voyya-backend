import { Module } from '@nestjs/common';
import { EnvService } from '../../config/env.service';
import { AffiliationModule } from '../affiliation/affiliation.module';
import { AssignmentModule } from '../assignment/assignment.module';
import { SMS_PROVIDER } from '../assignment/ports/sms-provider.port';
import { createSmsProvider } from '../assignment/providers/sms.factory';
import { BcryptHasher, HASHER } from '../auth/hasher.service';
import { AdminCompanyProfileController } from './admin-company-profile.controller';
import { AdminCompanyProfileService } from './admin-company-profile.service';
import { AdminDriverController } from './admin-driver.controller';
import { AdminDriverRepository } from './admin-driver.repository';
import { AdminDriverService } from './admin-driver.service';
import { AdminFleetQuotaController } from './admin-fleet-quota.controller';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminSettingsRepository } from './admin-settings.repository';
import { AdminSettingsService } from './admin-settings.service';
import { CompanyMunicipalityResolver } from './company-municipality.resolver';
import { OpsConsoleController } from './ops-console.controller';
import { OpsConsoleRepository } from './ops-console.repository';
import { OpsConsoleService } from './ops-console.service';

@Module({
  imports: [AssignmentModule, AffiliationModule],
  controllers: [
    AdminCompanyProfileController,
    AdminDriverController,
    AdminFleetQuotaController,
    AdminSettingsController,
    OpsConsoleController,
  ],
  providers: [
    AdminCompanyProfileService,
    AdminDriverService,
    AdminDriverRepository,
    AdminSettingsService,
    AdminSettingsRepository,
    OpsConsoleService,
    OpsConsoleRepository,
    CompanyMunicipalityResolver,
    { provide: HASHER, useClass: BcryptHasher },
    { provide: SMS_PROVIDER, useFactory: createSmsProvider, inject: [EnvService] },
  ],
})
export class AdminModule {}
