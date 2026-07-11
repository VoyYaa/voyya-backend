import { z } from 'zod';

/**
 * Esquema de entorno (Zod). Fuente única de la config del proceso.
 * `z.coerce.number` convierte las cadenas de `process.env` a número.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // Base de datos
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),
  DIRECT_URL: z.string().min(1).optional(),

  // Tokens / secretos. A-03: ≥32 caracteres ALEATORIOS (HS256 requiere ≥256 bits).
  // Generar con: openssl rand -base64 48
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener ≥32 caracteres aleatorios (HS256)'),
  QUOTE_TOKEN_SECRET: z
    .string()
    .min(32, 'QUOTE_TOKEN_SECRET debe tener ≥32 caracteres aleatorios'),
  QUOTE_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(120),

  // Autenticación — JWT (ADR-005). Access SIN ESTADO y corto; refresh opaco/revocable.
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900), // 15 min
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30), // rango 7–30 d
  // Coste bcrypt para PIN, contraseña y OTP (un solo hasher — DRY).
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  // Autenticación — OTP del pasajero (rate-limit por teléfono; el IP lo cubre throttler).
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(4), // D-A02: 4 dígitos
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300), // 5 min
  OTP_MAX_INTENTOS: z.coerce.number().int().positive().default(5), // verificaciones/código
  OTP_REENVIO_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(30),
  OTP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5), // códigos por ventana
  OTP_RATE_LIMIT_VENTANA_SECONDS: z.coerce.number().int().positive().default(3600), // 1 h

  // Autenticación — bloqueo temporal del conductor por PIN fallido (HU-AUTH-02).
  LOGIN_MAX_INTENTOS: z.coerce.number().int().positive().default(5),
  LOGIN_BLOQUEO_MINUTOS: z.coerce.number().int().positive().default(15),

  // Gate de cabeceras de desarrollo (x-cliente-id/x-conductor-id/x-empresa-id).
  // El AuthGuard SOLO las acepta si esto es true Y NODE_ENV !== 'production'
  // (en producción se ignora siempre — ver ADR-005 §gate de headers de dev).
  AUTH_DEV_HEADERS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // SMS real — Twilio (Fase 0). OPCIONALES: si están las 3, la factory usa Twilio;
  // si faltan, Noop en dev y fail-fast en producción. Secretos SOLO por entorno.
  TWILIO_ACCOUNT_SID: z
    .string()
    .regex(/^AC[a-zA-Z0-9]+$/, 'TWILIO_ACCOUNT_SID inválido (debe empezar con "AC")')
    .optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_FROM_NUMBER: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, 'TWILIO_FROM_NUMBER debe ser E.164 (p.ej. +573001112233)')
    .optional(),

  // Endurecimiento HTTP (C-4)
  /// Allowlist de orígenes CORS separada por comas (p.ej. la PWA admin). Vacío = sin CORS.
  CORS_ORIGINS: z.string().default(''),
  THROTTLE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(100),

  // Contexto MVP
  DEFAULT_MUNICIPIO_ID: z.coerce.number().int().positive().default(1),

  // Fallback de parámetros del motor (la fuente autoritativa es parametros_sistema)
  RADIO_BUSQUEDA_KM: z.coerce.number().positive().default(2),
  RADIO_EXPANSION_KM: z.coerce.number().positive().default(6),
  TIMEOUT_ACEPTACION_SEG: z.coerce.number().int().positive().default(15),
  MAX_REINTENTOS_AUTOMATICOS: z.coerce.number().int().positive().default(3),
  VENTANA_DESEMPATE_VIAJES_HORAS: z.coerce.number().positive().default(3),
  VENTANA_CANCELACION_MIN: z.coerce.number().positive().default(2),
  VELOCIDAD_PROMEDIO_KMH: z.coerce.number().positive().default(20),

  // Tests (opcional): Postgres real para el e2e de concurrencia.
  PG_TEST_URL: z.string().min(1).optional(),
});

export type Env = z.infer<typeof EnvSchema>;
