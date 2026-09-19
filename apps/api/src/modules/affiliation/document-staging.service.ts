import {
  BadRequestException,
  Inject,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { UploadedDocument } from '@voyyaa/shared';
import { EnvService } from '../../config/env.service';
import { detectDocumentContentType } from '../../shared/document-signature';
import { basename, stagingKey } from './document-key';
import { FILE_STORAGE, type FileStorageProvider } from './ports/file-storage.port';

export interface UploadedFilePayload {
  buffer: Buffer;
  size: number;
}

@Injectable()
export class DocumentStagingService {
  constructor(
    @Inject(FILE_STORAGE) private readonly storage: FileStorageProvider,
    private readonly env: EnvService,
  ) {}

  async stage(file: UploadedFilePayload): Promise<UploadedDocument> {
    if (!file || file.size === 0) {
      throw new BadRequestException({
        code: 'DOCUMENT_TYPE_NOT_ALLOWED',
        message: 'Adjunta un archivo',
      });
    }
    if (file.size > this.env.get('DOCUMENT_MAX_BYTES')) {
      throw new PayloadTooLargeException({
        code: 'DOCUMENT_TOO_LARGE',
        message: 'El archivo supera el tamaño máximo permitido (5 MB)',
      });
    }

    const detected = detectDocumentContentType(file.buffer);
    if (!detected) {
      throw new BadRequestException({
        code: 'DOCUMENT_TYPE_NOT_ALLOWED',
        message: 'Solo se aceptan PDF, JPEG o PNG',
      });
    }

    const key = stagingKey(detected);
    const stored = await this.storage.put({ key, body: file.buffer, contentType: detected });

    return {
      storage_key: stored.storageKey,
      file_name: basename(stored.storageKey),
      content_type: stored.contentType,
      size_bytes: stored.sizeBytes,
      uploaded_at: new Date().toISOString(),
    };
  }
}
