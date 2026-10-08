import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { DOCUMENT_MAX_BYTES } from '@voyyaa/shared';

type DocumentUploadLimits = NonNullable<MulterOptions['limits']> & {
  fieldArrayIndexLimit: number;
  fieldNestingDepth: number;
};

const documentUploadLimits: DocumentUploadLimits = {
  fileSize: DOCUMENT_MAX_BYTES,
  files: 1,
  fields: 0,
  parts: 1,
  fieldArrayIndexLimit: 0,
  fieldNestingDepth: 0,
};

export const documentUploadOptions: MulterOptions = { limits: documentUploadLimits };
