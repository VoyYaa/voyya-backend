import { Module } from '@nestjs/common';
import { EnvService } from '../../config/env.service';
import { AssignmentModule } from '../assignment/assignment.module';
import { SMS_PROVIDER } from '../assignment/ports/sms-provider.port';
import { createSmsProvider } from '../assignment/providers/sms.factory';
import { BcryptHasher, HASHER } from '../auth/hasher.service';
import { AdminDriverController } from './admin-driver.controller';
import { AdminDriverRepository } from './admin-driver.repository';
import { AdminDriverService } from './admin-driver.service';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminSettingsRepository } from './admin-settings.repository';
import { AdminSettingsService } from './admin-settings.service';
import { CompanyMunicipalityResolver } from './company-municipality.resolver';
import { OpsConsoleController } from './ops-console.controller';
import { OpsConsoleRepository } from './ops-console.repository';
import { OpsConsoleService } from './ops-console.service';

@Module({
  imports: [AssignmentModule],
  controllers: [AdminDriverController, AdminSettingsController, OpsConsoleController],
  providers: [
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
