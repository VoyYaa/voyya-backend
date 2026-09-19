import {
  Body,
  Controller,
  Get,
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
  DOCUMENT_MAX_BYTES,
  type AffiliationApplicationCreated,
  type AffiliationDocument,
  type AffiliationMunicipalityListResponse,
  CreateAffiliationApplicationDTO,
  ReplaceAffiliationDocumentDTO,
  type UploadedDocument,
} from '@voyyaa/shared';
import { Public } from '../auth/decorators/public.decorator';
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
  listMunicipalities(): Promise<AffiliationMunicipalityListResponse> {
    return this.service.listMunicipalities();
  }

  @Post('documents')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: DOCUMENT_MAX_BYTES, files: 1 } }))
  @Throttle({ default: { limit: 5, ttl: 60_000 }, affiliation_docs_hour: { limit: 30, ttl: 3_600_000 } })
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
