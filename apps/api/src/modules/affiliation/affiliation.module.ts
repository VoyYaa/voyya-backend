import { Module } from '@nestjs/common';
import { EnvService } from '../../config/env.service';
import { BcryptHasher, HASHER } from '../auth/hasher.service';
import { AffiliationLinkService } from './affiliation-link.service';
import { AffiliationStagingPurgeService } from './affiliation-staging-purge.service';
import { AffiliationController } from './affiliation.controller';
import { AffiliationRepository } from './affiliation.repository';
import { AffiliationService } from './affiliation.service';
import { DocumentStagingService } from './document-staging.service';
import { EMAIL_PROVIDER } from './ports/email-provider.port';
import { FILE_STORAGE } from './ports/file-storage.port';
import { PlatformCompanyController } from './platform-company.controller';
import { PlatformCompanyRepository } from './platform-company.repository';
import { PlatformCompanyService } from './platform-company.service';
import { createEmailProvider } from './providers/email.factory';
import { createFileStorageProvider } from './providers/file-storage.factory';

@Module({
  controllers: [AffiliationController, PlatformCompanyController],
  providers: [
    AffiliationRepository,
    AffiliationService,
    AffiliationLinkService,
    DocumentStagingService,
    AffiliationStagingPurgeService,
    PlatformCompanyRepository,
    PlatformCompanyService,
    { provide: FILE_STORAGE, useFactory: createFileStorageProvider, inject: [EnvService] },
    { provide: EMAIL_PROVIDER, useFactory: createEmailProvider, inject: [EnvService] },
    { provide: HASHER, useClass: BcryptHasher },
  ],
  exports: [FILE_STORAGE, DocumentStagingService],
})
export class AffiliationModule {}
