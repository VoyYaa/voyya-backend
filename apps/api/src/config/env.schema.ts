import {
  ActiveServiceTypes,
  DRIVER_LOCATION_RETENTION_MAX_HOURS,
  TRIP_COORDINATES_RETENTION_DAYS,
} from '@voyyaa/shared';
import { z } from 'zod';
import { isHttpsOrigin, parseCorsOrigins } from './cors-origins';
import { OTP_DAILY_WINDOW_SECONDS } from './otp-limits';

const ActiveServiceTypesFromEnv = z
  .string()
  .default('taxi')
  .transform((raw, ctx) => {
    const parsed = ActiveServiceTypes.safeParse(raw.split(',').map((value) => value.trim()));
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'ACTIVE_SERVICE_TYPES debe ser una lista separada por comas de taxi, comfort o delivery (motorcycle está prohibido)',
      });
      return z.NEVER;
    }
    return [...new Set(parsed.data)];
  });

const PUSH_TOKEN_TTL_DAYS_MAX = 60;

const OTP_PRODUCTION_BOUNDS = [
  { key: 'OTP_MAX_ATTEMPTS', max: 5, reason: 'más intentos por código multiplican la probabilidad de adivinarlo' },
  { key: 'OTP_PHONE_DAILY_LIMIT', max: 20, reason: 'más códigos por día y por teléfono multiplican la probabilidad de adivinarlo' },
  { key: 'OTP_TTL_SECONDS', max: 600, reason: 'un código que vive más tiempo da más margen para adivinarlo' },
] as const;

const BaseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().min(1).optional(),
  SENTRY_RELEASE: z.string().min(1).optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),
  DB_CONNECT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
  DB_CONNECT_RETRY_BASE_MS: z.coerce.number().int().positive().default(500),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener ≥32 caracteres aleatorios (HS256)'),
  QUOTE_TOKEN_SECRET: z
    .string()
    .min(32, 'QUOTE_TOKEN_SECRET debe tener ≥32 caracteres aleatorios'),
  QUOTE_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(120),

  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  OTP_TTL_SECONDS: z.coerce.number().int().positive().max(OTP_DAILY_WINDOW_SECONDS).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().max(OTP_DAILY_WINDOW_SECONDS).default(30),
  OTP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  OTP_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().max(OTP_DAILY_WINDOW_SECONDS).default(3600),
  OTP_PHONE_DAILY_LIMIT: z.coerce.number().int().positive().default(10),
  OTP_GLOBAL_DAILY_LIMIT: z.coerce.number().int().positive().default(300),

  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_BLOCK_MINUTES: z.coerce.number().int().positive().default(15),
  DRIVER_TEMPORARY_PIN_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(72),

  AUTH_DEV_HEADERS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  SMS_PROVIDER: z.enum(['twilio', 'noop', 'console']).default('noop'),
  EMAIL_PROVIDER: z.enum(['sendgrid', 'noop']).default('noop'),
  PUSH_PROVIDER: z.enum(['expo', 'noop']).default('noop'),

  TWILIO_ACCOUNT_SID: z
    .string()
    .regex(/^AC[a-zA-Z0-9]+$/, 'TWILIO_ACCOUNT_SID inválido (debe empezar con "AC")')
    .optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_FROM_NUMBER: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, 'TWILIO_FROM_NUMBER debe ser E.164 (p.ej. +573001112233)')
    .optional(),

  CORS_ORIGINS: z.string().default(''),
  THROTTLE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(100),

  DEFAULT_MUNICIPALITY_ID: z.coerce.number().int().positive().default(1),
  ACTIVE_SERVICE_TYPES: ActiveServiceTypesFromEnv,

  SEARCH_RADIUS_KM: z.coerce.number().positive().default(2),
  EXPANSION_RADIUS_KM: z.coerce.number().positive().default(6),
  ACCEPTANCE_TIMEOUT_SEC: z.coerce.number().int().positive().default(15),
  MAX_AUTO_RETRIES: z.coerce.number().int().positive().default(3),
  TIEBREAK_WINDOW_HOURS: z.coerce.number().positive().default(3),
  CANCELLATION_WINDOW_MIN: z.coerce.number().positive().default(2),
  AVG_SPEED_KMH: z.coerce.number().positive().default(20),
  NO_SHOW_GRACE_MIN: z.coerce.number().positive().default(5),
  LOCATION_STALE_MIN: z.coerce.number().nonnegative().default(15),
  LOCATION_PURGE_HOURS: z.coerce.number().nonnegative().default(12),
  TRIP_COORDINATES_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .default(TRIP_COORDINATES_RETENTION_DAYS),

  DRIVER_LOCATION_SHARE_INTERVAL_SEC: z.coerce.number().int().min(10).max(15).default(15),
  DRIVER_LOCATION_SHARE_STALE_SEC: z.coerce.number().int().min(30).max(120).default(45),
  DRIVER_LOCATION_SHARE_HIDE_SEC: z.coerce.number().int().min(120).max(600).default(300),

  DOCUMENT_STORAGE_ROOT: z.string().min(1).optional(),
  API_PUBLIC_URL: z.string().url(),
  DOCUMENT_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  DOCUMENT_SIGNED_URL_TTL_SEC: z.coerce.number().int().positive().default(600),
  DOCUMENT_STAGING_TTL_HOURS: z.coerce.number().int().positive().default(24),
  DOCUMENT_STORAGE_MIN_FREE_BYTES: z.coerce.number().int().positive().optional(),

  SENDGRID_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().email().optional(),
  EMAIL_FROM_NAME: z.string().min(1).default('VoyYa'),

  AFFILIATION_TOKEN_SECRET: z
    .string()
    .min(32, 'AFFILIATION_TOKEN_SECRET debe tener ≥32 caracteres aleatorios'),
  AFFILIATION_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
  AFFILIATION_PORTAL_URL: z.string().url(),

  EXPO_ACCESS_TOKEN: z.string().min(1).optional(),
  PUSH_SEND_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  PUSH_TOKEN_TTL_DAYS: z.coerce.number().int().nonnegative().default(PUSH_TOKEN_TTL_DAYS_MAX),
  PASSENGER_PUSH_TTL_SEC: z.coerce.number().int().positive().default(300),
  PASSENGER_PUSH_MAX_PER_TRIP: z.coerce.number().int().positive().default(10),

  RAILWAY_GIT_COMMIT_SHA: z.string().optional(),

  PG_TEST_URL: z.string().min(1).optional(),
});

