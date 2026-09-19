import {
  Controller,
  Get,
  Header,
  Inject,
  Logger,
  NotFoundException,
  Param,
  StreamableFile,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';
import { downloadContentType, downloadFilename } from './document-key';
import { FILE_STORAGE, type FileStorageProvider } from './ports/file-storage.port';
import { DocumentDownloadTokenService } from './document-download-token.service';
import { PlatformCompanyRepository } from './platform-company.repository';

@Controller('documents')
@Public()
export class DocumentDownloadController {
  private readonly logger = new Logger(DocumentDownloadController.name);

  constructor(
    private readonly tokens: DocumentDownloadTokenService,
    private readonly prisma: PrismaService,
    private readonly repo: PlatformCompanyRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStorageProvider,
  ) {}

  @Get(':token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @Header('Referrer-Policy', 'no-referrer')
  @Header('Cache-Control', 'private, no-store')
  async download(@Param('token') token: string): Promise<StreamableFile> {
    const verification = this.tokens.verify(token);
    if (!verification.ok) {
      throw this.notFound();
    }

    const { companyId, companyDocumentId, mintedBy } = verification.payload;
    const document = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.findDocumentForDownload(tx, companyId, companyDocumentId),
    );
    if (!document) {
      throw this.notFound();
    }

    const stream = await this.storage.read(document.storageKey);
    if (!stream) {
      throw this.notFound();
    }

    this.logger.log(
      `document_download company_document_id=${companyDocumentId} company_id=${companyId} minted_by=${mintedBy}`,
    );

    return new StreamableFile(stream, {
      type: downloadContentType(document.contentType),
      disposition: `attachment; filename="${downloadFilename(document.type, companyId, document.contentType)}"`,
    });
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      code: 'DOCUMENT_NOT_FOUND',
      message: 'El documento no está disponible',
    });
  }
}
