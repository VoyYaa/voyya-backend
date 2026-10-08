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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  type AffiliationApplicationCreated,
  type AffiliationDocument,
  type AffiliationMunicipalityListResponse,
  CreateAffiliationApplicationDTO,
  ReplaceAffiliationDocumentDTO,
  type UploadedDocument,
} from '@voyyaa/shared';
import { Public } from '../auth/decorators/public.decorator';
import { OptInThrottle } from '../../shared/opt-in-throttle';
import { AFFILIATION_DOCS_HOURLY, AFFILIATION_DOCS_HOURLY_LIMIT } from '../../shared/throttlers';
import { documentUploadOptions } from '../../shared/document-upload-options';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { AffiliationService } from './affiliation.service';
import { DocumentStagingService } from './document-staging.service';

@Controller('affiliation')
@Public()
export class AffiliationController {
  constructor(
    private readonly service: AffiliationService,
    private readonly staging: DocumentStagingService,
  ) {}

  @Get('municipalities')
  @Header('Cache-Control', 'public, max-age=300')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  listMunicipalities(): Promise<AffiliationMunicipalityListResponse> {
    return this.service.listMunicipalities();
  }

  @Post('documents')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', documentUploadOptions))
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @OptInThrottle(AFFILIATION_DOCS_HOURLY, AFFILIATION_DOCS_HOURLY_LIMIT)
  uploadDocument(
    @UploadedFile() file: { buffer: Buffer; size: number },
  ): Promise<UploadedDocument> {
    return this.staging.stage(file);
  }

  @Post('applications')
  @HttpCode(201)
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  submitApplication(
    @Body(new ZodValidationPipe(CreateAffiliationApplicationDTO))
    dto: CreateAffiliationApplicationDTO,
  ): Promise<AffiliationApplicationCreated> {
    return this.service.submitApplication(dto);
  }

  @Post('applications/:companyId/documents')
  @HttpCode(200)
  replaceDocument(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Query('token') token: string,
    @Body(new ZodValidationPipe(ReplaceAffiliationDocumentDTO)) dto: ReplaceAffiliationDocumentDTO,
  ): Promise<AffiliationDocument> {
    return this.service.replaceDocument(token ?? '', companyId, dto);
  }
}