const PROVIDER_REQUIREMENTS = [
  { selector: 'SMS_PROVIDER', real: 'twilio', required: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'] },
  { selector: 'EMAIL_PROVIDER', real: 'sendgrid', required: ['SENDGRID_API_KEY', 'EMAIL_FROM'] },
  { selector: 'PUSH_PROVIDER', real: 'expo', required: ['EXPO_ACCESS_TOKEN'] },
] as const;

export const EnvSchema = BaseEnvSchema.superRefine((env, ctx) => {
  const isProduction = env.NODE_ENV === 'production';

  for (const { selector, real, required } of PROVIDER_REQUIREMENTS) {
    if (isProduction && env[selector] !== real) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [selector],
        message: `${selector} debe ser "${real}" en producción (el stub está prohibido)`,
      });
    }
    if (env[selector] === real) {
      for (const key of required.filter((k) => !env[k])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} es obligatoria con ${selector}=${real}`,
        });
      }
    }
  }

  if (env.DRIVER_LOCATION_SHARE_STALE_SEC < 3 * env.DRIVER_LOCATION_SHARE_INTERVAL_SEC) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DRIVER_LOCATION_SHARE_STALE_SEC'],
      message: 'DRIVER_LOCATION_SHARE_STALE_SEC debe ser al menos 3 veces DRIVER_LOCATION_SHARE_INTERVAL_SEC',
    });
  }
  if (env.DRIVER_LOCATION_SHARE_HIDE_SEC < 2 * env.DRIVER_LOCATION_SHARE_STALE_SEC) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DRIVER_LOCATION_SHARE_HIDE_SEC'],
      message: 'DRIVER_LOCATION_SHARE_HIDE_SEC debe ser al menos 2 veces DRIVER_LOCATION_SHARE_STALE_SEC',
    });
  }

  if (isProduction) {
    for (const { key, max, reason } of OTP_PRODUCTION_BOUNDS) {
      if (env[key] > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} debe ser como máximo ${max} en producción (${reason})`,
        });
      }
    }
    const maxPurgeHours = DRIVER_LOCATION_RETENTION_MAX_HOURS - 1;
    if (env.LOCATION_PURGE_HOURS < 1 || env.LOCATION_PURGE_HOURS > maxPurgeHours) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOCATION_PURGE_HOURS'],
        message: `LOCATION_PURGE_HOURS debe estar entre 1 y ${maxPurgeHours} en producción (el aviso promete borrar a más tardar ${DRIVER_LOCATION_RETENTION_MAX_HOURS} horas)`,
      });
    }
    if (env.TRIP_COORDINATES_RETENTION_DAYS !== TRIP_COORDINATES_RETENTION_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRIP_COORDINATES_RETENTION_DAYS'],
        message: `TRIP_COORDINATES_RETENTION_DAYS debe ser ${TRIP_COORDINATES_RETENTION_DAYS} en producción (el aviso promete ese plazo)`,
      });
    }
    if (env.PUSH_TOKEN_TTL_DAYS < 1 || env.PUSH_TOKEN_TTL_DAYS > PUSH_TOKEN_TTL_DAYS_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUSH_TOKEN_TTL_DAYS'],
        message: `PUSH_TOKEN_TTL_DAYS debe estar entre 1 y ${PUSH_TOKEN_TTL_DAYS_MAX} en producción (0 apaga la purga del token de notificaciones)`,
      });
    }
    const origins = parseCorsOrigins(env.CORS_ORIGINS);
    if (origins.length === 0 || !origins.every(isHttpsOrigin)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message:
          'CORS_ORIGINS debe ser una lista separada por comas de orígenes https sin ruta ni barra final (p.ej. https://admin.voyya.co)',
      });
    }
  }
});

export type Env = z.infer<typeof EnvSchema>;
