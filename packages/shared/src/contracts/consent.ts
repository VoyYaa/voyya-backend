import { z } from 'zod';
import { Role } from './auth';

export const ConsentPurpose = z.enum(['location']);
export type ConsentPurpose = z.infer<typeof ConsentPurpose>;

export const NoticeVersion = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{3,40}$/, 'Versión de aviso inválida');
export type NoticeVersion = z.infer<typeof NoticeVersion>;

export const LOCATION_NOTICE_VERSION = 'location-notice-v2';

export const NoticeAudience = z.enum(['driver', 'passenger']);
export type NoticeAudience = z.infer<typeof NoticeAudience>;

export const GrantConsentDTO = z.object({
  purpose: ConsentPurpose,
  notice_version: NoticeVersion,
});
export type GrantConsentDTO = z.infer<typeof GrantConsentDTO>;

export const RevokeConsentDTO = z.object({
  purpose: ConsentPurpose,
});
export type RevokeConsentDTO = z.infer<typeof RevokeConsentDTO>;

export const ConsentState = z.enum(['granted', 'revoked', 'none']);
export type ConsentState = z.infer<typeof ConsentState>;

export const ConsentStatus = z.object({
  purpose: ConsentPurpose,
  state: ConsentState,
  notice_version: NoticeVersion.nullable(),
  granted_at: z.string().datetime().nullable(),
  revoked_at: z.string().datetime().nullable(),
  current_notice_version: NoticeVersion,
  requires_acceptance: z.boolean(),
});
export type ConsentStatus = z.infer<typeof ConsentStatus>;

export const ConsentStatusListResponse = z.array(ConsentStatus);
export type ConsentStatusListResponse = z.infer<typeof ConsentStatusListResponse>;

export const ConsentErrorCode = z.enum(['NOTICE_VERSION_UNKNOWN', 'NOTICE_AUDIENCE_NOT_ALLOWED']);
export type ConsentErrorCode = z.infer<typeof ConsentErrorCode>;

export const ConsentError = z.object({
  code: ConsentErrorCode,
  message: z.string(),
});
export type ConsentError = z.infer<typeof ConsentError>;

export const CONSENT_EVENTS = {
  CONSENT_REVOKED: 'auth.consent_revoked',
} as const;
export type ConsentEventName = (typeof CONSENT_EVENTS)[keyof typeof CONSENT_EVENTS];

export const ConsentRevokedEvent = z.object({
  user_id: z.number().int().positive(),
  role: Role,
  company_id: z.number().int().positive().nullable(),
  purpose: ConsentPurpose,
  occurred_at: z.string().datetime(),
});
export type ConsentRevokedEvent = z.infer<typeof ConsentRevokedEvent>;
