import { z } from 'zod';

export const ConsentPurpose = z.enum(['location']);
export type ConsentPurpose = z.infer<typeof ConsentPurpose>;

export const NoticeVersion = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{3,40}$/, 'Versión de aviso inválida');
export type NoticeVersion = z.infer<typeof NoticeVersion>;

export const LOCATION_NOTICE_VERSION = 'location-notice-v1';

export const GrantConsentDTO = z.object({
  purpose: ConsentPurpose,
  notice_version: NoticeVersion,
});
export type GrantConsentDTO = z.infer<typeof GrantConsentDTO>;

export const ConsentRecord = z.object({
  purpose: ConsentPurpose,
  notice_version: NoticeVersion,
  granted_at: z.string().datetime(),
});
export type ConsentRecord = z.infer<typeof ConsentRecord>;

export const ConsentListResponse = z.array(ConsentRecord);
export type ConsentListResponse = z.infer<typeof ConsentListResponse>;
