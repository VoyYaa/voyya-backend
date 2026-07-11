import { z } from 'zod';

export const Role = z.enum(['passenger', 'driver', 'company', 'admin', 'operator']);
export type Role = z.infer<typeof Role>;

export const TENANT_SCOPED_ROLES = ['driver', 'company'] as const;

export const Phone = z
  .string()
  .trim()
  .regex(/^(?:\+?57)?3\d{9}$/, 'Teléfono colombiano inválido (celular de 10 dígitos)');
export type Phone = z.infer<typeof Phone>;

export const NationalId = z.string().trim().regex(/^\d{5,15}$/, 'Cédula inválida');

export const Pin = z.string().regex(/^\d{4,6}$/, 'PIN inválido (4 a 6 dígitos)');

export const OtpCode = z.string().regex(/^\d{4,8}$/, 'Código OTP inválido');

export const JwtAccessPayload = z.object({
  sub: z.number().int().positive(),
  role: Role,
  company_id: z.number().int().positive().optional(),
  type: z.literal('access'),
  iat: z.number().int().optional(),
  exp: z.number().int().optional(),
});
export type JwtAccessPayload = z.infer<typeof JwtAccessPayload>;

export const SessionTokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
});
export type SessionTokens = z.infer<typeof SessionTokens>;

export const SessionUser = z.object({
  user_id: z.number().int().positive(),
  first_name: z.string(),
  last_name: z.string(),
  role: Role,
  company_id: z.number().int().positive().nullable(),
  profile_complete: z.boolean(),
});
export type SessionUser = z.infer<typeof SessionUser>;

export const SessionResponse = z.object({
  tokens: SessionTokens,
  user: SessionUser,
});
export type SessionResponse = z.infer<typeof SessionResponse>;

export const RequestOtpDTO = z.object({
  phone: Phone,
});
export type RequestOtpDTO = z.infer<typeof RequestOtpDTO>;

export const RequestOtpResponse = z.object({
  sent: z.literal(true),
  resend_in_sec: z.number().int().positive(),
  expires_in_sec: z.number().int().positive(),
});
export type RequestOtpResponse = z.infer<typeof RequestOtpResponse>;

export const VerifyOtpDTO = z.object({
  phone: Phone,
  code: OtpCode,
});
export type VerifyOtpDTO = z.infer<typeof VerifyOtpDTO>;

export const DriverLoginDTO = z.object({
  national_id: NationalId,
  pin: Pin,
});
export type DriverLoginDTO = z.infer<typeof DriverLoginDTO>;

export const AdminLoginDTO = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
});
export type AdminLoginDTO = z.infer<typeof AdminLoginDTO>;

export const RefreshDTO = z.object({
  refresh_token: z.string().min(1),
});
export type RefreshDTO = z.infer<typeof RefreshDTO>;

export const RefreshResponse = SessionTokens;
export type RefreshResponse = SessionTokens;

export const LogoutDTO = z.object({
  refresh_token: z.string().min(1),
});
export type LogoutDTO = z.infer<typeof LogoutDTO>;

export const LogoutResponse = z.object({ ok: z.literal(true) });
export type LogoutResponse = z.infer<typeof LogoutResponse>;

export const AuthErrorCode = z.enum([
  'OTP_INVALID',
  'OTP_EXPIRED',
  'OTP_MAX_ATTEMPTS',
  'OTP_RATE_LIMIT',
  'INVALID_CREDENTIALS',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_TEMPORARILY_BLOCKED',
  'REFRESH_INVALID',
  'REFRESH_EXPIRED',
  'REFRESH_REVOKED',
  'SESSION_REQUIRED',
  'FORBIDDEN',
]);
export type AuthErrorCode = z.infer<typeof AuthErrorCode>;

export const AuthError = z.object({
  code: AuthErrorCode,
  message: z.string(),
  retry_in_sec: z.number().int().positive().optional(),
});
export type AuthError = z.infer<typeof AuthError>;

export const AUTH_EVENTS = {
  SESSION_STARTED: 'auth.session_started',
  SESSION_ENDED: 'auth.session_ended',
} as const;
export type AuthEventName = (typeof AUTH_EVENTS)[keyof typeof AUTH_EVENTS];

export const SessionStartedEvent = z.object({
  user_id: z.number().int().positive(),
  role: Role,
  occurred_at: z.string().datetime(),
});
export type SessionStartedEvent = z.infer<typeof SessionStartedEvent>;

export const DRIVER_SUSPENDED_EVENT = 'fleet.driver_suspended';

export const DriverSuspendedEvent = z.object({
  driver_id: z.number().int().positive(),
  company_id: z.number().int().positive(),
  reason: z.enum(['suspended', 'documents_blocked', 'inactive']),
  occurred_at: z.string().datetime(),
});
export type DriverSuspendedEvent = z.infer<typeof DriverSuspendedEvent>;
