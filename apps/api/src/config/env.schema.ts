import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

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

  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(4),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(30),
  OTP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  OTP_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),

  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_BLOCK_MINUTES: z.coerce.number().int().positive().default(15),
  DRIVER_PIN_LENGTH: z.coerce.number().int().min(4).max(6).default(6),

  AUTH_DEV_HEADERS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

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

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default('voyya-documents'),
  DOCUMENT_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  DOCUMENT_SIGNED_URL_TTL_SEC: z.coerce.number().int().positive().default(600),
  DOCUMENT_STAGING_TTL_HOURS: z.coerce.number().int().positive().default(24),

  SENDGRID_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().email().optional(),
  EMAIL_FROM_NAME: z.string().min(1).default('VoyYa'),

  AFFILIATION_TOKEN_SECRET: z
    .string()
    .min(32, 'AFFILIATION_TOKEN_SECRET debe tener ≥32 caracteres aleatorios'),
  AFFILIATION_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
  AFFILIATION_PORTAL_URL: z.string().url(),

  PG_TEST_URL: z.string().min(1).optional(),
});

export type Env = z.infer<typeof EnvSchema>;
