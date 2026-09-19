import { z } from 'zod';

export const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

export const DocumentContentType = z.enum(['application/pdf', 'image/jpeg', 'image/png']);
export type DocumentContentType = z.infer<typeof DocumentContentType>;

export const DOCUMENT_ALLOWED_CONTENT_TYPES = DocumentContentType.options;

export const DocumentStorageKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9/_.-]{7,199}$/, 'Referencia de archivo inválida');
export type DocumentStorageKey = z.infer<typeof DocumentStorageKey>;

export const DocumentVerificationStatus = z.enum(['pending', 'verified', 'rejected']);
export type DocumentVerificationStatus = z.infer<typeof DocumentVerificationStatus>;

export const UploadedDocument = z.object({
  storage_key: z.string(),
  file_name: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int().positive(),
  uploaded_at: z.string().datetime(),
});
export type UploadedDocument = z.infer<typeof UploadedDocument>;

export const NotificationDelivery = z.enum(['sent', 'failed']);
export type NotificationDelivery = z.infer<typeof NotificationDelivery>;
